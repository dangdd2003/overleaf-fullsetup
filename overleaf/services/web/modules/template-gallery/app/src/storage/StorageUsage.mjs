// overleaf/services/web/modules/template-gallery/app/src/storage/StorageUsage.mjs
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULTS } from '../TemplateGalleryDefaults.mjs'

// A walk of the mirror folder is reused for this long, so the admin page can
// poll the status without walking the disk on every request.
const CACHE_MS = 60_000

let cached = null
let pending = null

async function walk(dir, totals) {
  let entries
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(fullPath, totals)
    } else if (entry.isFile()) {
      try {
        totals.bytes += (await fs.promises.stat(fullPath)).size
        totals.files++
      } catch {
        // Removed while walking
      }
    }
  }
}

async function measureNow(storageDir) {
  const totals = { bytes: 0, files: 0 }
  await walk(storageDir, totals)
  let freeBytes = null
  let totalBytes = null
  try {
    const stats = await fs.promises.statfs(storageDir)
    freeBytes = Number(stats.bavail) * Number(stats.bsize)
    totalBytes = Number(stats.blocks) * Number(stats.bsize)
  } catch {
    // Volume size unknown
  }
  return {
    usedBytes: totals.bytes,
    files: totals.files,
    freeBytes,
    totalBytes,
    measuredAt: new Date(),
  }
}

/**
 * Disk used by the mirror folder and the free space of its volume.
 * Information only: nothing is limited by these numbers.
 *
 * @returns {Promise<{ usedBytes: number, files: number, freeBytes: number|null, totalBytes: number|null, measuredAt: Date }>}
 */
export async function measure(storageDir = DEFAULTS.storageDir) {
  if (cached && Date.now() - cached.measuredAt.getTime() < CACHE_MS) {
    return cached
  }
  if (!pending) {
    pending = measureNow(storageDir)
      .then(result => {
        cached = result
        return result
      })
      .finally(() => {
        pending = null
      })
  }
  return pending
}

export function resetForTests() {
  cached = null
  pending = null
}

export default { measure, resetForTests }
