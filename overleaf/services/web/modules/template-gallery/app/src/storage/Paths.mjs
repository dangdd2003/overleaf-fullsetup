// overleaf/services/web/modules/template-gallery/app/src/storage/Paths.mjs
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const SHA256_REGEX = /^[0-9a-f]{64}$/

export function isValidSha256(sha) {
  return typeof sha === 'string' && SHA256_REGEX.test(sha)
}

// A file that belongs in blobs/sha256/<2hex>/<64hex>: the prefix directory must be
// the first two hex digits of the name. Anything else under blobs/ is stray.
export function isBlobLocation(prefix, name) {
  return isValidSha256(name) && typeof prefix === 'string' && name.startsWith(prefix)
    && prefix.length === 2
}

// Marker files left by the storage probe at the storage root (`.probe-<id>`).
export function isProbeName(name) {
  return typeof name === 'string' && name.startsWith('.probe-')
}

export function assertContained(storageDir, targetPath) {
  if (!storageDir || typeof storageDir !== 'string') {
    throw new Error('Invalid storageDir')
  }
  if (!targetPath || typeof targetPath !== 'string') {
    throw new Error('Invalid targetPath')
  }
  const resolvedRoot = path.resolve(storageDir)
  const resolvedTarget = path.resolve(targetPath)
  const rootWithSep = resolvedRoot.endsWith(path.sep)
    ? resolvedRoot
    : resolvedRoot + path.sep

  if (
    !resolvedTarget.startsWith(rootWithSep) &&
    resolvedTarget !== resolvedRoot
  ) {
    throw new Error(
      `Path traversal rejected: ${targetPath} is not contained within ${storageDir}`
    )
  }
  return resolvedTarget
}

export function blobPath(storageDir, sha) {
  if (!isValidSha256(sha)) {
    throw new Error(`Invalid sha256: ${sha}`)
  }
  const prefix = sha.slice(0, 2)
  const full = path.join(storageDir, 'blobs', 'sha256', prefix, sha)
  return assertContained(storageDir, full)
}

export function tmpPath(storageDir, id = randomUUID(), ext = '.upload') {
  if (
    typeof id !== 'string' ||
    id.includes('..') ||
    id.includes('/') ||
    id.includes('\\')
  ) {
    throw new Error(`Invalid tmp id: ${id}`)
  }
  const full = path.join(storageDir, 'tmp', `${id}${ext}`)
  return assertContained(storageDir, full)
}

export function scratchPath(storageDir, id = randomUUID(), ext = '.zip') {
  if (
    typeof id !== 'string' ||
    id.includes('..') ||
    id.includes('/') ||
    id.includes('\\')
  ) {
    throw new Error(`Invalid scratch id: ${id}`)
  }
  const full = path.join(storageDir, 'scratch', `${id}${ext}`)
  return assertContained(storageDir, full)
}

export function quarantinePath(storageDir, sha, ts = Date.now()) {
  if (!isValidSha256(sha)) {
    throw new Error(`Invalid sha256: ${sha}`)
  }
  const filename = `${sha}-${ts}`
  const full = path.join(storageDir, 'quarantine', filename)
  return assertContained(storageDir, full)
}

// Directories (relative to storageDir) that must exist before the store is used.
// catalog/ holds the rebuildable volume snapshot of the Mongo collections.
export const LAYOUT_SUBDIRS = Object.freeze([
  'blobs/sha256',
  'tmp',
  'scratch',
  'quarantine',
  'catalog',
])

export function layoutDirs(storageDir) {
  return LAYOUT_SUBDIRS.map(sub =>
    assertContained(storageDir, path.join(storageDir, sub))
  )
}

// Unique per call so concurrent probes (several processes booting) never read each other's marker.
export function probePath(storageDir, id = randomUUID()) {
  const full = path.join(storageDir, `.probe-${id}`)
  return assertContained(storageDir, full)
}

export default {
  isValidSha256,
  isBlobLocation,
  isProbeName,
  assertContained,
  blobPath,
  tmpPath,
  scratchPath,
  quarantinePath,
  probePath,
  layoutDirs,
  LAYOUT_SUBDIRS,
}
