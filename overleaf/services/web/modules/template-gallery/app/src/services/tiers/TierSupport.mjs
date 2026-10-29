import fsp from 'node:fs/promises'
import Path from 'node:path'
import Settings from '@overleaf/settings'
import { DEFAULTS } from '../../TemplateGalleryDefaults.mjs'
import { tmpPath } from '../../storage/Paths.mjs'
import BlobStore from '../../storage/BlobStore.mjs'
import ZipInspector from '../../zip/ZipInspector.mjs'

// Helpers shared by the source acquisition tiers.

export function resolveStorageDir(cfg, override) {
  return (
    override ||
    cfg?.storageDir ||
    Settings.templateGallery?.storageDir ||
    DEFAULTS.storageDir
  )
}

export function resolveLimits(cfg) {
  return { ...DEFAULTS.limits, ...(cfg?.limits || {}) }
}

/**
 * Prefer `preferred` (the template's declared main file) when the archive has
 * it, else `main.tex`, else the first root document with a \documentclass.
 *
 * @param {Array<{ path: string, hasDocumentclass: boolean }>} texCandidates
 * @param {string} [preferred]
 * @returns {string|null}
 */
export function pickMainFile(texCandidates = [], preferred) {
  if (!texCandidates.length) return null
  const byLowerPath = new Map(
    texCandidates.map(candidate => [candidate.path.toLowerCase(), candidate])
  )
  if (preferred && byLowerPath.has(String(preferred).toLowerCase())) {
    return byLowerPath.get(String(preferred).toLowerCase()).path
  }
  const withClass = texCandidates.filter(candidate => candidate.hasDocumentclass)
  const main = withClass.find(candidate => /(^|\/)main\.tex$/i.test(candidate.path))
  const shallowest = [...withClass].sort(
    (a, b) => a.path.split('/').length - b.path.split('/').length
  )[0]
  return (main || shallowest || texCandidates[0]).path
}

/**
 * Validate a zip held in memory with ZipInspector and move it into the
 * BlobStore.
 *
 * @param {Buffer} buffer
 * @param {{ cfg?: object, storageDir?: string }} opts
 */
export async function commitZipBuffer(buffer, { cfg, storageDir } = {}) {
  const dir = resolveStorageDir(cfg, storageDir)
  const zipPath = tmpPath(dir, undefined, '.zip')
  await fsp.mkdir(Path.dirname(zipPath), { recursive: true, mode: 0o750 })
  await fsp.writeFile(zipPath, buffer, { mode: 0o640 })
  try {
    const inspection = await ZipInspector.inspect(zipPath, resolveLimits(cfg))
    const committed = await BlobStore.commitFile(zipPath, { storageDir: dir })
    return {
      zipSha256: committed.sha256,
      sizeBytes: committed.sizeBytes,
      entryCount: inspection.entryCount,
      uncompressedBytes: inspection.totalUncompressedBytes,
      inspection,
    }
  } finally {
    // commitFile renames the file away on success
    await fsp.rm(zipPath, { force: true })
  }
}

export default {
  resolveStorageDir,
  resolveLimits,
  pickMainFile,
  commitZipBuffer,
}
