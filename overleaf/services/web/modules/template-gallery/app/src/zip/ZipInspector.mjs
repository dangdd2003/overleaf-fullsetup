import fs from 'node:fs'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'
import yauzl from 'yauzl'
import archiver from 'archiver'

/**
 * Single-pass ZIP archive inspector and security validator.
 * Enforces strict byte ceilings, compression ratios, path traversal protections,
 * and extracts critical template metadata (main.tex candidates, licenses, manifest).
 */

const DEFAULT_LIMITS = {
  maxZipBytes: 50 * 1024 * 1024, // 50 MiB
  maxUncompressedBytes: 200 * 1024 * 1024, // 200 MiB
  maxEntries: 1000,
  maxEntryBytes: 25 * 1024 * 1024, // 25 MiB
  maxCompressionRatio: 100,
  maxLicenceFileBytes: 64 * 1024, // 64 KiB
  maxInspectMs: 60_000,
}

/**
 * Creates an in-memory ZIP Buffer from an array of entries { name, content (String|Buffer) }.
 */
export async function createZipBufferFromEntries(entries = []) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } })
    const buffers = []

    archive.on('data', data => buffers.push(data))
    archive.on('end', () => resolve(Buffer.concat(buffers)))
    archive.on('error', err => reject(err))

    for (const entry of entries) {
      if (typeof entry.content === 'string' || Buffer.isBuffer(entry.content)) {
        archive.append(entry.content, { name: entry.name })
      } else {
        archive.append(String(entry.content ?? ''), { name: entry.name })
      }
    }

    archive.finalize()
  })
}

/**
 * Inspect a ZIP archive file single-pass.
 */
export async function inspect(zipPath, limits = {}, opts = {}) {
  const mergedLimits = { ...DEFAULT_LIMITS, ...limits }
  const deadline = Date.now() + mergedLimits.maxInspectMs

  // 1. Check file existence & stat
  const stat = await fsp.stat(zipPath)
  if (stat.size > mergedLimits.maxZipBytes) {
    const err = new Error(`ZIP file size ${stat.size} bytes exceeds limit ${mergedLimits.maxZipBytes}`)
    err.code = 'zip_too_large'
    throw err
  }

  // 2. Magic bytes check
  const headerBuf = Buffer.alloc(4)
  const fd = await fsp.open(zipPath, 'r')
  try {
    await fd.read(headerBuf, 0, 4, 0)
  } finally {
    await fd.close()
  }

  const isPk =
    (headerBuf[0] === 0x50 && headerBuf[1] === 0x4b && headerBuf[2] === 0x03 && headerBuf[3] === 0x04) ||
    (headerBuf[0] === 0x50 && headerBuf[1] === 0x4b && headerBuf[2] === 0x05 && headerBuf[3] === 0x06)

  if (!isPk) {
    const err = new Error('File does not have valid ZIP magic bytes (PK\\x03\\x04 or PK\\x05\\x06)')
    err.code = 'not_a_zip'
    throw err
  }

  // Compute full zip sha256
  const zipSha256 = await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const rs = fs.createReadStream(zipPath)
    rs.on('data', chunk => hash.update(chunk))
    rs.on('end', () => resolve(hash.digest('hex')))
    rs.on('error', reject)
  })

  // 3. Open ZIP with yauzl in lazy mode
  const zipfile = await new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zf) => {
      if (err) return reject(err)
      resolve(zf)
    })
  })

  return new Promise((resolve, reject) => {
    let totalUncompressedBytes = 0
    let logicalEntryCount = 0
    const seenPaths = new Set()
    const manifest = []
    const texCandidates = []
    let licenceInfo = null
    let hasNonIgnoredFile = false

    const cleanup = () => {
      try {
        zipfile.close()
      } catch {}
    }

    const fail = (message, code) => {
      cleanup()
      const err = new Error(message)
      err.code = code
      reject(err)
    }

    zipfile.on('error', err => {
      fail(`Corrupted ZIP structure: ${err.message}`, 'corrupted_zip')
    })

    zipfile.on('entry', entry => {
      const fileName = entry.fileName

      if (Date.now() > deadline) {
        return fail(`Inspection exceeded time limit of ${mergedLimits.maxInspectMs} ms`, 'inspect_timeout')
      }

      // Validate fileName security
      // Leading slash, backslash, Windows drive letter, NUL or control chars, length, path traversal
      if (
        fileName.startsWith('/') ||
        fileName.startsWith('\\') ||
        /^[a-zA-Z]:/.test(fileName) ||
        /[\0\x01-\x1f\x7f]/.test(fileName) ||
        fileName.length > 1024 ||
        fileName.split(/[/\\]/).includes('..')
      ) {
        return fail(`Unsafe path in ZIP entry: ${fileName}`, 'unsafe_path')
      }

      // Case-folded duplicate collision check
      const folded = fileName.toLowerCase()
      if (seenPaths.has(folded)) {
        return fail(`Duplicate entry (case-collision): ${fileName}`, 'unsafe_path')
      }
      seenPaths.add(folded)

      // Symlink check: Unix file mode in high 16 bits of externalFileAttributes
      const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff
      const fileType = unixMode & 0o170000
      if (fileType === 0o120000) {
        return fail(`Symlink entry detected in ZIP: ${fileName}`, 'symlink')
      }
      // Special files: FIFOs (0o010000), character devices (0o020000), block devices (0o060000), sockets (0o140000)
      if (fileType === 0o010000 || fileType === 0o020000 || fileType === 0o060000 || fileType === 0o140000) {
        return fail(`Special device or FIFO entry detected in ZIP: ${fileName}`, 'special_file')
      }

      // Encrypted entry check
      if ((entry.generalPurposeBitFlag & 1) !== 0) {
        return fail(`Encrypted entry detected in ZIP: ${fileName}`, 'encrypted')
      }

      const isDirectory = fileName.endsWith('/')
      const isIgnored =
        fileName.startsWith('__MACOSX/') ||
        fileName.endsWith('/.DS_Store') ||
        fileName === '.DS_Store'

      if (!isDirectory && !isIgnored) {
        logicalEntryCount++
        hasNonIgnoredFile = true
      }

      if (logicalEntryCount > mergedLimits.maxEntries) {
        return fail(`Entry count exceeded limit of ${mergedLimits.maxEntries}`, 'max_entries_exceeded')
      }

      if (isDirectory) {
        // Read next entry
        return zipfile.readEntry()
      }

      // Check maxEntryBytes
      if (entry.uncompressedSize > mergedLimits.maxEntryBytes) {
        return fail(
          `Entry ${fileName} uncompressed size ${entry.uncompressedSize} exceeds limit ${mergedLimits.maxEntryBytes}`,
          'entry_too_large'
        )
      }

      // Check cumulative uncompressed bytes
      totalUncompressedBytes += entry.uncompressedSize
      if (totalUncompressedBytes > mergedLimits.maxUncompressedBytes) {
        return fail(
          `Total uncompressed bytes ${totalUncompressedBytes} exceeds limit ${mergedLimits.maxUncompressedBytes}`,
          'uncompressed_size_exceeded'
        )
      }

      // Check compression ratio for entries > 1 MiB
      if (entry.uncompressedSize > 1024 * 1024) {
        const compSize = entry.compressedSize || 1
        const ratio = entry.uncompressedSize / compSize
        if (ratio > mergedLimits.maxCompressionRatio) {
          return fail(
            `Compression ratio ${ratio.toFixed(1)} for ${fileName} exceeds limit ${mergedLimits.maxCompressionRatio}`,
            'zip_bomb'
          )
        }
      }

      // Stream entry to verify streamed byte count === uncompressedSize and compute sha256
      zipfile.openReadStream(entry, (err, readStream) => {
        if (err) {
          return fail(`Failed to open read stream for ${fileName}: ${err.message}`, 'corrupted_zip')
        }

        const entryHash = crypto.createHash('sha256')
        const captureChunks = []
        let streamedBytes = 0
        const shouldCaptureText =
          (folded.endsWith('.tex') && !isIgnored) ||
          ((folded.startsWith('license') || folded.startsWith('copying')) && !fileName.includes('/'))

        readStream.on('data', chunk => {
          streamedBytes += chunk.length
          entryHash.update(chunk)
          if (shouldCaptureText && streamedBytes <= mergedLimits.maxLicenceFileBytes) {
            captureChunks.push(chunk)
          }
        })

        readStream.on('end', () => {
          if (streamedBytes !== entry.uncompressedSize) {
            return fail(
              `Entry ${fileName} actual streamed bytes (${streamedBytes}) !== header size (${entry.uncompressedSize})`,
              'zip_lied'
            )
          }

          const entrySha256 = entryHash.digest('hex')

          if (!isIgnored) {
            manifest.push({
              path: fileName,
              size: entry.uncompressedSize,
              sha256: entrySha256,
            })
          }

          // Check if root license file
          const baseName = fileName.toLowerCase()
          if (!fileName.includes('/') && (baseName.startsWith('license') || baseName.startsWith('copying'))) {
            if (!licenceInfo) {
              const text = Buffer.concat(captureChunks).toString('utf8')
              licenceInfo = {
                path: fileName,
                sha256: entrySha256,
                text,
              }
            }
          }

          // Check if .tex candidate
          if (folded.endsWith('.tex') && !isIgnored) {
            const texContent = Buffer.concat(captureChunks).toString('utf8')
            const hasDocumentclass = /\\documentclass\s*(\[[^\]]*\])?\s*\{/.test(texContent)
            texCandidates.push({
              path: fileName,
              hasDocumentclass,
            })
          }

          zipfile.readEntry()
        })

        readStream.on('error', streamErr => {
          fail(`Error streaming entry ${fileName}: ${streamErr.message}`, 'corrupted_zip')
        })
      })
    })

    zipfile.on('end', () => {
      if (!hasNonIgnoredFile) {
        return fail('ZIP contains no regular non-ignored files', 'empty')
      }

      if (texCandidates.length === 0) {
        return fail('ZIP contains no .tex candidate files', 'no_tex')
      }

      resolve({
        zipSha256,
        sizeBytes: stat.size,
        totalUncompressedBytes,
        uncompressedBytes: totalUncompressedBytes,
        entryCount: logicalEntryCount,
        manifest,
        texCandidates,
        licence: licenceInfo,
        licenceFile: licenceInfo,
      })
    })

    // Kick off first entry read
    zipfile.readEntry()
  })
}

export default {
  inspect,
  createZipBufferFromEntries,
  DEFAULT_LIMITS,
}
