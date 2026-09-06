export const CODES = Object.freeze({
  UNAUTHORIZED: 'unauthorized',
  INSUFFICIENT_SCOPE: 'insufficient_scope',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  VALIDATION_ERROR: 'validation_error',
  RATE_LIMITED: 'rate_limited',
  UPSTREAM_ERROR: 'upstream_error',
})

const STATUS_TO_CODE = new Map([
  [400, CODES.VALIDATION_ERROR],
  [401, CODES.UNAUTHORIZED],
  [403, CODES.FORBIDDEN],
  [404, CODES.NOT_FOUND],
  [429, CODES.RATE_LIMITED],
])

// olp_ + at least 8 hex chars; matches the token format web issues.
const TOKEN_PATTERN = /olp_[0-9a-f]{8,}/gi

/** An error carrying a `web` error envelope through to the model. */
export class OverleafApiError extends Error {
  /**
   * @param {string} code one of CODES
   * @param {string} message safe, already-sanitised text
   * @param {number} status the upstream HTTP status
   */
  constructor(code, message, status) {
    super(message)
    this.name = 'OverleafApiError'
    this.code = code
    this.status = status
  }
}

/**
 * Map an upstream HTTP status onto the documented error code. `web` sends the
 * code explicitly; this is the fallback for responses that carry no envelope.
 *
 * @param {number} status
 * @returns {string}
 */
export function codeForStatus(status) {
  return STATUS_TO_CODE.get(status) ?? CODES.UPSTREAM_ERROR
}

/**
 * Strip anything the model must never see: the internal base URL, bearer
 * tokens, and stack traces.
 *
 * @param {string} message
 * @param {string} internalUrl
 * @returns {string}
 */
export function sanitiseMessage(message, internalUrl) {
  let safe = String(message ?? '').split('\n')[0].trim()
  if (internalUrl) {
    safe = safe.split(internalUrl).join('[overleaf]')
    try {
      const { host } = new URL(internalUrl)
      safe = safe.split(host).join('[overleaf]')
    } catch {
      // internalUrl is not parseable; the literal replacement above still ran
    }
  }
  return safe.replace(TOKEN_PATTERN, '[redacted]')
}

/**
 * Convert any thrown error into an MCP tool error result. The `web` error code
 * is preserved verbatim in the JSON payload so the model can branch on it.
 *
 * @param {unknown} err
 * @returns {{ isError: true, content: { type: 'text', text: string }[] }}
 */
export function toToolError(err) {
  const isApiError = err instanceof OverleafApiError
  const payload = {
    code: isApiError ? err.code : CODES.UPSTREAM_ERROR,
    message: isApiError ? err.message : 'the Overleaf API request failed',
  }
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  }
}
