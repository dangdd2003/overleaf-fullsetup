import crypto from 'node:crypto'
import Settings from '@overleaf/settings'

// The only scope this authorization server issues.
export const MCP_SCOPE = 'mcp'

export function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input)
  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

/** Lifetime of an access token: one hour, after which the client refreshes it. */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60

/** A refresh token that goes this long unused is refused; each refresh resets it. */
export const REFRESH_TOKEN_IDLE_MS = 90 * 24 * 60 * 60 * 1000

// Only hashes of tokens are stored, so a database read does not reveal a
// usable refresh token.
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

/**
 * The audience of an access token: the URL of the MCP endpoint. services/mcp
 * serves that endpoint at /mcp and rejects tokens whose audience is not its
 * own URL (services/mcp/src/config.js derives the same value).
 */
export function mcpAudience(baseUrl) {
  return `${baseUrl}/mcp`
}

export function getBaseUrl(req) {
  if (Settings.siteUrl) {
    return Settings.siteUrl.replace(/\/+$/, '')
  }
  const host = req?.get ? req.get('host') : req?.headers?.host
  if (host) {
    const protocol = req?.protocol || 'http'
    return `${protocol}://${host}`
  }
  return 'http://localhost:3000'
}

/**
 * Validate a `scope` request parameter (RFC 6749 §3.3).
 *
 * A missing or blank value means the default `mcp`. Otherwise every
 * space-delimited token must be `mcp`.
 *
 * @returns {string|null} the granted scope, or null for an invalid scope
 */
export function normalizeScope(scope) {
  if (scope === undefined || scope === null) {
    return MCP_SCOPE
  }
  if (typeof scope !== 'string') {
    return null
  }
  const tokens = scope.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) {
    return MCP_SCOPE
  }
  return tokens.every(token => token === MCP_SCOPE) ? MCP_SCOPE : null
}
