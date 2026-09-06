import { CODES, OverleafApiError, toToolError } from './errors.js'

/**
 * Pull the caller's Overleaf token out of the per-request MCP context.
 *
 * On the HTTP transport the token arrives as `ctx.http.authInfo`, put there by
 * the bearer middleware. On stdio there is no HTTP request, so the single-user
 * token from OVERLEAF_MCP_TOKEN is used instead.
 *
 * @param {object} ctx the tool-handler context
 * @param {string} [fallbackToken] the stdio token, if configured
 * @returns {string}
 */
export function tokenFrom(ctx, fallbackToken) {
  const token = ctx?.http?.authInfo?.token || fallbackToken
  if (!token) {
    throw new OverleafApiError(
      CODES.UNAUTHORIZED,
      'no Overleaf token is associated with this session',
      401
    )
  }
  return token
}

/**
 * Wrap a tool handler so every throw becomes a structured MCP tool error
 * carrying the upstream code, rather than an unhandled rejection.
 *
 * @param {(args: object, ctx: object) => Promise<object>} fn
 */
export function runTool(fn) {
  return async (args, ctx) => {
    try {
      return await fn(args, ctx)
    } catch (err) {
      return toToolError(err)
    }
  }
}

/**
 * Standard success result: one JSON text block the model can parse.
 *
 * @param {unknown} value
 */
export function textResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return { content: [{ type: 'text', text }] }
}
