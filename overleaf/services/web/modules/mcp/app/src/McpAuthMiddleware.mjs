import { createHash } from 'node:crypto'
import logger from '@overleaf/logger'
import PersonalAccessTokenManager from '../../../../app/src/Features/PersonalAccessToken/PersonalAccessTokenManager.mjs'
import OAuth2KeyManager from './OAuth2/OAuth2KeyManager.mjs'
import { OauthAccessToken } from '../../../../app/src/models/OauthAccessToken.mjs'
import McpErrors from './McpErrors.mjs'

const BEARER_PATTERN = /^Bearer\s+(\S+)$/i

/**
 * Extract a bearer token from the Authorization HEADER only.
 * Query-string and body tokens are deliberately ignored.
 *
 * @param {object} req
 * @returns {string|null}
 */
function extractBearer(req) {
  const header = req.headers?.authorization || ''
  const match = BEARER_PATTERN.exec(header)
  return match ? match[1] : null
}

/**
 * Sole authentication gate for /api/v0/mcp/* routes.
 * Validates RS256 JWTs or backward-compatible `olp_…` Personal Access Tokens,
 * maps them to a user and enforces the `mcp` scope. On any failure it sends
 * the McpErrors envelope and does NOT call next(). The raw token is never logged
 * or returned in a response.
 */
async function requireMcpAuth(req, res, next) {
  // The request guard authenticates before the body is read and sets the
  // user; the header has been rewritten by then, so do not validate it again.
  if (req.mcpUserId) {
    return next()
  }
  const token = extractBearer(req)
  if (!token) {
    return McpErrors.send(res, McpErrors.CODES.UNAUTHORIZED)
  }

  let info
  const isJwt = token.split('.').length === 3

  if (isJwt) {
    try {
      const payload = await OAuth2KeyManager.verifyJwt(token, req)
      // A token minted from a grant stays valid only while the grant exists.
      // Revoking the grant, or reaching its refresh expiry, ends access even
      // though a non-expiring JWT would still verify. Tokens without grant_id
      // predate grants and still carry exp, so they age out on their own.
      if (payload && payload.grant_id) {
        const grantActive = await OauthAccessToken.exists({
          _id: payload.grant_id,
          user_id: payload.sub,
          // The TTL index evicts expired grants only about once a minute.
          $or: [
            { refreshTokenExpiresAt: null },
            { refreshTokenExpiresAt: { $gt: new Date() } },
          ],
        })
        if (!grantActive) {
          throw new Error('OAuth grant has been revoked or has expired')
        }
      }
      if (payload && payload.sub) {
        const scopes = typeof payload.scope === 'string'
          ? payload.scope.split(' ').filter(Boolean)
          : Array.isArray(payload.scope)
            ? payload.scope
            : []
        info = {
          userId: payload.sub,
          scopes,
        }
      }
    } catch (err) {
      logger.warn({ err }, 'mcp jwt validation error')
      return McpErrors.send(res, McpErrors.CODES.UNAUTHORIZED)
    }
  } else {
    try {
      info = await PersonalAccessTokenManager.validateToken(token)
    } catch (err) {
      logger.warn({ err }, 'mcp token validation error')
      return McpErrors.send(res, McpErrors.CODES.UNAUTHORIZED)
    }
  }

  if (!info || !info.userId) {
    return McpErrors.send(res, McpErrors.CODES.UNAUTHORIZED)
  }

  const scopes = Array.isArray(info.scopes) ? info.scopes : []
  if (!scopes.includes('mcp')) {
    return McpErrors.send(res, McpErrors.CODES.INSUFFICIENT_SCOPE)
  }

  req.mcpUserId = info.userId
  req.mcpScopes = scopes
  // Four characters: enough to tell tokens apart in logs, too few to leak the secret.
  req.mcpTokenPrefix = token.slice(0, 4)
  // Keep a stable, non-secret identifier for per-token rate limiting.
  req.mcpTokenId = createHash('sha256').update(token).digest('hex')
  req.headers.authorization = `Bearer ${req.mcpTokenPrefix}...`

  logger.info(
    {
      mcpUserId: req.mcpUserId,
      mcpTokenPrefix: req.mcpTokenPrefix,
      method: req.method,
      route: req.path,
    },
    'mcp request authenticated'
  )

  return next()
}

export default { requireMcpAuth }
export { requireMcpAuth }
