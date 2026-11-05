// overleaf/services/web/modules/template-gallery/app/src/storage/StorageHealth.mjs
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { layoutDirs, probePath } from './Paths.mjs'
import { DEFAULTS } from '../TemplateGalleryDefaults.mjs'

/**
 * Probes the storage directory. The store is meant to be its own Docker volume,
 * but no mount is required: the probe creates the layout
 * (blobs/sha256, tmp, scratch, quarantine, catalog) and checks that a probe
 * file can be written, read back and removed.
 *
 * Returns { ok, code, storageDir, freeBytes, totalBytes }. Free space is
 * information only: nothing is refused because the volume is getting full.
 */
export async function probe(cfg = {}) {
  const storageDir = cfg?.storageDir || DEFAULTS.storageDir

  try {
    for (const dir of layoutDirs(storageDir)) {
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o750 })
    }
  } catch (err) {
    return {
      ok: false,
      code: 'storage-unavailable',
      storageDir,
      error: err.message,
    }
  }

  try {
    const probeFile = probePath(storageDir)
    const marker = `probe-${randomUUID()}\n`
    await fs.promises.writeFile(probeFile, marker, { mode: 0o600 })
    const readBack = await fs.promises.readFile(probeFile, 'utf8')
    await fs.promises.unlink(probeFile)
    if (readBack !== marker) {
      return { ok: false, code: 'probe-mismatch', storageDir }
    }
  } catch (err) {
    return { ok: false, code: 'not-writable', storageDir, error: err.message }
  }

  let freeBytes = null
  let totalBytes = null
  if (typeof fs.promises.statfs === 'function') {
    try {
      const stats = await fs.promises.statfs(storageDir)
      freeBytes = Number(stats.bavail) * Number(stats.bsize)
      totalBytes = Number(stats.blocks) * Number(stats.bsize)
    } catch (_err) {
      // Free space unknown
    }
  }

  return {
    ok: true,
    code: 'healthy',
    storageDir,
    freeBytes,
    totalBytes,
  }
}

export default {
  probe,
}
