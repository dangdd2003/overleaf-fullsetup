import * as BlobStore from '../../storage/BlobStore.mjs'
import {
  BLOB_REF_PROJECTION,
  HAS_BLOB_REF_FILTER,
  blobRefsOf,
} from '../../storage/BlobRefs.mjs'
import { itemsCol } from '../../persistence/Collections.mjs'
import Settings from '@overleaf/settings'
import { DEFAULTS } from '../../TemplateGalleryDefaults.mjs'
import { logWarn } from '../../observability/Log.mjs'

async function verifies(sha, storageDir) {
  try {
    const res = await BlobStore.verify(sha, storageDir)
    return Boolean(res?.ok)
  } catch {
    return false
  }
}

/**
 * Background job verifying the blobs referenced by the least recently checked
 * items. Re-fetchable blobs (mirrored media, cached source packages) are
 * dereferenced so they get mirrored again; a broken admin upload marks the
 * item "blob_missing".
 *
 * @param {object} job - Job document from templateGalleryJobs
 * @param {object} ctx - Execution context
 * @returns {Promise<{ ok: boolean, verifiedCount: number, corruptedCount: number, totalProcessed: number }>}
 */
export async function run(job, ctx = {}) {
  const cfg = ctx.cfg || Settings.templateGallery || DEFAULTS
  const batchSize = job?.payload?.batchSize || cfg?.runner?.integrityBatch || 25
  const storageDir = cfg?.storageDir || DEFAULTS.storageDir
  const col = await itemsCol()

  const items = await col
    .find(
      { ...HAS_BLOB_REF_FILTER, state: { $ne: 'blob_missing' } },
      { projection: { ...BLOB_REF_PROJECTION, state: 1, source: 1 } }
    )
    .sort({ 'integrity.lastCheckedAt': 1 })
    .limit(batchSize)
    .toArray()

  let verifiedCount = 0
  let corruptedCount = 0

  for (const item of items) {
    const now = new Date()
    const $set = { 'integrity.lastCheckedAt': now }
    const $unset = {}
    const broken = []

    for (const ref of blobRefsOf(item)) {
      if (await verifies(ref.sha, storageDir)) continue
      broken.push(ref.path)
      if (ref.kind === 'upload') {
        $set.state = 'blob_missing'
      } else {
        for (const path of ref.clears) $unset[path] = ''
      }
    }

    if (broken.length === 0) {
      $set['integrity.status'] = 'ok'
      verifiedCount++
    } else {
      $set['integrity.status'] = 'corrupted'
      $set['integrity.lastError'] = `blob verification failed: ${broken.join(', ')}`
      $set.updatedAt = now
      corruptedCount++
      logWarn('integrity_blob_broken', { itemId: String(item._id), broken })
    }

    const update = { $set }
    if (Object.keys($unset).length > 0) update.$unset = $unset
    await col.updateOne({ _id: item._id }, update)
  }

  return {
    ok: true,
    verifiedCount,
    corruptedCount,
    totalProcessed: items.length,
  }
}

export default {
  run,
}
