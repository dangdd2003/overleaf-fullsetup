import logger from '@overleaf/logger'
import PersonalAccessTokenManager from '../PersonalAccessToken/PersonalAccessTokenManager.mjs'
import OAuth2KeyManager from '../OAuth2/OAuth2KeyManager.mjs'
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
  const token = extractBearer(req)
  if (!token) {
    return McpErrors.send(res, McpErrors.CODES.UNAUTHORIZED)
  }

  let info
  const isJwt = token.split('.').length === 3

  if (isJwt) {
    try {
      const payload = await OAuth2KeyManager.verifyJwt(token, req)
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
  req.mcpTokenPrefix = token.slice(0, 8)

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
