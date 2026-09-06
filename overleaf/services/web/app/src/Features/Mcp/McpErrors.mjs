const CODES = {
  UNAUTHORIZED: 'unauthorized',
  INSUFFICIENT_SCOPE: 'insufficient_scope',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  VALIDATION: 'validation_error',
  RATE_LIMITED: 'rate_limited',
  UPSTREAM: 'upstream_error',
}

const STATUS = {
  [CODES.UNAUTHORIZED]: 401,
  [CODES.INSUFFICIENT_SCOPE]: 403,
  [CODES.FORBIDDEN]: 403,
  [CODES.NOT_FOUND]: 404,
  [CODES.VALIDATION]: 400,
  [CODES.RATE_LIMITED]: 429,
  [CODES.UPSTREAM]: 502,
}

const DEFAULT_MESSAGE = {
  [CODES.UNAUTHORIZED]: 'valid authentication required',
  [CODES.INSUFFICIENT_SCOPE]: 'token is missing the required mcp scope',
  [CODES.FORBIDDEN]: 'insufficient project privileges',
  [CODES.NOT_FOUND]: 'not found',
  [CODES.VALIDATION]: 'invalid request',
  [CODES.RATE_LIMITED]: 'rate limit exceeded',
  [CODES.UPSTREAM]: 'an upstream service failed',
}

function send(res, code, message) {
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
    .json({ code, message: message || DEFAULT_MESSAGE[code] || 'error' })
}

export default { CODES, STATUS, send }
export { CODES, STATUS, send }
