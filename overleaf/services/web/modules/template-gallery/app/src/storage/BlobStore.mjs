// overleaf/services/web/modules/template-gallery/app/src/storage/BlobStore.mjs
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import Settings from '@overleaf/settings'
import {
  blobPath,
  tmpPath,
  quarantinePath,
  isValidSha256,
  assertContained,
} from './Paths.mjs'
import { DEFAULTS } from '../TemplateGalleryDefaults.mjs'

function getStorageDir(customStorageDir) {
  if (customStorageDir && typeof customStorageDir === 'string') {
    return customStorageDir
  }
  return (
    Settings.templateGallery?.storageDir ||
    DEFAULTS.storageDir ||
    '/var/lib/overleaf/data/template-gallery'
  )
}

/**
 * Checks magic prefix if specified (buffer or string).
 */
function checkMagic(chunk, magic) {
  if (!magic || !chunk || chunk.length === 0) return true
  const magicBuf = Buffer.isBuffer(magic) ? magic : Buffer.from(magic)
  if (chunk.length < magicBuf.length) return false
  return chunk.subarray(0, magicBuf.length).equals(magicBuf)
}

/**
 * Stores a readable stream into content-addressed BlobStore.
 * Streams to tmp/, computes sha256, enforces maxBytes and optional magic prefix,
 * atomic rename to blobs/sha256/<2hex>/<64hex> with mode 0o640.
 * Returns { sha256, sizeBytes, path }
 */
export async function putStream(readable, opts = {}) {
  const storageDir = getStorageDir(opts.storageDir)
  const maxBytes = opts.maxBytes || Infinity
  const magic = opts.magic
  const tempPath = tmpPath(storageDir)

  // Ensure tmp directory exists
  await fs.promises.mkdir(path.dirname(tempPath), { recursive: true, mode: 0o750 })

  const writeStream = fs.createWriteStream(tempPath, { mode: 0o640 })
  const hash = crypto.createHash('sha256')

  let sizeBytes = 0
  let magicChecked = false
  let magicPassed = true

  try {
    for await (const chunk of readable) {
      if (!magicChecked && magic) {
        if (!checkMagic(chunk, magic)) {
          magicPassed = false
          throw new Error('Magic header verification failed')
        }
        magicChecked = true
      }

      sizeBytes += chunk.length
      if (sizeBytes > maxBytes) {
        const err = new Error(`Blob size ${sizeBytes} exceeds maximum allowed ${maxBytes}`)
        err.code = 'BLOB_TOO_LARGE'
        throw err
      }

      hash.update(chunk)
      if (!writeStream.write(chunk)) {
        await new Promise(resolve => writeStream.once('drain', resolve))
      }
    }

    if (magic && !magicChecked && !magicPassed) {
      throw new Error('Magic header verification failed: empty or truncated stream')
    }

    await new Promise((resolve, reject) => {
      writeStream.end(err => (err ? reject(err) : resolve()))
    })

    const sha256 = hash.digest('hex')
    const destinationPath = blobPath(storageDir, sha256)

    // Ensure parent 2-hex directory exists
    await fs.promises.mkdir(path.dirname(destinationPath), {
      recursive: true,
      mode: 0o750,
    })

    // Atomic move
    await fs.promises.rename(tempPath, destinationPath)
    await fs.promises.chmod(destinationPath, 0o640)

    return {
      sha256,
      sizeBytes,
      path: destinationPath,
    }
  } catch (err) {
    writeStream.destroy()
    try {
      await fs.promises.unlink(tempPath)
    } catch {
      // Ignore cleanup error
    }
    throw err
  }
}

/**
 * Stores a Buffer into the BlobStore.
 */
export async function putBuffer(buf, opts = {}) {
  if (!Buffer.isBuffer(buf)) {
    throw new Error('Expected Buffer instance')
  }
  const { Readable } = await import('node:stream')
  const readable = Readable.from(buf)
  return putStream(readable, opts)
}

/**
 * Hashes and moves an existing file on disk into the blob store.
 */
export async function commitFile(filePath, opts = {}) {
  const storageDir = getStorageDir(opts.storageDir)
  const maxBytes = opts.maxBytes || Infinity

  const fileStats = await fs.promises.stat(filePath)
  if (fileStats.size > maxBytes) {
    const err = new Error(`File size ${fileStats.size} exceeds maximum ${maxBytes}`)
    err.code = 'BLOB_TOO_LARGE'
    throw err
  }

  const hash = crypto.createHash('sha256')
  const readStream = fs.createReadStream(filePath)
  for await (const chunk of readStream) {
    hash.update(chunk)
  }

  const sha256 = hash.digest('hex')
  const destinationPath = blobPath(storageDir, sha256)

  await fs.promises.mkdir(path.dirname(destinationPath), {
    recursive: true,
    mode: 0o750,
  })

  // Try rename first, fallback to copy + unlink if cross-device
  try {
    await fs.promises.rename(filePath, destinationPath)
  } catch (err) {
    if (err.code === 'EXDEV') {
      await fs.promises.copyFile(filePath, destinationPath)
      await fs.promises.unlink(filePath)
    } else {
      throw err
    }
  }

  await fs.promises.chmod(destinationPath, 0o640)

  return {
    sha256,
    sizeBytes: fileStats.size,
    path: destinationPath,
  }
}

/**
 * Checks if a blob exists.
 */
export async function exists(sha, storageDir) {
  if (!isValidSha256(sha)) return false
  const fullPath = blobPath(getStorageDir(storageDir), sha)
  try {
    await fs.promises.access(fullPath, fs.constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Returns a readable stream for the blob.
 */
export function getStream(sha, storageDir) {
  const fullPath = blobPath(getStorageDir(storageDir), sha)
  return fs.createReadStream(fullPath)
}

/**
 * Reads the blob entirely into memory as a Buffer.
 */
export async function readBuffer(sha, storageDir) {
  const fullPath = blobPath(getStorageDir(storageDir), sha)
  return fs.promises.readFile(fullPath)
}

/**
 * Verifies sha256 of the stored blob.
 * On mismatch, moves the corrupted blob to quarantine/ and returns { ok: false, quarantinedPath }.
 */
export async function verify(sha, storageDir) {
  const resolvedDir = getStorageDir(storageDir)
  const fullPath = blobPath(resolvedDir, sha)

  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(fullPath)

  try {
    for await (const chunk of stream) {
      hash.update(chunk)
    }
  } catch (err) {
    return { ok: false, error: err.message }
  }

  const computedSha = hash.digest('hex')
  if (computedSha === sha) {
    return { ok: true }
  }

  // Checksum mismatch -> quarantine blob
  const qPath = quarantinePath(resolvedDir, sha)
  await fs.promises.mkdir(path.dirname(qPath), { recursive: true, mode: 0o750 })
  try {
    await fs.promises.rename(fullPath, qPath)
  } catch (err) {
    // If rename failed, try copy + unlink
    if (err.code === 'EXDEV') {
      await fs.promises.copyFile(fullPath, qPath)
      await fs.promises.unlink(fullPath)
    } else {
      throw err
    }
  }

  return {
    ok: false,
    quarantinedPath: qPath,
    expected: sha,
    actual: computedSha,
  }
}

/**
 * Streams blob to destPath while computing sha256.
 * On mismatch: unlinks destPath, quarantines source blob, throws error with code = "BLOB_INTEGRITY_ERROR".
 */
export async function copyVerified(sha, destPath, storageDir) {
  const resolvedDir = getStorageDir(storageDir)
  const srcPath = blobPath(resolvedDir, sha)

  // Ensure destination folder exists
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true, mode: 0o750 })

  const hash = crypto.createHash('sha256')
  const readStream = fs.createReadStream(srcPath)
  const writeStream = fs.createWriteStream(destPath, { mode: 0o640 })

  let writeError = null

  try {
    for await (const chunk of readStream) {
      hash.update(chunk)
      if (!writeStream.write(chunk)) {
        await new Promise(resolve => writeStream.once('drain', resolve))
      }
    }
    await new Promise((resolve, reject) => {
      writeStream.end(err => (err ? reject(err) : resolve()))
    })
  } catch (err) {
    writeError = err
    writeStream.destroy()
    try {
      await fs.promises.unlink(destPath)
    } catch {}
    throw err
  }

  const computedSha = hash.digest('hex')
  if (computedSha !== sha) {
    // Cleanup destPath
    try {
      await fs.promises.unlink(destPath)
    } catch {}

    // Quarantine corrupted blob
    const qPath = quarantinePath(resolvedDir, sha)
    await fs.promises.mkdir(path.dirname(qPath), { recursive: true, mode: 0o750 })
    try {
      await fs.promises.rename(srcPath, qPath)
    } catch {}

    const integrityErr = new Error(
      `Blob integrity check failed for ${sha}; computed ${computedSha}`
    )
    integrityErr.code = 'BLOB_INTEGRITY_ERROR'
    integrityErr.expected = sha
    integrityErr.actual = computedSha
    integrityErr.quarantinedPath = qPath
    throw integrityErr
  }

  return { ok: true, path: destPath }
}

/**
 * Deletes a blob if it exists.
 */
export async function deleteBlob(sha, storageDir) {
  if (!isValidSha256(sha)) return false
  const fullPath = blobPath(getStorageDir(storageDir), sha)
  try {
    await fs.promises.unlink(fullPath)
    return true
  } catch (err) {
    if (err.code === 'ENOENT') return false
    throw err
  }
}

/**
 * Recursively lists all blob sha256 strings in the BlobStore.
 */
export async function listAllBlobs(storageDir) {
  const root = path.join(getStorageDir(storageDir), 'blobs', 'sha256')
  const shas = []

  let hexDirs
  try {
    hexDirs = await fs.promises.readdir(root, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }

  for (const dirEnt of hexDirs) {
    if (dirEnt.isDirectory()) {
      const subDirPath = path.join(root, dirEnt.name)
      const files = await fs.promises.readdir(subDirPath, { withFileTypes: true })
      for (const fileEnt of files) {
        if (fileEnt.isFile() && isValidSha256(fileEnt.name)) {
          shas.push(fileEnt.name)
        }
      }
    }
  }

  return shas
}

export default {
  putStream,
  putBuffer,
  commitFile,
  exists,
  getStream,
  readBuffer,
  verify,
  copyVerified,
  deleteBlob,
  listAllBlobs,
}
