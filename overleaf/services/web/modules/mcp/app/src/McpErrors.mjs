import crypto from 'node:crypto'
import logger from '@overleaf/logger'

const CODES = {
  UNAUTHORIZED: 'unauthorized',
  INSUFFICIENT_SCOPE: 'insufficient_scope',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  VALIDATION: 'validation_error',
  RATE_LIMITED: 'rate_limited',
  UPSTREAM: 'upstream_error',
  CONFLICT: 'conflict',
  TOO_LARGE: 'output_too_large',
  PAYLOAD_TOO_LARGE: 'payload_too_large',
}

const STATUS = {
  [CODES.UNAUTHORIZED]: 401,
  [CODES.INSUFFICIENT_SCOPE]: 403,
  [CODES.FORBIDDEN]: 403,
  [CODES.NOT_FOUND]: 404,
  [CODES.VALIDATION]: 400,
  [CODES.RATE_LIMITED]: 429,
  [CODES.UPSTREAM]: 502,
  [CODES.CONFLICT]: 409,
  [CODES.TOO_LARGE]: 413,
  [CODES.PAYLOAD_TOO_LARGE]: 413,
}

const DEFAULT_MESSAGE = {
  [CODES.UNAUTHORIZED]: 'valid authentication required',
  [CODES.INSUFFICIENT_SCOPE]: 'token is missing the required mcp scope',
  [CODES.FORBIDDEN]: 'insufficient project privileges',
  [CODES.NOT_FOUND]: 'not found',
  [CODES.VALIDATION]: 'invalid request',
  [CODES.RATE_LIMITED]: 'rate limit exceeded',
  [CODES.UPSTREAM]: 'an upstream service failed',
  [CODES.CONFLICT]: 'the target already exists or was changed',
  [CODES.TOO_LARGE]: 'output too large; download it from Overleaf directly',
  [CODES.PAYLOAD_TOO_LARGE]: 'request body too large',
}

/**
 * Send the MCP error envelope.
 *
 * `extra.hint` is recovery guidance for the model (which call to make next);
 * `extra.details` is machine-readable context such as candidate paths.
 */
function send(res, code, message, extra = {}) {
  if (code === CODES.UNAUTHORIZED) {
    res.setHeader?.('WWW-Authenticate', 'Bearer')
  } else if (code === CODES.INSUFFICIENT_SCOPE) {
    res.setHeader?.(
      'WWW-Authenticate',
      'Bearer error="insufficient_scope", scope="mcp"'
    )
  }
  return res
    .status(STATUS[code] || 500)
    .json({
      code,
      message: message || DEFAULT_MESSAGE[code] || 'error',
      ...(extra.hint ? { hint: extra.hint } : {}),
      ...(extra.details ? { details: extra.details } : {}),
      ...(extra.errorId ? { errorId: extra.errorId } : {}),
    })
}

/**
 * Answer an unexpected failure with a generic body and an error id.
 *
 * The raw error (its message can name internal services, paths or upstream
 * payloads) is logged once here under that id, and never sent to the client.
 * The id lets a user quote a failure that support can then find in the logs.
 */
function sendInternal(res, err, context = {}) {
  const errorId = crypto.randomUUID()
  logger.error({ err, errorId, ...context }, 'mcp request failed')
  const extra = { errorId }
  if (context.hint) extra.hint = context.hint
  if (context.details) extra.details = context.details
  return send(res, CODES.UPSTREAM, undefined, extra)
}

export default { CODES, send, sendInternal }
export { CODES, send, sendInternal }
