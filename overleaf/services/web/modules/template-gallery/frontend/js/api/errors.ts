import type { TFunction } from 'i18next'
import { formatDate } from '@/utils/dates'
import type { DetailsRefetchResult } from './types'

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

// Message for a refetch that did not succeed. The server names the reason
// (a route that failed, an upstream block, the item itself); each reason has
// its own translated text, and an unknown or missing one falls back to the
// given key.
export function refetchReasonMessage(
  t: TFunction,
  reason: string | null | undefined,
  fallbackKey: string
): string {
  const fallback = t(fallbackKey)
  if (!reason) return fallback
  return t(`template_gallery_admin_refetch_reason_${reason}`, {
    defaultValue: fallback,
  })
}

// Include the outcome of a failed refresh and when another sync may try it.
// A retry timestamp is eligibility, not a promise that automatic sync is on.
export function detailsRefetchFailureMessage(
  t: TFunction,
  result: DetailsRefetchResult
): string {
  const messages = [
    refetchReasonMessage(
      t,
      result.reason,
      'template_gallery_admin_error_hydration_failed'
    ),
  ]
  if (result.sync.hydratedAt) {
    messages.push(t('template_gallery_admin_cached_details_retained'))
  }
  const retryAt = result.retryAt || result.sync.nextAttemptAt
  if (retryAt && Number.isFinite(new Date(retryAt).getTime())) {
    messages.push(
      t('template_gallery_admin_details_retry_at', {
        date: formatDate(retryAt),
      })
    )
  }
  return messages.join(' ')
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
