// overleaf/services/web/modules/template-gallery/app/src/storage/BlobStore.mjs
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { blobPath, tmpPath, quarantinePath, isValidSha256 } from './Paths.mjs'
import { DEFAULTS } from '../TemplateGalleryDefaults.mjs'
import { logWarn } from '../observability/Log.mjs'

function getStorageDir(customStorageDir) {
  if (customStorageDir && typeof customStorageDir === 'string') {
    return customStorageDir
  }
  return DEFAULTS.storageDir
}

function storageFullError(message, cause) {
  const err = new Error(message, cause ? { cause } : undefined)
  err.code = 'STORAGE_FULL'
  return err
}

/**
 * Maps out-of-space write errors to STORAGE_FULL. Other errors pass through.
 */
function normalizeWriteError(err) {
  if (err?.code === 'ENOSPC' || err?.code === 'EDQUOT') {
    return storageFullError(
      `Template gallery storage is full (${err.code})`,
      err
    )
  }
  return err
}

function magicBytesOf(magic) {
  return Buffer.isBuffer(magic) ? magic : Buffer.from(String(magic))
}

/**
 * Write stream with its 'error' events captured. A failed write (ENOSPC, EIO)
 * rejects the pending write() or end() instead of crashing the process.
 */
function createSink(filePath) {
  const ws = fs.createWriteStream(filePath, { mode: 0o640 })
  let failure = null
  ws.on('error', err => {
    failure = failure || err
  })

  function waitForDrain() {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        ws.removeListener('drain', onDrain)
        ws.removeListener('error', onError)
        ws.removeListener('close', onClose)
      }
      const onDrain = () => {
        cleanup()
        resolve()
      }
      const onError = err => {
        cleanup()
        reject(err)
      }
      const onClose = () => {
        cleanup()
        reject(failure || new Error('Write stream closed before drain'))
      }
      ws.on('drain', onDrain)
      ws.on('error', onError)
      ws.on('close', onClose)
    })
  }

  // Ends the stream and waits for 'close' (emitted after the fd is released).
  // A flush error can arrive after 'finish', so only 'close' makes the outcome final.
  function finish() {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        ws.removeListener('error', onError)
        ws.removeListener('close', onClose)
      }
      const onError = err => {
        cleanup()
        reject(err)
      }
      const onClose = () => {
        cleanup()
        if (failure) reject(failure)
        else resolve()
      }
      ws.on('error', onError)
      ws.on('close', onClose)
      ws.end()
    })
  }

  return {
    async write(chunk) {
      if (failure) throw failure
      if (!ws.write(chunk)) await waitForDrain()
      if (failure) throw failure
    },
    async end() {
      if (failure) throw failure
      await finish()
      if (failure) throw failure
    },
    // Resolves once the fd is released, so a staged file can be unlinked afterwards
    // (fs opens the file asynchronously, so an earlier unlink could miss it).
    async destroy() {
      if (ws.closed) return
      await new Promise(resolve => {
        ws.once('close', resolve)
        ws.destroy()
      })
    },
  }
}

let fsyncUnsupportedLogged = false

/**
 * Best-effort fsync of a file before it is renamed to its final name.
 * Never rejects: a failed or unsupported fsync is logged and the write continues.
 * Uses the callback API: FileHandle.sync() is not implemented by the Yarn PnP fs patch.
 */
function fsyncFile(filePath) {
  return new Promise(resolve => {
    fs.open(filePath, 'r', (openErr, fd) => {
      if (openErr) {
        logWarn('blob_fsync_open_failed', { error: openErr.message })
        return resolve()
      }
      fs.fsync(fd, syncErr => {
        fs.close(fd, () => {
          if (syncErr) noteFsyncFailure(syncErr)
          resolve()
        })
      })
    })
  })
}

function noteFsyncFailure(err) {
  const unsupported =
    ['ENOSYS', 'EINVAL', 'ENOTSUP'].includes(err.code) ||
    /not implemented/i.test(err.message)
  if (unsupported) {
    if (!fsyncUnsupportedLogged) {
      fsyncUnsupportedLogged = true
      logWarn('blob_fsync_unsupported', { code: err.code, error: err.message })
    }
    return
  }
  logWarn('blob_fsync_failed', { code: err.code, error: err.message })
}

async function moveFile(src, dest) {
  try {
    await fs.promises.rename(src, dest)
  } catch (err) {
    if (err.code !== 'EXDEV') throw err
    await fs.promises.copyFile(src, dest)
    await fs.promises.unlink(src)
  }
}

/**
 * Stores a readable stream into content-addressed BlobStore.
 * Streams to tmp/, computes sha256, enforces maxBytes and optional magic prefix,
 * fsyncs and atomically renames to blobs/sha256/<2hex>/<64hex> with mode 0o640.
 * The magic prefix may span chunk boundaries; an empty or too-short stream fails it.
 * Returns { sha256, sizeBytes, path }
 */
export async function putStream(readable, opts = {}) {
  const storageDir = getStorageDir(opts.storageDir)
  const maxBytes = opts.maxBytes || Infinity
  const magic = opts.magic ? magicBytesOf(opts.magic) : null
  const tempPath = tmpPath(storageDir)

  const hash = crypto.createHash('sha256')
  let sizeBytes = 0
  let magicHead = Buffer.alloc(0)
  let magicVerified = !magic
  let sink = null

  try {
    await fs.promises.mkdir(path.dirname(tempPath), {
      recursive: true,
      mode: 0o750,
    })
    sink = createSink(tempPath)

    for await (const raw of readable) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)

      if (!magicVerified) {
        magicHead = Buffer.concat([
          magicHead,
          chunk.subarray(0, magic.length - magicHead.length),
        ])
        if (magicHead.length === magic.length) {
          if (!magicHead.equals(magic)) {
            throw new Error('Magic header verification failed')
          }
          magicVerified = true
        }
      }

      sizeBytes += chunk.length
      if (sizeBytes > maxBytes) {
        const err = new Error(
          `Blob size ${sizeBytes} exceeds maximum allowed ${maxBytes}`
        )
        err.code = 'BLOB_TOO_LARGE'
        throw err
      }

      hash.update(chunk)
      await sink.write(chunk)
    }

    if (!magicVerified) {
      throw new Error(
        'Magic header verification failed: empty or truncated stream'
      )
    }

    await sink.end()
    await fsyncFile(tempPath)

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
    await sink?.destroy()
    await fs.promises.unlink(tempPath).catch(() => {})
    readable?.destroy?.()
    throw normalizeWriteError(err)
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
    const err = new Error(
      `File size ${fileStats.size} exceeds maximum ${maxBytes}`
    )
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

  try {
    await fsyncFile(filePath)
    // Rename first; across devices fall back to copy + fsync + unlink
    try {
      await fs.promises.rename(filePath, destinationPath)
    } catch (err) {
      if (err.code !== 'EXDEV') throw err
      let destExists = false
      try {
        const destStat = await fs.promises.stat(destinationPath)
        if (destStat.size > 0) destExists = true
      } catch {
        // Destination does not exist or is unreadable
      }

      if (destExists) {
        await fs.promises.unlink(filePath)
      } else {
        const destDir = path.dirname(destinationPath)
        const siblingTmp = path.join(destDir, `.tmp-${crypto.randomUUID()}`)
        try {
          await fs.promises.copyFile(filePath, siblingTmp)
          await fsyncFile(siblingTmp)
          await fs.promises.chmod(siblingTmp, 0o640)
          await fs.promises.rename(siblingTmp, destinationPath)
          await fs.promises.unlink(filePath)
        } catch (copyErr) {
          try {
            await fs.promises.unlink(siblingTmp)
          } catch {
            // ignore cleanup failure
          }
          throw copyErr
        }
      }
    }
  } catch (err) {
    throw normalizeWriteError(err)
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
 *
 * Returns { ok: true } when the hash matches. Otherwise returns { ok: false, reason }:
 *  - 'missing': the blob file does not exist (ENOENT)
 *  - 'io_error': the blob could not be read (any other errno); transient, nothing is moved
 *  - 'corrupt': the bytes do not hash to sha; the blob is moved to quarantine/
 *    (quarantinedPath is null when the move itself failed)
 */
export async function verify(sha, storageDir) {
  const resolvedDir = getStorageDir(storageDir)
  const fullPath = blobPath(resolvedDir, sha)

  const hash = crypto.createHash('sha256')
  try {
    for await (const chunk of fs.createReadStream(fullPath)) {
      hash.update(chunk)
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { ok: false, reason: 'missing', error: err.message }
    }
    return { ok: false, reason: 'io_error', error: err.message }
  }

  const computedSha = hash.digest('hex')
  if (computedSha === sha) {
    return { ok: true }
  }

  // Real checksum mismatch: move the blob out of the store
  const qPath = quarantinePath(resolvedDir, sha)
  let quarantinedPath = qPath
  try {
    await fs.promises.mkdir(path.dirname(qPath), {
      recursive: true,
      mode: 0o750,
    })
    await moveFile(fullPath, qPath)
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { ok: false, reason: 'missing', error: err.message }
    }
    logWarn('blob_quarantine_failed', { sha, error: err.message })
    quarantinedPath = null
  }

  return {
    ok: false,
    reason: 'corrupt',
    quarantinedPath,
    expected: sha,
    actual: computedSha,
  }
}

/**
 * Streams blob to destPath while computing sha256.
 * On mismatch: unlinks destPath, quarantines source blob, throws error with code = "BLOB_INTEGRITY_ERROR".
 * Write failures reject with code = "STORAGE_FULL" when the volume is full.
 */
export async function copyVerified(sha, destPath, storageDir) {
  const resolvedDir = getStorageDir(storageDir)
  const srcPath = blobPath(resolvedDir, sha)

  const hash = crypto.createHash('sha256')
  let sink = null

  try {
    // Ensure destination folder exists
    await fs.promises.mkdir(path.dirname(destPath), {
      recursive: true,
      mode: 0o750,
    })
    sink = createSink(destPath)

    for await (const chunk of fs.createReadStream(srcPath)) {
      hash.update(chunk)
      await sink.write(chunk)
    }
    await sink.end()
  } catch (err) {
    await sink?.destroy()
    await fs.promises.unlink(destPath).catch(() => {})
    throw normalizeWriteError(err)
  }

  const computedSha = hash.digest('hex')
  if (computedSha !== sha) {
    // Cleanup destPath
    await fs.promises.unlink(destPath).catch(() => {})

    // Quarantine corrupted blob
    const qPath = quarantinePath(resolvedDir, sha)
    await fs.promises.mkdir(path.dirname(qPath), {
      recursive: true,
      mode: 0o750,
    })
    try {
      await moveFile(srcPath, qPath)
    } catch (_err) {
      // The mismatch is still reported below
    }

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

export default {
  putStream,
  putBuffer,
  commitFile,
  exists,
  getStream,
  readBuffer,
  verify,
  copyVerified,
}
