import fs from 'node:fs'
import path from 'node:path'
import { configCol, itemsCol } from '../../persistence/Collections.mjs'
import {
  BLOB_REF_PROJECTION,
  HAS_BLOB_REF_FILTER,
  blobRefsOf,
} from '../../storage/BlobRefs.mjs'
import Settings from '@overleaf/settings'
import { DEFAULTS } from '../../TemplateGalleryDefaults.mjs'

/**
 * Background garbage collection job.
 * Sweeps unreferenced blobs older than blobGraceMs,
 * cleans old files in tmp/ and scratch/,
 * and records usage metrics in configCol() under _id: "usage".
 *
 * @param {object} job - Job document from templateGalleryJobs
 * @param {object} ctx - Execution context
 * @returns {Promise<any>}
 */
export async function run(job, ctx = {}) {
  const cfg = ctx.cfg || Settings.templateGallery || DEFAULTS
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
    const tmpEntries = await fs.promises.readdir(tmpDir, { withFileTypes: true }).catch(() => [])
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
    const scratchEntries = await fs.promises.readdir(scratchDir, { withFileTypes: true }).catch(() => [])
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

  // 3. Collect every sha256 an item still references
  const colItems = await itemsCol()
  const referencedShas = new Set()
  const cursor = colItems.find(HAS_BLOB_REF_FILTER, {
    projection: BLOB_REF_PROJECTION,
  })
  for await (const doc of cursor) {
    for (const ref of blobRefsOf(doc)) referencedShas.add(ref.sha)
  }

  // 4. Sweep unreferenced blobs older than blobGraceMs in blobs/sha256/
  const blobsBaseDir = path.join(storageDir, 'blobs', 'sha256')
  try {
    const prefixDirs = await fs.promises.readdir(blobsBaseDir, { withFileTypes: true }).catch(() => [])
    for (const prefixEnt of prefixDirs) {
      if (!prefixEnt.isDirectory()) continue
      const prefixPath = path.join(blobsBaseDir, prefixEnt.name)
      const blobFiles = await fs.promises.readdir(prefixPath, { withFileTypes: true }).catch(() => [])

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

          if (!isReferenced && ageMs > blobGraceMs) {
            await fs.promises.unlink(fullBlobPath)
            blobsSwept++
            totalBlobBytes -= stats.size
            totalBlobCount--
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
    updatedAt: new Date(),
  }

  await colCfg.updateOne({ _id: 'usage' }, { $set: usageDoc }, { upsert: true })

  return {
    ok: true,
    tmpCleaned,
    scratchCleaned,
    blobsSwept,
    totalBlobBytes,
    totalBlobCount,
  }
}

export default {
  run,
}
