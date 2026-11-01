// @ts-check
// overleaf/services/web/modules/template-gallery/app/src/storage/CatalogSync.mjs
//
// Boot restore and write-driven export of the volume snapshot (see CatalogSnapshot.mjs).
// - restoreIfNeeded(): empty Items + snapshot on the volume -> restore offline, no upstream traffic.
// - start(): export after writes (30s after the last write, at most 10 min behind), and every 6h while dirty.
// - Exports take the Mongo lease 'snapshot', so one process per cluster exports at a time.
// Timers are unref'd and never keep the process alive.

import crypto from 'node:crypto'
import Lock from '../jobs/Lock.mjs'
import { DEFAULTS } from '../TemplateGalleryDefaults.mjs'
import { collectionByName, onWrite } from '../persistence/Collections.mjs'
import * as CatalogSnapshot from './CatalogSnapshot.mjs'
import { logError, logInfo, logWarn } from '../observability/Log.mjs'

const LOCK_ID = 'snapshot'
const RESTORE_LOCK_ID = 'snapshot-restore'
const LEASE_MS = 5 * 60_000
const RESTORE_LEASE_MS = 10 * 60_000
const RESTORE_WAIT_MS = 120_000
const RESTORE_POLL_MS = 1_000
const LEASE_RENEW_MS = 60_000
const DEBOUNCE_MS = 30_000
const MAX_WAIT_MS = 10 * 60_000
const PERIODIC_MS = 6 * 60 * 60_000
const RETRY_MS = 5 * 60_000
const STOP_TIMEOUT_MS = 20_000
const OWNER = `snapshot-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
const RESTORE_OWNER = `${OWNER}-restore`
const TIMED_OUT = Symbol('timed_out')

let started = false
let configuredStorageDir = /** @type {string | null} */ (null)
let unsubscribe = /** @type {(() => void) | null} */ (null)
let dirty = false
let lastDirtyReason = ''
let writeSeq = 0
let backfillPending = false
let blockAutomaticExports = false
/** @type {any} */
let debounceTimer = null
/** @type {any} */
let maxWaitTimer = null
/** @type {any} */
let retryTimer = null
/** @type {any} */
let periodicTimer = null
/** @type {Promise<any> | null} */
let exporting = null
/** @type {Promise<any> | null} */
let restoring = null
// Set when stop() gives up waiting, so the export still running stops reading Mongo
let exportAborted = false
let lastExportAt = /** @type {string | null} */ (null)
let lastGeneration = /** @type {string | null} */ (null)
let lastError = /** @type {string | null} */ (null)

/** @param {unknown} err */
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err)
}

/** @returns {string} */
function currentStorageDir() {
  if (configuredStorageDir) return configuredStorageDir
  return DEFAULTS.storageDir
}

/**
 * setTimeout that never keeps the process alive.
 *
 * @param {() => void} fn
 * @param {number} ms
 * @returns {any}
 */
function unrefTimeout(fn, ms) {
  const timer = /** @type {any} */ (setTimeout(fn, ms))
  timer.unref?.()
  return timer
}

/**
 * setInterval that never keeps the process alive.
 *
 * @param {() => void} fn
 * @param {number} ms
 * @returns {any}
 */
function unrefInterval(fn, ms) {
  const timer = /** @type {any} */ (setInterval(fn, ms))
  timer.unref?.()
  return timer
}

/**
 * Arms the debounce timer (restarted by every write) and the max-wait timer (armed once per dirty period).
 */
function armExportTimers() {
  if (!started) return
  clearTimeout(debounceTimer)
  debounceTimer = unrefTimeout(() => {
    debounceTimer = null
    triggerExport('debounce')
  }, DEBOUNCE_MS)
  if (!maxWaitTimer) {
    maxWaitTimer = unrefTimeout(() => {
      maxWaitTimer = null
      triggerExport('max_wait')
    }, MAX_WAIT_MS)
  }
}

function scheduleRetry() {
  if (!started || !dirty || retryTimer) return
  retryTimer = unrefTimeout(() => {
    retryTimer = null
    triggerExport('retry')
  }, RETRY_MS)
}

/**
 * @param {string} reason
 */
function triggerExport(reason) {
  runExport(reason, false).catch((err) => {
    logWarn('snapshot_background_export_failed', {
      reason,
      error: errorMessage(err),
    })
  })
}

/**
 * Runs at most one export per process. A concurrent caller joins the export in flight.
 *
 * @param {string} reason
 * @param {boolean} force export even when nothing changed (manual export and final export on stop)
 * @returns {Promise<any>}
 */
function runExport(reason, force) {
  if (!exporting) {
    exporting = doExport(reason, force).finally(() => {
      exporting = null
    })
  }
  return exporting
}

/**
 * @param {string} reason
 * @param {boolean} force
 * @returns {Promise<SnapshotManifestOrNull>}
 */
async function doExport(reason, force) {
  if (!force && !dirty) return null
  exportAborted = false
  const isForced = force || reason === 'cli' || reason === 'manual'
  if (blockAutomaticExports && !isForced) {
    logWarn('snapshot_export_blocked_corrupt_catalog', { reason })
    return null
  }
  clearTimeout(debounceTimer)
  debounceTimer = null
  clearTimeout(maxWaitTimer)
  maxWaitTimer = null
  clearTimeout(retryTimer)
  retryTimer = null

  const writesAtStart = writeSeq
  const storageDir = currentStorageDir()

  let acquired
  try {
    acquired = await Lock.acquire(LOCK_ID, OWNER, Date.now(), LEASE_MS)
  } catch (err) {
    lastError = errorMessage(err)
    logWarn('snapshot_lease_acquire_failed', { reason, error: lastError })
    scheduleRetry()
    throw err
  }
  if (!acquired) {
    logInfo('snapshot_lease_held', { reason, owner: OWNER })
    scheduleRetry()
    return null
  }

  const renewTimer = unrefInterval(renewLease, LEASE_RENEW_MS)
  let manifest
  try {
    await CatalogSnapshot.assertRestoreComplete()
    manifest = await CatalogSnapshot.exportSnapshot({
      storageDir,
      reason,
      force,
      checkLease: () => Lock.renew(LOCK_ID, OWNER, LEASE_MS).catch(() => false),
      isAborted: () => exportAborted,
    })
    blockAutomaticExports = false
  } catch (err) {
    lastError = errorMessage(err)
    logError('snapshot_export_failed', err, { reason })
    scheduleRetry()
    throw err
  } finally {
    clearInterval(renewTimer)
    await Lock.release(LOCK_ID, OWNER).catch(() => {})
  }

  lastExportAt = new Date().toISOString()
  lastGeneration = manifest.generation
  lastError = null
  if (writeSeq === writesAtStart) {
    dirty = false
  }
  logInfo('snapshot_exported', {
    reason,
    lastDirtyReason,
    generation: manifest.generation,
    items: manifest.collections.templateGalleryItems.count,
    stillDirty: dirty,
  })
  if (dirty) {
    armExportTimers()
  }
  return manifest
}

/** @typedef {import('./CatalogSnapshot.mjs').SnapshotManifest | null} SnapshotManifestOrNull */

function renewLease() {
  Lock.renew(LOCK_ID, OWNER, LEASE_MS).then(
    (renewed) => {
      if (!renewed) logWarn('snapshot_lease_lost', { owner: OWNER })
    },
    (err) => {
      logWarn('snapshot_lease_renew_failed', { error: errorMessage(err) })
    }
  )
}

/**
 * Resolves with TIMED_OUT when the promise does not settle within ms.
 *
 * @param {Promise<any>} promise
 * @param {number} ms
 * @returns {Promise<any>}
 */
function withTimeout(promise, ms) {
  /** @type {any} */
  let timer = null
  const deadline = new Promise((resolve) => {
    timer = unrefTimeout(() => resolve(TIMED_OUT), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Boot decision for the rebuildable collections:
 * - Items empty and a snapshot exists: restore it.
 * - In-progress restore marker: resume import even if Items is non-empty.
 * - Items present and no snapshot exists: 'backfill'. start() exports right away.
 * - Anything else: 'none'.
 * Concurrency between web and web-api processes is guarded by 'snapshot-restore' lock.
 *
 * @param {{storageDir?: string}} cfg
 * @returns {Promise<{action: 'restored'|'backfill'|'none'|'waited', generation?: string, counts?: Record<string, number>, reason?: string}>}
 */
export function restoreIfNeeded(cfg) {
  if (!restoring) {
    restoring = doRestoreIfNeeded(cfg).finally(() => {
      restoring = null
    })
  }
  return restoring
}

/** @param {{storageDir?: string}} cfg */
async function doRestoreIfNeeded(cfg) {
  const storageDir = cfg?.storageDir
  const marker = await readStoreMarker()
  const isInterrupted = marker?.restoreState === 'in_progress'
  const manifest = await CatalogSnapshot.readCurrentManifest(storageDir)

  if (isInterrupted && (!manifest || marker.storeId !== manifest.storeId)) {
    throw Object.assign(
      new Error(
        'interrupted catalog restore requires the same snapshot identity'
      ),
      {
        code: 'SNAPSHOT_RESTORE_MISMATCH',
      }
    )
  }

  if (!manifest && (await CatalogSnapshot.hasSnapshotGenerations(storageDir))) {
    blockAutomaticExports = true
    logError(
      'snapshot_no_valid_generation',
      new Error('corrupt snapshot directories exist but none are valid')
    )
    return { action: 'none', reason: 'no_valid_snapshot' }
  }

  if (!isInterrupted && (await itemsExist())) {
    if (manifest) return { action: 'none' }
    backfillPending = true
    logInfo('snapshot_backfill_pending')
    return { action: 'backfill' }
  }

  if (!manifest) return { action: 'none' }

  let acquired = false
  try {
    acquired = await Lock.acquire(
      RESTORE_LOCK_ID,
      RESTORE_OWNER,
      Date.now(),
      RESTORE_LEASE_MS
    )
  } catch (err) {
    logWarn('snapshot_restore_lock_failed', { error: errorMessage(err) })
  }

  if (!acquired) {
    const maxWait = RESTORE_WAIT_MS
    const startWait = Date.now()
    while (Date.now() - startWait < maxWait) {
      await sleep(RESTORE_POLL_MS)
      const currentMarker = await readStoreMarker()
      if (currentMarker?.restoreState === 'done' && (await itemsExist())) {
        logInfo('snapshot_restore_waited_done', {
          generation: currentMarker.generation,
        })
        return { action: 'waited', generation: currentMarker.generation }
      }
      try {
        acquired = await Lock.acquire(
          RESTORE_LOCK_ID,
          RESTORE_OWNER,
          Date.now(),
          RESTORE_LEASE_MS
        )
        if (acquired) break
      } catch {}
    }
    if (!acquired) {
      logWarn('snapshot_restore_wait_timeout', { owner: OWNER })
      throw new Error('catalog snapshot restore is still in progress')
    }
  }

  let exportLockAcquired = false
  let renewal = null
  const checkLease = async () => {
    const restored = await Lock.renew(
      RESTORE_LOCK_ID,
      RESTORE_OWNER,
      RESTORE_LEASE_MS
    )
    const snapshot = await Lock.renew(LOCK_ID, RESTORE_OWNER, RESTORE_LEASE_MS)
    return restored && snapshot
  }
  try {
    // Exports and restores must not overlap: exporting even 500/501 items
    // would otherwise replace the only complete backup with a partial one.
    exportLockAcquired = await Lock.acquire(
      LOCK_ID,
      RESTORE_OWNER,
      Date.now(),
      RESTORE_LEASE_MS
    )
    if (!exportLockAcquired)
      throw new Error('catalog snapshot export is in progress')
    renewal = unrefInterval(() => {
      checkLease().catch((err) =>
        logWarn('snapshot_restore_lease_renew_failed', {
          error: errorMessage(err),
        })
      )
    }, LEASE_RENEW_MS)
    const lockedMarker = await readStoreMarker()
    if (lockedMarker?.restoreState !== 'in_progress' && (await itemsExist())) {
      return { action: 'none' }
    }
    if (
      lockedMarker?.restoreState === 'in_progress' &&
      lockedMarker.storeId !== manifest.storeId
    ) {
      throw Object.assign(
        new Error(
          'interrupted catalog restore requires the same snapshot identity'
        ),
        {
          code: 'SNAPSHOT_RESTORE_MISMATCH',
        }
      )
    }

    let restoredStoreId = manifest.storeId
    const result = await CatalogSnapshot.importSnapshot({
      storageDir,
      expectedSnapshot:
        lockedMarker?.restoreState === 'in_progress'
          ? {
              storeId: lockedMarker.storeId,
              generation: lockedMarker.generation,
            }
          : undefined,
      checkLease,
      beforeImport: async (selected) => {
        restoredStoreId = selected.storeId
        await setStoreMarker({
          storeId: selected.storeId,
          generation: selected.generation,
          restoreState: 'in_progress',
          startedAt: new Date(),
        })
      },
    })
    if (!(await checkLease()))
      throw new Error('catalog snapshot restore lease lost')
    await setStoreMarker({
      storeId: restoredStoreId,
      generation: result.generation,
      restoreState: 'done',
      restoredAt: new Date(),
    })
    logInfo('snapshot_restored', {
      generation: result.generation,
      counts: result.counts,
    })
    return {
      action: 'restored',
      generation: result.generation,
      counts: result.counts,
    }
  } catch (err) {
    if (/** @type {any} */ (err)?.code === 'SNAPSHOT_CORRUPT') {
      blockAutomaticExports = true
      logError(
        'snapshot_no_valid_generation',
        err instanceof Error ? err : new Error(String(err))
      )
      if ((await readStoreMarker())?.restoreState === 'in_progress') throw err
      return { action: 'none', reason: 'no_valid_snapshot' }
    }
    throw err
  } finally {
    clearInterval(renewal)
    if (exportLockAcquired) {
      await Lock.release(LOCK_ID, RESTORE_OWNER).catch(() => {})
    }
    if (acquired) {
      await Lock.release(RESTORE_LOCK_ID, RESTORE_OWNER).catch(() => {})
    }
  }
}

/** @returns {Promise<boolean>} */
async function itemsExist() {
  const col = await collectionByName('templateGalleryItems')
  const doc = await col.findOne({}, { projection: { _id: 1 } })
  return doc != null
}

async function readStoreMarker() {
  const col = await collectionByName('templateGalleryConfig')
  return await col.findOne({ _id: 'store' })
}

/** @param {object} fields */
async function setStoreMarker(fields) {
  const col = await collectionByName('templateGalleryConfig')
  await col.updateOne({ _id: 'store' }, { $set: fields }, { upsert: true })
}

/**
 * Notes a write. Schedules an export 30s after the last write, and no later than 10 min after the first.
 *
 * @param {string} [reason]
 */
export function markDirty(reason = 'write') {
  writeSeq++
  dirty = true
  lastDirtyReason = reason
  armExportTimers()
}

/**
 * Starts write tracking and the export schedule. Idempotent.
 *
 * @param {{storageDir?: string}} [cfg]
 */
export function start(cfg) {
  if (started) return
  started = true
  configuredStorageDir = cfg?.storageDir || null
  unsubscribe = onWrite((collectionName, method) => {
    markDirty(`${collectionName}.${method}`)
  })
  periodicTimer = unrefInterval(() => {
    if (dirty) triggerExport('periodic')
  }, PERIODIC_MS)
  if (backfillPending) {
    backfillPending = false
    dirty = true
    triggerExport('backfill')
  }
  logInfo('snapshot_sync_started', { storageDir: currentStorageDir() })
}

/**
 * Final export when dirty (bounded to 20s), then unsubscribe and clear timers. Never throws.
 */
export async function stop() {
  started = false
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
  clearTimeout(debounceTimer)
  debounceTimer = null
  clearTimeout(maxWaitTimer)
  maxWaitTimer = null
  clearTimeout(retryTimer)
  retryTimer = null
  clearInterval(periodicTimer)
  periodicTimer = null
  try {
    const outcome = await withTimeout(runExport('stop', false), STOP_TIMEOUT_MS)
    if (outcome === TIMED_OUT) {
      exportAborted = true
      logWarn('snapshot_stop_timed_out', { dirty })
    }
  } catch (err) {
    logError('snapshot_final_export_failed', err)
  }
}

/**
 * Writes a new generation now, under the snapshot lease (used by the CLI).
 * Returns null when another process holds the lease. Throws when the export fails.
 *
 * @param {string} [reason]
 * @returns {Promise<SnapshotManifestOrNull>}
 */
export async function exportNow(reason = 'manual') {
  return runExport(reason, true)
}

/**
 * @returns {{dirty: boolean, lastExportAt: string | null, lastGeneration: string | null, lastError: string | null, exporting: boolean}}
 */
export function getStatus() {
  return {
    dirty,
    lastExportAt,
    lastGeneration,
    lastError,
    exporting: exporting !== null,
  }
}

/**
 * Clears all module state and timers. For unit tests only.
 */
export function resetForTests() {
  started = false
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
  clearTimeout(debounceTimer)
  clearTimeout(maxWaitTimer)
  clearTimeout(retryTimer)
  clearInterval(periodicTimer)
  debounceTimer = null
  maxWaitTimer = null
  retryTimer = null
  periodicTimer = null
  dirty = false
  lastDirtyReason = ''
  writeSeq = 0
  backfillPending = false
  blockAutomaticExports = false
  exporting = null
  restoring = null
  configuredStorageDir = null
  lastExportAt = null
  lastGeneration = null
  lastError = null
}

export default {
  restoreIfNeeded,
  start,
  stop,
  markDirty,
  exportNow,
  getStatus,
  resetForTests,
}
