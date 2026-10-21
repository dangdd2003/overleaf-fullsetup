import { compactJson, lines } from './format.js'

export const CODES = Object.freeze({
  UNAUTHORIZED: 'unauthorized',
  INSUFFICIENT_SCOPE: 'insufficient_scope',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  VALIDATION_ERROR: 'validation_error',
  RATE_LIMITED: 'rate_limited',
  UPSTREAM_ERROR: 'upstream_error',
  CONFLICT: 'conflict',
  COMPILE_FAILED: 'compile_failed',
  OUTPUT_TOO_LARGE: 'output_too_large',
})

/**
 * Recovery guidance attached to every error of a given code.
 *
 * The model reads `hint` to pick its next call, so each one names a concrete
 * tool or action rather than restating the failure.
 */
const DEFAULT_HINTS = Object.freeze({
  [CODES.UNAUTHORIZED]:
    'The Overleaf connection is not authenticated. Ask the user to reconnect the Overleaf MCP server; do not retry.',
  [CODES.INSUFFICIENT_SCOPE]:
    'The token lacks the scope this tool needs. Ask the user to reconnect and grant the missing permission.',
  [CODES.FORBIDDEN]:
    'You do not have permission for this project or action (it may be read-only for you). Use get_project to check your access level.',
  [CODES.NOT_FOUND]:
    'Check the id or path. Use list_projects for project ids and list_files for exact file paths.',
  [CODES.VALIDATION_ERROR]:
    'Fix the arguments described in the message and call the tool again.',
  [CODES.RATE_LIMITED]: 'Wait a few seconds, then retry the same call.',
  [CODES.UPSTREAM_ERROR]:
    'Overleaf failed to complete the request. Retry once; if it fails again, report the error to the user.',
  [CODES.CONFLICT]:
    'The target already exists or changed underneath you. Re-read the current state, then retry.',
  [CODES.COMPILE_FAILED]:
    'Read the errors array, fix the reported lines with edit_file, then call compile_project again.',
  [CODES.OUTPUT_TOO_LARGE]:
    'This output is larger than the MCP service returns. Do not retry; tell the user to download it from Overleaf directly.',
})

const RETRYABLE = new Set([CODES.RATE_LIMITED, CODES.UPSTREAM_ERROR])

const STATUS_TO_CODE = new Map([
  [400, CODES.VALIDATION_ERROR],
  [401, CODES.UNAUTHORIZED],
  [403, CODES.FORBIDDEN],
  [404, CODES.NOT_FOUND],
  [409, CODES.CONFLICT],
  [413, CODES.OUTPUT_TOO_LARGE],
  [429, CODES.RATE_LIMITED],
])

// olp_ + at least 8 hex chars; matches the token format web issues.
const TOKEN_PATTERN = /olp_[0-9a-f]{8,}/gi
// Compact JWS (header.payload.signature) with base64url segments.
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}/g

/** An error carrying a `web` error envelope through to the model. */
export class OverleafApiError extends Error {
  /**
   * @param {string} code one of CODES
   * @param {string} message safe, already-sanitised text
   * @param {number} status the upstream HTTP status
   * @param {{ hint?: string, details?: object }} [extra] tool-specific recovery
   *   guidance and machine-readable context, both shown to the model
   */
  constructor(code, message, status, extra = {}) {
    super(message)
    this.name = 'OverleafApiError'
    this.code = code
    this.status = status
    this.hint = extra.hint
    this.details = extra.details
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
  return safe.replace(TOKEN_PATTERN, '[redacted]').replace(JWT_PATTERN, '[redacted]')
}

/**
 * Build the error half of the shared tool envelope.
 *
 * Every tool failure reads the same way to the model:
 * `{ ok: false, error: { code, message, hint, retryable, details? } }`.
 *
 * @param {string} code one of CODES
 * @param {string} message
 * @param {{ hint?: string, details?: object }} [extra]
 */
export function errorEnvelope(code, message, extra = {}) {
  const error = {
    code,
    message,
    hint: extra.hint || DEFAULT_HINTS[code] || DEFAULT_HINTS[CODES.UPSTREAM_ERROR],
    retryable: RETRYABLE.has(code),
  }
  if (extra.details && typeof extra.details === 'object') {
    error.details = extra.details
  }
  return { ok: false, error }
}

/**
 * The error envelope as the compact text a model reads:
 *
 *   error <code>: <message>
 *   hint: <hint>
 *   details: <single-line JSON>   (only when there are details)
 *   retryable                      (only when retrying unchanged can work)
 *
 * @param {ReturnType<typeof errorEnvelope>} payload
 */
function errorText({ error }) {
  return lines(
    `error ${error.code}: ${error.message}`,
    `hint: ${error.hint}`,
    error.details && `details: ${compactJson(error.details)}`,
    error.retryable && 'retryable'
  )
}

/**
 * Convert any thrown error into an MCP tool error result. The `web` error code
 * is preserved verbatim so the model can branch on it, and a recovery hint
 * tells it which call to make next. `structuredContent` carries the full
 * envelope; the text block is its compact rendering.
 *
 * @param {unknown} err
 * @returns {{ isError: true, content: { type: 'text', text: string }[], structuredContent: object }}
 */
export function toToolError(err) {
  const isApiError = err instanceof OverleafApiError
  const payload = isApiError
    ? errorEnvelope(err.code, err.message, { hint: err.hint, details: err.details })
    : errorEnvelope(CODES.UPSTREAM_ERROR, 'the Overleaf API request failed')
  return {
    isError: true,
    content: [{ type: 'text', text: errorText(payload) }],
    structuredContent: payload,
  }
}
