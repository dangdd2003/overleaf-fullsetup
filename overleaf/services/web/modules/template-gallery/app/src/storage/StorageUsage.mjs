// overleaf/services/web/modules/template-gallery/app/src/storage/StorageUsage.mjs
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULTS } from '../TemplateGalleryDefaults.mjs'

// A walk of the mirror folder is reused for this long, so the admin page can
// poll the status without walking the disk on every request.
const CACHE_MS = 60_000

let cached = null
let pending = null

// Areas of the mirror folder, by the first path segments of a file.
export const AREAS = Object.freeze([
  'blobs',
  'strayBlobs',
  'catalog',
  'tmp',
  'scratch',
  'quarantine',
  'probes',
  'other',
])

export function areaOf(relPath) {
  const parts = relPath.split(path.sep)
  const [first, second, third] = parts
  if (parts.length === 1 && first.startsWith('.probe-')) return 'probes'
  if (first === 'blobs') {
    // blobs/sha256/<2hex>/<64hex>; anything else under blobs/ is stray
    const name = parts[parts.length - 1]
    const valid =
      parts.length === 4 &&
      second === 'sha256' &&
      /^[0-9a-f]{2}$/.test(third) &&
      /^[0-9a-f]{64}$/.test(name) &&
      name.startsWith(third)
    return valid ? 'blobs' : 'strayBlobs'
  }
  if (first === 'catalog') return 'catalog'
  if (first === 'tmp') return 'tmp'
  if (first === 'scratch') return 'scratch'
  if (first === 'quarantine') return 'quarantine'
  return 'other'
}

async function walk(root, dir, totals) {
  let entries
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(root, fullPath, totals)
    } else if (entry.isFile()) {
      try {
        const size = (await fs.promises.stat(fullPath)).size
        const area = areaOf(path.relative(root, fullPath))
        totals.bytes += size
        totals.files++
        totals.areas[area].bytes += size
        totals.areas[area].files++
      } catch {
        // Removed while walking
      }
    }
  }
}

async function measureNow(storageDir) {
  const totals = {
    bytes: 0,
    files: 0,
    areas: Object.fromEntries(AREAS.map(area => [area, { files: 0, bytes: 0 }])),
  }
  await walk(storageDir, storageDir, totals)
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
    areas: totals.areas,
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

export default { measure, resetForTests, AREAS }
