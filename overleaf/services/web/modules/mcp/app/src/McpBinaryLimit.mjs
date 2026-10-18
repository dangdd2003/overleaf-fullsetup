import { Transform } from 'node:stream'

/** Largest binary output served through the MCP API, in bytes. */
export const MAX_BINARY_BYTES = 64 * 1024 * 1024

const MIB = 1024 * 1024

/** The message a client sees when a binary output is over the cap. */
export function tooLargeMessage(totalBytes, maxBytes = MAX_BINARY_BYTES) {
  const maxMb = maxBytes / MIB
  const size =
    totalBytes == null
      ? `over ${maxMb} MB`
      : `${Math.ceil(totalBytes / MIB)} MB > ${maxMb} MB`
  return `output too large (${size}); download it from Overleaf directly`
}

/**
 * A pass-through that errors once more than maxBytes have flowed through it.
 * Pipe a stream through it before the response, so a large export is cut off
 * instead of being sent in full.
 */
export function limitBinaryStream(maxBytes = MAX_BINARY_BYTES) {
  let total = 0
  return new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length
      if (total > maxBytes) {
        const err = new Error(tooLargeMessage(null, maxBytes))
        err.code = 'OUTPUT_TOO_LARGE'
        return callback(err)
      }
      callback(null, chunk)
    },
  })
}
