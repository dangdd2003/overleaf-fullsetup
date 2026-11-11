// overleaf/services/web/modules/template-gallery/app/src/storage/DedupCollector.mjs
//
// Duplicate templates and the volume they waste. One run does, in order:
//  1. Volume audit and cleanup (VolumeAudit.mjs): stray files, probe markers,
//     empty prefix dirs, old scratch leftovers, budgeted blob re-hash (quarantine on
//     mismatch), and catalog generations beyond current + 1 previous (under the snapshot lease).
//  2. Fingerprints: the normalized PDF hash of each item's PDF, computed once per
//     pdfSha and cached on the item as dedup.{pdfSha, pdfNormSha, status, checkedAt}.
//     Budgeted and resumable (cursor on token).
//  3. Plan: duplicate groups over published, not removed items (DuplicatePlanner.mjs).
//  4. Apply (not in dry run): each duplicate becomes a tombstone (duplicateOf,
//     duplicateAt). The canonical item gets the duplicate tokens and the missing tags.
//     Blob refs the canonical does not share are unset, so the regular GC sweeps the files
//     after blobGraceMs. The item doc is kept, so the catalogue sync cannot resurrect it.
//  5. Snapshot export, so the volume catalogue records the tombstones.
//  6. Purge (optional): every sha unset by a clean run is queued (pendingPurge), and a
//     purge run deletes all queued shas now. Each one is re-checked against the live items
//     and every retained snapshot generation right before it is unlinked, and must be older than an hour.
//
// Dry run changes no item and no file. It may only cache fingerprints.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { configCol, itemsCol, listingsCol } from '../persistence/Collections.mjs'
import Lock from '../jobs/Lock.mjs'
import { DEFAULTS } from '../TemplateGalleryDefaults.mjs'
import { isValidToken } from '../util/GalleryUrls.mjs'
import { BLOB_REF_FIELDS, BLOB_REF_PROJECTION, HAS_BLOB_REF_FILTER, blobRefsOf } from './BlobRefs.mjs'
import { blobPath, isValidSha256 } from './Paths.mjs'
import * as CatalogSnapshot from './CatalogSnapshot.mjs'
import { auditVolume, cleanVolume } from './VolumeAudit.mjs'
import { pdfNormSha, planDedup } from './DuplicatePlanner.mjs'
import { logInfo, logWarn } from '../observability/Log.mjs'

export const REPORT_ID = 'dedup'
export const FINGERPRINT_MAX_BYTES = 32 * 1024 * 1024
export const FINGERPRINT_BATCH = 50
export const PURGE_MIN_AGE_MS = 60 * 60_000
export const PURGE_MAX_PER_RUN = 5000
export const PENDING_PURGE_MAX = 50_000
const DEFAULT_BUDGET_MS = 5 * 60_000
const DEFAULT_YIELD_MS = 10
const LEASE_MS = 5 * 60_000
const KEEP_GENERATIONS = 2
const FEATURED_IDS = ['featured:templates', 'featured:gallery']

const PLAN_PROJECTION = Object.freeze({
  _id: 1,
  token: 1,
  title: 1,
  state: 1,
  featured: 1,
  sourceAcquired: 1,
  tags: 1,
  stats: 1,
  createdAt: 1,
  media: 1,
  dedup: 1,
  duplicateOf: 1,
  sourceBlobStoreKey: 1,
  sourcePackageHash: 1,
  pdfBlobStoreKey: 1,
  zip: 1,
  'mirror.removedAt': 1,
})

// Test seams. Production uses the real lock, snapshot export and snapshot refs.
const defaultDeps = () => ({
  lock: Lock,
  exportSnapshot: async reason => {
    const mod = await import('./CatalogSync.mjs')
    return mod.exportNow(reason)
  },
  // Every retained generation: the previous one is the rollback copy, so its blobs stay
  snapshotRefs: storageDir => CatalogSnapshot.snapshotBlobRefs(storageDir),
})
let deps = defaultDeps()

/** @param {Partial<ReturnType<typeof defaultDeps>> | null} overrides */
export function setDependenciesForTests(overrides) {
  deps = overrides ? { ...defaultDeps(), ...overrides } : defaultDeps()
}

const sleep = ms => (ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve())

async function readState() {
  const col = await configCol()
  return (await col.findOne({ _id: REPORT_ID })) || { _id: REPORT_ID }
}

async function writeState(fields) {
  const col = await configCol()
  await col.updateOne(
    { _id: REPORT_ID },
    { $set: { ...fields, updatedAt: new Date() } },
    { upsert: true }
  )
}

/**
 * Reads the blob of a PDF and computes its normalized hash. Bounded: a file over
 * FINGERPRINT_MAX_BYTES is not read. Returns the cache status it should be stored with.
 *
 * @returns {Promise<{ status: 'ok' | 'too_large' | 'missing' | 'io_error', normSha?: string }>}
 */
export async function fingerprintBlob(sha, storageDir) {
  let file
  try {
    file = blobPath(storageDir, sha)
  } catch {
    return { status: 'missing' }
  }
  let size
  try {
    size = (await fs.promises.stat(file)).size
  } catch (err) {
    return { status: err.code === 'ENOENT' ? 'missing' : 'io_error' }
  }
  if (size > FINGERPRINT_MAX_BYTES) return { status: 'too_large' }
  try {
    const buffer = await fs.promises.readFile(file)
    return { status: 'ok', normSha: pdfNormSha(buffer) }
  } catch {
    return { status: 'io_error' }
  }
}

/**
 * Fingerprints PDFs that have no fresh cached value. Stops at the time budget
 * and returns the cursor to resume from; `complete` when the whole collection was seen.
 */
async function fingerprintPass({ storageDir, dryRun, budgetMs, yieldMs, cursor }) {
  const col = await itemsCol()
  const deadline = Date.now() + budgetMs
  const stats = { scanned: 0, computed: 0, cached: 0, tooLarge: 0, missing: 0, failed: 0 }
  let last = cursor || null
  let complete = false
  for (;;) {
    if (Date.now() >= deadline) break
    const filter = {
      state: 'published',
      duplicateOf: null,
      'media.pdfSha': { $type: 'string' },
    }
    if (last) filter.token = { $gt: last }
    const batch = await col
      .find(filter, { projection: { token: 1, 'media.pdfSha': 1, dedup: 1 } })
      .sort({ token: 1 })
      .limit(FINGERPRINT_BATCH)
      .toArray()
    if (batch.length === 0) {
      complete = true
      last = null
      break
    }
    for (const item of batch) {
      last = item.token
      stats.scanned++
      const pdfSha = item.media.pdfSha
      if (item.dedup?.pdfSha === pdfSha && item.dedup?.status) {
        stats.cached++
        continue
      }
      const result = await fingerprintBlob(pdfSha, storageDir)
      if (result.status === 'io_error') {
        // Not cached: the next run tries again
        stats.failed++
        continue
      }
      if (result.status === 'ok') stats.computed++
      else if (result.status === 'too_large') stats.tooLarge++
      else stats.missing++
      await col.updateOne(
        { token: item.token, 'media.pdfSha': pdfSha },
        {
          $set: {
            'dedup.pdfSha': pdfSha,
            'dedup.pdfNormSha': result.normSha ?? null,
            'dedup.status': result.status,
            'dedup.checkedAt': new Date(),
          },
        }
      )
      await sleep(yieldMs)
    }
    if (batch.length < FINGERPRINT_BATCH) {
      complete = true
      last = null
      break
    }
  }
  return { ...stats, cursor: last, complete }
}

async function loadCandidates() {
  const col = await itemsCol()
  return col
    .find(
      {
        state: 'published',
        duplicateOf: null,
        'mirror.removedAt': null,
        token: { $type: 'string' },
      },
      { projection: PLAN_PROJECTION }
    )
    .toArray()
}

async function featuredTokenSet() {
  const col = await listingsCol()
  const tokens = new Set()
  for (const id of FEATURED_IDS) {
    const slot = await col.findOne({ _id: id })
    for (const token of Array.isArray(slot?.tokens) ? slot.tokens : []) {
      if (isValidToken(token)) tokens.add(token)
    }
  }
  return tokens
}

/**
 * Writes the tombstones and the canonical's merge. Every write is guarded by the
 * state it was planned from, so a concurrent change to an item skips that item.
 */
async function applyPlan(plan, now, yieldMs) {
  const col = await itemsCol()
  const out = { tombstoned: 0, groupsSkipped: 0, blobRefsUnset: 0, tagsMerged: 0, unsetShas: new Set(), tombstonedTokens: [] }
  for (const group of plan.groups) {
    const canonicalUpdate = { $addToSet: { 'dedup.duplicates': { $each: group.duplicates } } }
    if (group.tagsToAdd.length > 0) {
      canonicalUpdate.$addToSet.tags = { $each: group.tagsToAdd }
    }
    const canonicalRes = await col.updateOne(
      { token: group.canonical, state: 'published', duplicateOf: null, 'mirror.removedAt': null },
      canonicalUpdate
    )
    if (!canonicalRes || canonicalRes.matchedCount === 0) {
      out.groupsSkipped++
      continue
    }
    out.tagsMerged += group.tagsToAdd.length
    for (const tombstone of group.tombstones) {
      const update = { $set: { duplicateOf: group.canonical, duplicateAt: now } }
      if (Object.keys(tombstone.unset).length > 0) update.$unset = tombstone.unset
      const res = await col.updateOne(
        { token: tombstone.token, duplicateOf: null, state: 'published', 'mirror.removedAt': null },
        update
      )
      if (res && res.matchedCount > 0) {
        out.tombstoned++
        out.tombstonedTokens.push(tombstone.token)
        out.blobRefsUnset += tombstone.dropShas.length
        for (const sha of tombstone.dropShas) out.unsetShas.add(sha)
      }
      await sleep(yieldMs)
    }
  }
  return { ...out, unsetShas: [...out.unsetShas] }
}

// Every sha referenced by an item, read in one pass over the items
async function referencedShas(col, excludedTokens) {
  const referenced = new Set()
  const cursor = col.find(HAS_BLOB_REF_FILTER, { projection: { token: 1, ...BLOB_REF_PROJECTION } })
  for await (const doc of cursor) {
    if (excludedTokens.has(doc.token)) continue
    for (const ref of blobRefsOf(doc)) referenced.add(ref.sha)
  }
  return referenced
}

/**
 * Bytes that GC or a purge can reclaim for these shas: not referenced by any item
 * (other than the excluded tombstones) and not referenced by any retained snapshot generation.
 * Returns null when the snapshot cannot be read (then nothing is counted).
 */
async function estimateReclaimable(storageDir, shas, excludedTokens) {
  if (shas.length === 0) return { files: 0, bytes: 0 }
  let snapshotRefs
  try {
    snapshotRefs = await deps.snapshotRefs(storageDir)
  } catch {
    return null
  }
  const col = await itemsCol()
  const referenced = await referencedShas(col, excludedTokens)
  const out = { files: 0, bytes: 0 }
  for (const sha of new Set(shas)) {
    if (referenced.has(sha) || snapshotRefs.has(sha)) continue
    try {
      out.bytes += (await fs.promises.stat(blobPath(storageDir, sha))).size
      out.files++
    } catch {
      // already gone
    }
  }
  return out
}

/**
 * Removes the blob files of purge candidates that nothing still uses. Checks
 * the items and the current snapshot right before each unlink. A blob younger
 * than PURGE_MIN_AGE_MS, or still used, stays pending.
 */
async function purgeBlobs({ storageDir, shas, now, yieldMs }) {
  const out = { candidates: shas.length, deleted: 0, bytes: 0, stillReferenced: 0, keptForSnapshot: 0, tooYoung: 0, pending: [], skipped: null }
  let snapshotRefs
  try {
    snapshotRefs = await deps.snapshotRefs(storageDir)
  } catch (err) {
    logWarn('dedup_purge_snapshot_unavailable', { error: err?.message })
    out.skipped = 'snapshot_unavailable'
    out.pending = shas.slice(0, PENDING_PURGE_MAX)
    return out
  }
  const col = await itemsCol()
  const work = shas.filter(isValidSha256)
  const batch = work.slice(0, PURGE_MAX_PER_RUN)
  out.pending = work.slice(PURGE_MAX_PER_RUN)
  // One pass for the first check: the blob fields have no index, so a query per sha scans the items
  const referenced = batch.length > 0 ? await referencedShas(col, new Set()) : new Set()
  // Live query, used for the re-check right before each unlink
  const inUse = sha =>
    col.findOne(
      { $or: BLOB_REF_FIELDS.map(ref => ({ [ref.path]: sha })) },
      { projection: { _id: 1 } }
    )
  for (const sha of batch) {
    if (referenced.has(sha)) {
      out.stillReferenced++
      continue
    }
    if (snapshotRefs.has(sha)) {
      out.keptForSnapshot++
      out.pending.push(sha)
      continue
    }
    const file = blobPath(storageDir, sha)
    let stat
    try {
      stat = await fs.promises.stat(file)
    } catch {
      continue
    }
    if (now - stat.mtimeMs < PURGE_MIN_AGE_MS) {
      out.tooYoung++
      out.pending.push(sha)
      continue
    }
    // Re-check right before the unlink: the item or the blob may have changed since
    if (await inUse(sha)) {
      out.stillReferenced++
      continue
    }
    try {
      const fresh = await fs.promises.stat(file)
      if (Date.now() - fresh.mtimeMs < PURGE_MIN_AGE_MS) {
        out.tooYoung++
        out.pending.push(sha)
        continue
      }
      await fs.promises.unlink(file)
      out.deleted++
      out.bytes += fresh.size
    } catch (err) {
      if (err.code !== 'ENOENT') out.pending.push(sha)
    }
    await sleep(yieldMs)
  }
  out.pending = [...new Set(out.pending)].slice(0, PENDING_PURGE_MAX)
  return out
}

/**
 * Prunes catalog generations under the snapshot lease, so no export writes one at the same time.
 */
async function pruneGenerationsLeased(storageDir) {
  const owner = `dedup-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  const acquired = await deps.lock.acquire('snapshot', owner, Date.now(), LEASE_MS).catch(() => false)
  if (!acquired) return { skipped: 'snapshot_lease_held', removed: [] }
  try {
    const res = await CatalogSnapshot.pruneGenerationsNow(storageDir)
    return { skipped: null, removed: res.removed }
  } finally {
    await deps.lock.release('snapshot', owner).catch(() => {})
  }
}

function summarizeFreed(volume, purged) {
  const freed = volume.freed
  const byCategory = {
    probes: freed.probes,
    strays: freed.strays,
    emptyDirs: freed.emptyDirs,
    tmp: freed.tmp,
    scratch: freed.scratch,
  }
  const files = Object.values(byCategory).reduce((n, b) => n + b.files, 0)
  const bytes = Object.values(byCategory).reduce((n, b) => n + b.bytes, 0)
  return {
    files: files + (purged?.deleted || 0),
    bytes: bytes + (purged?.bytes || 0),
    byCategory: { ...byCategory, blobPurge: { files: purged?.deleted || 0, bytes: purged?.bytes || 0 } },
  }
}

/**
 * One dedup run. See the file header for the phases.
 *
 * @param {object} [opts]
 * @param {string} [opts.storageDir]
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.purge] delete the blobs this run unset (ignored in dry run)
 * @param {number} [opts.budgetMs] time budget for the fingerprint pass
 * @param {number} [opts.yieldMs] pause between items (low IO priority)
 * @param {number} [opts.now]
 * @param {number} [opts.verifyBudgetBytes]
 * @returns {Promise<object>} the report, also stored in configCol _id: 'dedup'
 */
export async function runDedup(opts = {}) {
  const storageDir = opts.storageDir || DEFAULTS.storageDir
  const dryRun = opts.dryRun === true
  const purge = opts.purge === true && !dryRun
  const budgetMs = opts.budgetMs || DEFAULT_BUDGET_MS
  const yieldMs = opts.yieldMs ?? DEFAULT_YIELD_MS
  const now = opts.now ?? Date.now()
  const startedAt = new Date(now)
  const report = { dryRun, purge, startedAt, finishedAt: null, skipped: null }

  const items = await itemsCol()
  const anyItem = await items.findOne({}, { projection: { _id: 1 } })
  if (!anyItem) {
    // An empty Mongo may be mid-restore: delete nothing, not even cached
    report.skipped = 'items_empty'
    return finish(report)
  }

  const state = await readState()

  // 1. Volume
  const before = await auditVolume(storageDir)
  const volume = await cleanVolume(storageDir, {
    now,
    dryRun,
    yieldMs,
    verifyBudgetBytes: opts.verifyBudgetBytes,
    verifyCursor: state.verifyCursor ?? null,
  })
  let generations
  if (dryRun) {
    generations = {
      skipped: 'dry_run',
      prunable: before.generations.slice(KEEP_GENERATIONS),
    }
  } else {
    generations = await pruneGenerationsLeased(storageDir)
  }
  report.volume = {
    before: before.areas,
    beforeTotal: before.total,
    freed: volume.freed,
    freedTotal: volume.total,
    verify: volume.verify,
    generations,
  }

  // 2. Fingerprints
  const fingerprints = await fingerprintPass({
    storageDir,
    dryRun,
    budgetMs,
    yieldMs,
    cursor: state.fingerprintCursor ?? null,
  })
  report.fingerprints = fingerprints

  // 3. Plan
  const candidates = await loadCandidates()
  const featuredTokens = await featuredTokenSet()
  const plan = planDedup(candidates, { featuredTokens })
  const reasons = {}
  for (const group of plan.groups) {
    for (const reason of group.reasons) reasons[reason] = (reasons[reason] || 0) + 1
  }
  report.duplicates = {
    candidates: candidates.length,
    groups: plan.groups.length,
    duplicates: plan.duplicateTokens,
    reasons,
    planned: plan.tombstones,
    applied: 0,
    groupsSkipped: 0,
    blobRefsUnset: 0,
    tagsMerged: 0,
    sample: plan.groups.slice(0, 20).map(group => ({
      canonical: group.canonical,
      duplicates: group.duplicates,
      reasons: group.reasons,
    })),
  }

  // 4. Apply
  let unsetShas = []
  let applied = null
  if (!dryRun && plan.groups.length > 0) {
    applied = await applyPlan(plan, new Date(now), yieldMs)
    unsetShas = applied.unsetShas
    report.duplicates.applied = applied.tombstoned
    report.duplicates.groupsSkipped = applied.groupsSkipped
    report.duplicates.blobRefsUnset = applied.blobRefsUnset
    report.duplicates.tagsMerged = applied.tagsMerged
  }

  // 5. Snapshot, so the volume catalogue records the tombstones
  if (applied && applied.tombstoned > 0) {
    try {
      const manifest = await deps.exportSnapshot('dedup')
      report.exported = { ok: Boolean(manifest), generation: manifest?.generation ?? null }
    } catch (err) {
      report.exported = { ok: false, error: err?.message || String(err) }
    }
  }

  // Reclaimable: the shas whose blobs GC (or a purge) can free once the plan is in place
  const plannedTokens = new Set(
    dryRun ? plan.groups.flatMap(group => group.tombstones.map(t => t.token)) : []
  )
  const dropShas = dryRun
    ? plan.groups.flatMap(group => group.tombstones.flatMap(t => t.dropShas))
    : unsetShas
  report.reclaimable = await estimateReclaimable(storageDir, dropShas, plannedTokens)

  // 6. Purge. Every clean run queues the shas it unset, so a later purge run deletes them.
  let purged = null
  let pendingPurge = [...new Set([...(state.pendingPurge || []), ...unsetShas])].slice(0, PENDING_PURGE_MAX)
  if (purge) {
    purged = await purgeBlobs({
      storageDir,
      shas: pendingPurge,
      now: Date.now(),
      yieldMs,
    })
    pendingPurge = purged.pending
    report.purged = {
      candidates: purged.candidates,
      deleted: purged.deleted,
      bytes: purged.bytes,
      stillReferenced: purged.stillReferenced,
      keptForSnapshot: purged.keptForSnapshot,
      tooYoung: purged.tooYoung,
      pending: purged.pending.length,
      skipped: purged.skipped,
    }
  } else {
    report.purged = { candidates: 0, deleted: 0, bytes: 0, pending: pendingPurge.length, skipped: dryRun ? 'dry_run' : 'purge_off' }
  }
  report.freed = summarizeFreed(volume, purged)

  // Progress cursors. Dry run saves only the fingerprint cursor (cache progress).
  const cursors = { fingerprintCursor: fingerprints.cursor }
  if (!dryRun) Object.assign(cursors, { verifyCursor: volume.verify.cursor, pendingPurge })
  await writeState(cursors)
  return finish(report)
}

async function finish(report) {
  report.finishedAt = new Date()
  await writeState({ report, lastRunAt: report.finishedAt, lastRunSkipped: report.skipped })
  logInfo('dedup_run_finished', {
    dryRun: report.dryRun,
    purge: report.purge,
    skipped: report.skipped,
    applied: report.duplicates?.applied ?? 0,
    groups: report.duplicates?.groups ?? 0,
  })
  return report
}

/**
 * Brings a tombstoned duplicate back. The item keeps dedup.keep so the next run leaves it
 * alone, and the sync refetches the blobs it lost.
 *
 * @param {string} token
 * @returns {Promise<{ restored: boolean, reason?: string, canonical?: string }>}
 */
export async function restoreDuplicate(token) {
  if (!isValidToken(token)) return { restored: false, reason: 'invalid_token' }
  const col = await itemsCol()
  const item = await col.findOne(
    { token, duplicateOf: { $ne: null } },
    { projection: { token: 1, duplicateOf: 1 } }
  )
  if (!item) return { restored: false, reason: 'not_a_duplicate' }
  await col.updateOne(
    { token, duplicateOf: item.duplicateOf },
    {
      $unset: { duplicateOf: '', duplicateAt: '' },
      $set: { 'dedup.keep': true, 'dedup.restoredAt': new Date() },
    }
  )
  await col.updateOne(
    { token: item.duplicateOf },
    { $pull: { 'dedup.duplicates': token } }
  )
  return { restored: true, canonical: item.duplicateOf }
}

/**
 * Tombstones, newest first, for the admin page.
 */
export async function listTombstones({ limit = 50 } = {}) {
  const col = await itemsCol()
  const rows = await col
    .find(
      { duplicateOf: { $ne: null } },
      { projection: { _id: 0, token: 1, title: 1, duplicateOf: 1, duplicateAt: 1, slug: 1, family: 1 } }
    )
    .sort({ duplicateAt: -1 })
    .limit(Math.min(Math.max(Number(limit) || 50, 1), 200))
    .toArray()
  return rows
}

/**
 * The last stored run and the live counts for the admin page.
 */
export async function getStatus() {
  const state = await readState()
  const col = await itemsCol()
  const tombstones = await col.countDocuments({ duplicateOf: { $ne: null } })
  return {
    report: state.report || null,
    lastRunAt: state.lastRunAt || null,
    tombstones,
    pendingPurge: (state.pendingPurge || []).length,
    fingerprintCursor: state.fingerprintCursor ?? null,
  }
}

export default {
  runDedup,
  restoreDuplicate,
  listTombstones,
  getStatus,
  fingerprintBlob,
  setDependenciesForTests,
}
