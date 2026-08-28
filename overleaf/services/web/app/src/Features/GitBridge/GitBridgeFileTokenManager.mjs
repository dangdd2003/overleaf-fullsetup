import crypto from 'node:crypto'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'

/**
 * Short-lived, single-file access tokens for the Git Bridge file endpoint.
 *
 * The snapshot API hands git-bridge a URL per binary file, and git-bridge
 * fetches those URLs itself with an unauthenticated GET. Rather than giving
 * git-bridge a long-lived credential, each URL carries its own signed token
 * scoped to one project + file and valid for a short window.
 *
 * The query parameter must be named `token`: git-bridge strips `token=...`
 * from URLs before using them as cache keys (see UrlResourceCache), so any
 * other name would defeat its resource cache.
 */

// Generous enough that a slow clone of a project with many large binaries
// cannot fail part-way through with a suddenly-invalid token.
const DEFAULT_TTL_MS = 60 * 60 * 1000

function _secret() {
  const secret = Settings.security?.sessionSecret
  if (!secret) {
    logger.warn(
      {},
      'git-bridge file tokens unavailable: no security.sessionSecret configured'
    )
    return null
  }
  return secret
}

function _digest(secret, projectId, fileId, expiresAt) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${projectId}:${fileId}:${expiresAt}`)
    .digest('hex')
}

/**
 * Creates a signed token scoped to one project + file.
 *
 * @param {string} projectId
 * @param {string} fileId
 * @param {number} [ttlMs]
 * @returns {string|null} `<expiresAt>.<hmac>`, or null if signing is unavailable
 */
function createFileToken(projectId, fileId, ttlMs = DEFAULT_TTL_MS) {
  const secret = _secret()
  if (!secret) return null
  if (!projectId || !fileId) return null

  const expiresAt = Date.now() + ttlMs
  return `${expiresAt}.${_digest(secret, projectId, fileId, expiresAt)}`
}

/**
 * Verifies a token against the project + file it is expected to grant.
 *
 * @param {string} token
 * @param {string} projectId
 * @param {string} fileId
 * @returns {boolean}
 */
function verifyFileToken(token, projectId, fileId) {
  const secret = _secret()
  if (!secret) return false
  if (typeof token !== 'string' || !projectId || !fileId) return false

  const separator = token.indexOf('.')
  if (separator === -1) return false

  const expiresAtStr = token.slice(0, separator)
  if (!/^\d+$/.test(expiresAtStr)) return false

  const expiresAt = Number(expiresAtStr)
  const provided = token.slice(separator + 1)
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false

  const expected = _digest(secret, projectId, fileId, expiresAt)
  const providedBuf = Buffer.from(provided, 'utf8')
  const expectedBuf = Buffer.from(expected, 'utf8')
  if (providedBuf.length !== expectedBuf.length) return false

  return crypto.timingSafeEqual(providedBuf, expectedBuf)
}

const GitBridgeFileTokenManager = {
  createFileToken,
  verifyFileToken,
}

export default GitBridgeFileTokenManager
export { createFileToken, verifyFileToken }
