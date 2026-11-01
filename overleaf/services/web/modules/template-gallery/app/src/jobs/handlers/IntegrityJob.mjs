import * as BlobStore from '../../storage/BlobStore.mjs'
import {
  BLOB_REF_PROJECTION,
  HAS_BLOB_REF_FILTER,
  blobRefsOf,
} from '../../storage/BlobRefs.mjs'
import { itemsCol } from '../../persistence/Collections.mjs'
import { DEFAULTS } from '../../TemplateGalleryDefaults.mjs'
import { logWarn } from '../../observability/Log.mjs'

/**
 * Checks one blob.
 * 'io_error' is transient (the disk could not be read): the item is not changed for it.
 *
 * @returns {Promise<'ok' | 'missing' | 'corrupt' | 'io_error'>}
 */
async function checkBlob(sha, storageDir) {
  try {
    const res = await BlobStore.verify(sha, storageDir)
    if (res?.ok) return 'ok'
    if (res?.reason === 'missing' || res?.reason === 'corrupt')
      return res.reason
    return 'io_error'
  } catch {
    return 'io_error'
  }
}

/**
 * Background job verifying the blobs referenced by the least recently checked
 * items. Re-fetchable blobs (mirrored media, cached source packages) are
 * dereferenced so they get mirrored or acquired again. The item state is never
 * changed: a broken blob only marks the item's integrity as corrupted.
 *
 * Every repair update is guarded by the sha that was checked, so a concurrent
 * change to the item is never overwritten by stale verification results.
 *
 * @param {object} job - Job document from templateGalleryJobs
 * @param {object} ctx - Execution context
 * @returns {Promise<{ ok: boolean, verifiedCount: number, corruptedCount: number, ioErrorCount: number, totalProcessed: number }>}
 */
export async function run(job, ctx = {}) {
  const cfg = ctx.cfg || DEFAULTS
  const batchSize = job?.payload?.batchSize || cfg?.runner?.integrityBatch || 25
  const storageDir = cfg?.storageDir || DEFAULTS.storageDir
  const col = await itemsCol()

  const items = await col
    .find(HAS_BLOB_REF_FILTER, { projection: BLOB_REF_PROJECTION })
    .sort({ 'integrity.lastCheckedAt': 1 })
    .limit(batchSize)
    .toArray()

  let verifiedCount = 0
  let corruptedCount = 0
  let ioErrorCount = 0

  for (const item of items) {
    const now = new Date()
    const $set = { 'integrity.lastCheckedAt': now }
    const $unset = {}
    const broken = []
    // The update only applies while every broken field still holds the sha that was checked
    const guard = { _id: item._id }
    let ioError = false

    for (const ref of blobRefsOf(item)) {
      const status = await checkBlob(ref.sha, storageDir)
      if (status === 'ok') continue
      if (status === 'io_error') {
        ioError = true
        continue
      }
      broken.push(ref.path)
      guard[ref.path] = ref.sha
      for (const field of ref.clears) $unset[field] = ''
    }

    if (broken.length === 0 && ioError) {
      // Transient read error: only the check timestamp moves, so the item is not starved
      ioErrorCount++
      logWarn('integrity_blob_io_error', { itemId: String(item._id) })
      await col.updateOne({ _id: item._id }, { $set })
      continue
    }

    if (broken.length === 0) {
      $set['integrity.status'] = 'ok'
      verifiedCount++
    } else {
      $set['integrity.status'] = 'corrupted'
      $set['integrity.lastError'] =
        `blob verification failed: ${broken.join(', ')}`
      $set.updatedAt = new Date()
      corruptedCount++
      logWarn('integrity_blob_broken', { itemId: String(item._id), broken })
    }

    const update = { $set }
    if (Object.keys($unset).length > 0) update.$unset = $unset
    const res = await col.updateOne(guard, update)
    if (res?.matchedCount === 0) {
      // The item changed after it was read; the next run checks it again
      await col.updateOne(
        { _id: item._id },
        { $set: { 'integrity.lastCheckedAt': now } }
      )
    }
  }

  return {
    ok: true,
    verifiedCount,
    corruptedCount,
    ioErrorCount,
    totalProcessed: items.length,
  }
}

export default {
  run,
}
