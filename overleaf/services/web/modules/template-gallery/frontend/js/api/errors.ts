import type { TFunction } from 'i18next'

const GENERIC_KEY = 'template_gallery_admin_error_generic'
const LOGIN_REQUIRED_KEY = 'template_gallery_admin_error_login_required'

export class TemplateAdminApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly details: Record<string, unknown>,
    message?: string
  ) {
    super(message || code)
    this.name = 'TemplateAdminApiError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Builds the error for a response body in the flat envelope
// { error, message?, details? } that AdminController.sendError writes.
export function parseErrorBody(
  status: number,
  body: unknown
): TemplateAdminApiError {
  const payload = isRecord(body) ? body : {}
  const code =
    typeof payload.error === 'string' && payload.error
      ? payload.error
      : status >= 500
        ? 'internal_error'
        : 'generic'
  const details: Record<string, unknown> = isRecord(payload.details)
    ? { ...payload.details }
    : {}
  const message =
    typeof payload.message === 'string' ? payload.message : undefined
  return new TemplateAdminApiError(status, code, details, message)
}

// Wraps anything thrown by the client (including network failures) so that
// hooks can expose a single error type.
export function toTemplateAdminApiError(err: unknown): TemplateAdminApiError {
  if (err instanceof TemplateAdminApiError) {
    return err
  }
  return new TemplateAdminApiError(
    0,
    'generic',
    {},
    err instanceof Error ? err.message : undefined
  )
}

// Server messages are never shown raw: the UI only displays translated text
// for the code, and falls back to the generic message for unknown codes.
export function errorMessage(t: TFunction, err: unknown): string {
  const generic = t(GENERIC_KEY)
  if (!(err instanceof TemplateAdminApiError)) {
    return generic
  }
  const key =
    err.status === 401
      ? LOGIN_REQUIRED_KEY
      : `template_gallery_admin_error_${err.code}`
  return t(key, { defaultValue: generic })
}
