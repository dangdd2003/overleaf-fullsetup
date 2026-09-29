import { ProviderError } from '../AiAssistProviders.mjs'

/** Shared by the web tools: errors for the model, and small text helpers. */

export const HOUR_MS = 60 * 60 * 1000

/**
 * `kind` says whether another route to the same page could succeed: a page
 * that refused us or timed out might be readable from an archive, a PDF or a
 * private address never is.
 */
export function webError(message, { status, hint, kind = 'content' } = {}) {
  const error = new ProviderError(message, {
    code: 'webToolError',
    status,
    hint,
  })
  error.kind = kind
  return error
}

export function describeStatus(status) {
  if (status === 401 || status === 403 || status === 451) {
    return 'the site refuses automated readers'
  }
  if (status === 404 || status === 410) return 'the page does not exist'
  if (status === 429) return 'the site is rate-limiting requests'
  if (status >= 500) return 'the site had a server error'
  return ''
}

export function collapse(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function clip(text, max) {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

export function clampInt(value, min, max, fallback) {
  const parsed = typeof value === 'string' ? Number(value.trim()) : value
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

/** `YYYY-MM-DD` for anything Date can parse, else ''. */
export function isoDay(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  const raw = typeof value === 'string' ? value.trim() : value
  if (!raw) return ''
  // Wayback timestamps: 20260407153000
  const stamp = /^(\d{4})(\d{2})(\d{2})\d{0,6}$/.exec(String(raw))
  const date = stamp
    ? new Date(`${stamp[1]}-${stamp[2]}-${stamp[3]}T00:00:00Z`)
    : new Date(raw)
  if (Number.isNaN(date.getTime())) return ''
  const year = date.getUTCFullYear()
  if (year < 1990 || year > 2200) return ''
  return date.toISOString().slice(0, 10)
}
