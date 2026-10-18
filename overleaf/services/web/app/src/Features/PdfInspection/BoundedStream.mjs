// Reads and copies CLSI output streams with a byte limit, so one oversized
// output.pdf or output.log cannot fill the memory or the disk of the web
// process. The PDF inspectors all read build output through these.

import fs from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// Far above any real PDF a LaTeX build writes; a runaway one is refused.
export const MAX_OUTPUT_PDF_BYTES = 256 * 1024 * 1024
// A log is read for its bad boxes and errors near the start; a runaway one is
// cut here rather than held whole.
export const MAX_OUTPUT_LOG_BYTES = 16 * 1024 * 1024

export class OutputTooLargeError extends Error {
  constructor(maxBytes) {
    super(`build output is larger than ${maxBytes} bytes`)
    this.name = 'OutputTooLargeError'
    this.code = 'output_too_large'
  }
}

/**
 * Reads a stream into one Buffer, stopping at `maxBytes`. Returns
 * `{ buffer, truncated }`; a truncated read holds exactly the first `maxBytes`.
 */
export async function readBounded(stream, maxBytes) {
  const chunks = []
  let total = 0
  let truncated = false
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (total + bytes.length > maxBytes) {
        chunks.push(bytes.subarray(0, maxBytes - total))
        total = maxBytes
        truncated = true
        break
      }
      chunks.push(bytes)
      total += bytes.length
    }
  } finally {
    stream.destroy?.()
  }
  return { buffer: Buffer.concat(chunks, total), truncated }
}

/**
 * Copies a stream to `target`. Throws OutputTooLargeError, leaving a partial
 * file for the caller to remove, once more than `maxBytes` have arrived.
 */
export async function pipeBounded(stream, target, maxBytes) {
  let total = 0
  const limit = new Transform({
    transform(chunk, _encoding, callback) {
      total += Buffer.byteLength(chunk)
      if (total > maxBytes) {
        callback(new OutputTooLargeError(maxBytes))
        return
      }
      callback(null, chunk)
    },
  })
  await pipeline(stream, limit, fs.createWriteStream(target))
}
