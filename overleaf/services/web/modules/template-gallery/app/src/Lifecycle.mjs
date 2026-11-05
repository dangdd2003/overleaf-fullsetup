import Settings from '@overleaf/settings'
import { DEFAULTS } from './TemplateGalleryDefaults.mjs'
import * as Indexes from './persistence/Indexes.mjs'
import * as StorageHealth from './storage/StorageHealth.mjs'
import * as CatalogSnapshot from './storage/CatalogSnapshot.mjs'
import * as CatalogSync from './storage/CatalogSync.mjs'
import Runner from './jobs/Runner.mjs'
import Scheduler from './jobs/Scheduler.mjs'
import { logInfo, logWarn, logError } from './observability/Log.mjs'

let ready = false
let readinessState = {
  ready: false,
  indexesOk: false,
  storageOk: false,
  error: null,
  lastCheckedAt: null,
  snapshot: null,
}

/**
 * Returns whether template gallery is fully initialized and ready.
 */
export function isReady() {
  return ready
}

/**
 * Returns detailed readiness diagnostics.
 */
export function getReadinessState() {
  return { ...readinessState }
}

/**
 * Allows test suites to explicitly force the readiness state.
 */
export function setReadyForTests(bool) {
  ready = Boolean(bool)
  readinessState.ready = ready
}

/**
 * Idempotently injects the template gallery navigation link into Settings.templateLinks,
 * pointing to '/latex/templates'.
 */
export function installNavigation() {
  if (!Array.isArray(Settings.templateLinks)) {
    Settings.templateLinks = []
  }

  const linkDef = {
    name: 'view_all',
    url: '/latex/templates',
    trackingKey: 'template-gallery-view-all',
  }

  const existingIndex = Settings.templateLinks.findIndex(
    (link) =>
      link.name === linkDef.name ||
      link.url === '/templates' ||
      link.url === linkDef.url
  )

  if (existingIndex !== -1) {
    Settings.templateLinks[existingIndex] = {
      ...Settings.templateLinks[existingIndex],
      ...linkDef,
    }
  } else {
    Settings.templateLinks.push(linkDef)
  }
}

/**
 * Starts lifecycle initialization. Never throws.
 * Probes storage, ensures the store identity, restores the catalog from the volume snapshot when
 * Items is empty, ensures indexes, then installs navigation and starts runner and snapshot sync.
 */
export async function start(cfg = DEFAULTS) {
  readinessState.lastCheckedAt = new Date()
  readinessState.snapshot = null

  try {
    // 1. Storage health check. Creates the storage tree (including catalog/) in its own storage directory.
    const storageRes = await StorageHealth.probe(cfg)
    readinessState.storageOk = Boolean(storageRes?.ok)

    // 2. Store identity, then 3. restore from the volume snapshot, only when storage is usable.
    //    The restore runs before indexes so restored documents are indexed with the rest.
    //    A transient restore failure fails closed: no runner, no snapshot sync, not ready.
    let restoreFailed = false
    if (readinessState.storageOk) {
      await CatalogSnapshot.ensureStoreIdentity(cfg.storageDir)
      try {
        readinessState.snapshot = await CatalogSync.restoreIfNeeded(cfg)
      } catch (err) {
        restoreFailed = true
        readinessState.snapshot = { action: 'error', error: err.message }
        logError('lifecycle_snapshot_restore_failed', err)
      }
    }

    // An interrupted restore must remain untouched until its exact snapshot
    // can be resumed.
    if (restoreFailed) {
      ready = false
      readinessState.ready = false
      readinessState.error = 'snapshot_restore_failed'
      return readinessState
    }

    // 4. Ensure all database indexes
    const indexRes = await Indexes.ensureAll()
    readinessState.indexesOk = Boolean(indexRes?.essentialOk ?? true)

    if (
      readinessState.indexesOk &&
      readinessState.storageOk &&
      !restoreFailed
    ) {
      ready = true
      readinessState.ready = true
      readinessState.error = null

      // 5. Install navigation link idempotently
      installNavigation()

      // 6. Start background runner (which drives Scheduler), then snapshot sync
      Runner.start(cfg)
      CatalogSync.start(cfg)
      logInfo('lifecycle_started', {
        ready: true,
        snapshot: readinessState.snapshot,
      })
    } else {
      ready = false
      readinessState.ready = false
      if (!readinessState.storageOk) {
        readinessState.error = storageRes?.code || 'storage-check-failed'
      } else if (restoreFailed) {
        readinessState.error = 'snapshot_restore_failed'
      } else {
        readinessState.error = 'readiness-checks-failed'
      }
      logWarn('lifecycle_storage_or_indexes_failed', {
        readinessState,
        storageRes,
      })
    }
  } catch (err) {
    ready = false
    readinessState.ready = false
    readinessState.error = err.message
    logError('lifecycle_start_error', err)
  }

  return readinessState
}

/**
 * Stops the runner and scheduler first, so the leader lease is released before
 * a shutdown can be cut short, then snapshot sync (final export, bounded), and
 * resets lifecycle state.
 */
export async function stop() {
  await Runner.stop()
  try {
    await CatalogSync.stop()
  } catch (err) {
    logError('lifecycle_snapshot_stop_failed', err)
  }
  ready = false
  readinessState.ready = false
}

export { Scheduler, Runner, Indexes }

export default {
  isReady,
  getReadinessState,
  setReadyForTests,
  installNavigation,
  start,
  stop,
  Scheduler,
  Runner,
  Indexes,
}
