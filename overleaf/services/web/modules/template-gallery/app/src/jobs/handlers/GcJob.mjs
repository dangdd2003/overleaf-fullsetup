import fs from 'node:fs'
import path from 'node:path'
import { configCol, itemsCol } from '../../persistence/Collections.mjs'
import {
  BLOB_REF_PROJECTION,
  HAS_BLOB_REF_FILTER,
  blobRefsOf,
} from '../../storage/BlobRefs.mjs'
import { DEFAULTS } from '../../TemplateGalleryDefaults.mjs'
import { logWarn } from '../../observability/Log.mjs'

let snapshotLoader = () => import('../../storage/CatalogSnapshot.mjs')

/**
 * Test hook: replaces the lazy loader of the volume catalogue snapshot module.
 * Passing null restores the real loader.
 */
export function setSnapshotLoaderForTests(loader) {
  snapshotLoader = loader || (() => import('../../storage/CatalogSnapshot.mjs'))
}

/**
 * Blob shas referenced by the volume catalogue snapshot. Returns null when the
 * snapshot module or function is missing or throws; the caller then skips the
 * blob sweep for this run (fail safe).
 *
 * @param {string} storageDir
 * @returns {Promise<Set<string> | null>}
 */
async function loadSnapshotRefs(storageDir) {
  try {
    const mod = await snapshotLoader()
    if (typeof mod?.snapshotBlobRefs !== 'function') {
      throw new Error('snapshotBlobRefs is not available')
    }
    return await mod.snapshotBlobRefs(storageDir)
  } catch (err) {
    logWarn('gc_snapshot_refs_unavailable', { error: err?.message })
    return null
  }
}

const QUARANTINE_MAX_AGE_MS = 30 * 24 * 3600_000

/**
 * Removes quarantine/ entries older than QUARANTINE_MAX_AGE_MS. Entries are named
 * `<sha>-<quarantinedAtMs>`; the mtime is only a fallback because a moved blob keeps its old mtime.
 *
 * @returns {Promise<number>} removed entry count
 */
async function cleanQuarantine(storageDir, now) {
  const dir = path.join(storageDir, 'quarantine')
  const entries = await fs.promises
    .readdir(dir, { withFileTypes: true })
    .catch(() => [])
  let removed = 0
  for (const ent of entries) {
    if (!ent.isFile()) continue
    const fullPath = path.join(dir, ent.name)
    try {
      const match = /^[0-9a-f]{64}-(\d+)$/.exec(ent.name)
      let quarantinedAt = match ? Number(match[1]) : NaN
      if (!Number.isFinite(quarantinedAt)) {
        quarantinedAt = (await fs.promises.stat(fullPath)).mtimeMs
      }
      if (now - quarantinedAt > QUARANTINE_MAX_AGE_MS) {
        await fs.promises.unlink(fullPath)
        removed++
      }
    } catch (_e) {}
  }
  return removed
}

/**
 * Background garbage collection job.
 * Sweeps unreferenced blobs older than blobGraceMs (only when the live set is
 * trustworthy: items exist in Mongo and the volume snapshot could be read),
 * cleans old files in tmp/ and scratch/, drops quarantine/ entries older than 30 days,
 * and records usage metrics in configCol() under _id: "usage".
 *
 * @param {object} job - Job document from templateGalleryJobs
 * @param {object} ctx - Execution context
 * @returns {Promise<any>}
 */
export async function run(job, ctx = {}) {
  const cfg = ctx.cfg || DEFAULTS
  const storageDir = cfg?.storageDir || DEFAULTS.storageDir
  const blobGraceMs = cfg?.runner?.blobGraceMs || 24 * 3600_000
  const tmpMaxAgeMs = cfg?.runner?.tmpMaxAgeMs || 3600_000
  const now = Date.now()

  let tmpCleaned = 0
  let scratchCleaned = 0
  let blobsSwept = 0
  let totalBlobBytes = 0
  let totalBlobCount = 0

  // 1. Clean old files in tmp/
  const tmpDir = path.join(storageDir, 'tmp')
  try {
    const tmpEntries = await fs.promises
      .readdir(tmpDir, { withFileTypes: true })
      .catch(() => [])
    for (const ent of tmpEntries) {
      if (!ent.isFile()) continue
      const fullPath = path.join(tmpDir, ent.name)
      try {
        const stats = await fs.promises.stat(fullPath)
        if (now - stats.mtimeMs > tmpMaxAgeMs) {
          await fs.promises.unlink(fullPath)
          tmpCleaned++
        }
      } catch (_e) {}
    }
  } catch (_e) {}

  // 2. Clean old files in scratch/
  const scratchDir = path.join(storageDir, 'scratch')
  try {
    const scratchEntries = await fs.promises
      .readdir(scratchDir, { withFileTypes: true })
      .catch(() => [])
    for (const ent of scratchEntries) {
      if (!ent.isFile()) continue
      const fullPath = path.join(scratchDir, ent.name)
      try {
        const stats = await fs.promises.stat(fullPath)
        if (now - stats.mtimeMs > tmpMaxAgeMs) {
          await fs.promises.unlink(fullPath)
          scratchCleaned++
        }
      } catch (_e) {}
    }
  } catch (_e) {}

  // 2b. Drop quarantined blobs older than QUARANTINE_MAX_AGE_MS (kept for inspection first)
  const quarantineCleaned = await cleanQuarantine(storageDir, now)

  // 3. Collect every sha256 an item still references
  const colItems = await itemsCol()
  const referencedShas = new Set()
  const cursor = colItems.find(HAS_BLOB_REF_FILTER, {
    projection: BLOB_REF_PROJECTION,
  })
  for await (const doc of cursor) {
    for (const ref of blobRefsOf(doc)) referencedShas.add(ref.sha)
  }

  // The blob sweep only runs when the live set is trustworthy: an empty items
  // collection (wiped or not yet restored Mongo) would make every blob look
  // unreferenced, so the sweep is skipped, and the volume snapshot refs are
  // unioned in so blobs known only to the snapshot survive.
  let sweepSkipReason = null
  const anyItem = await colItems.findOne({}, { projection: { _id: 1 } })
  if (!anyItem) {
    sweepSkipReason = 'items_empty'
  } else {
    const snapshotRefs = await loadSnapshotRefs(storageDir)
    if (snapshotRefs) {
      for (const sha of snapshotRefs) referencedShas.add(sha)
    } else {
      sweepSkipReason = 'snapshot_unavailable'
    }
  }
  const canSweep = sweepSkipReason === null

  // 4. Sweep unreferenced blobs older than blobGraceMs in blobs/sha256/
  const blobsBaseDir = path.join(storageDir, 'blobs', 'sha256')
  try {
    const prefixDirs = await fs.promises
      .readdir(blobsBaseDir, { withFileTypes: true })
      .catch(() => [])
    for (const prefixEnt of prefixDirs) {
      if (!prefixEnt.isDirectory()) continue
      const prefixPath = path.join(blobsBaseDir, prefixEnt.name)
      const blobFiles = await fs.promises
        .readdir(prefixPath, { withFileTypes: true })
        .catch(() => [])

      for (const fileEnt of blobFiles) {
        if (!fileEnt.isFile()) continue
        const fullBlobPath = path.join(prefixPath, fileEnt.name)
        const sha = fileEnt.name

        try {
          const stats = await fs.promises.stat(fullBlobPath)
          totalBlobBytes += stats.size
          totalBlobCount++

          const isReferenced = referencedShas.has(sha)
          const ageMs = now - stats.mtimeMs

          if (canSweep && !isReferenced && ageMs > blobGraceMs) {
            // Re-stat right before unlink: a blob rewritten since the listing is young again.
            const fresh = await fs.promises.stat(fullBlobPath)
            if (Date.now() - fresh.mtimeMs > blobGraceMs) {
              await fs.promises.unlink(fullBlobPath)
              blobsSwept++
              totalBlobBytes -= stats.size
              totalBlobCount--
            }
          }
        } catch (_e) {}
      }
    }
  } catch (_e) {}

  // 5. Update _id: "usage" in configCol()
  const colCfg = await configCol()
  const usageDoc = {
    _id: 'usage',
    totalBlobBytes,
    totalBlobCount,
    referencedBlobCount: referencedShas.size,
    lastGcRunAt: new Date(),
    tmpCleaned,
    scratchCleaned,
    blobsSwept,
    blobSweepSkipped: sweepSkipReason,
    quarantineCleaned,
    updatedAt: new Date(),
  }

  await colCfg.updateOne({ _id: 'usage' }, { $set: usageDoc }, { upsert: true })

  return {
    ok: true,
    tmpCleaned,
    scratchCleaned,
    blobsSwept,
    blobSweepSkipped: sweepSkipReason,
    quarantineCleaned,
    totalBlobBytes,
    totalBlobCount,
  }
}

export default {
  run,
}
