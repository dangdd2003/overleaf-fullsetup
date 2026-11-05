// Why an admin refetch failed, as a code the admin UI translates (see
// frontend refetchReasonMessage). A problem with a route (proxy or connection)
// is told apart from an upstream block, from a refused target and from a
// problem with the item itself.
import { OUTBOUND_BLOCKED } from './GuardedHttps.mjs'
import {
  isRouteFailure,
  isThrottledError,
  isTransientCode,
} from './RateGate.mjs'

const SOURCE_UNAVAILABLE_CODES = new Set([
  'all_tiers_failed',
  'missing_main_text',
])

/**
 * @param {object|null} err - the thrown error, or { code } from a tier result
 * @returns {string}
 */
export function refetchReason(err) {
  const code = err?.code
  // A successful HTTP response may still contain a challenge, login or error
  // page. Keep these distinct from transport failures and layout mismatches.
  if (code === 'upstream_challenge') return 'challenge'
  if (code === 'upstream_login') return 'login_required'
  if (code === 'upstream_error_page') return 'upstream_error'
  if (
    isThrottledError(err) ||
    code === 'upstream_blocked' ||
    (code === 'host_backoff' && err?.blocked === true)
  ) {
    return 'blocked'
  }
  if (code === OUTBOUND_BLOCKED) return 'not_allowed'
  if (isRouteFailure(err) || isTransientCode(code)) return 'routes_unavailable'
  if (code === 'timeout') return 'timeout'
  if (code === 'detail_unparseable') return 'unparseable'
  if (code === 'session_unauthorized') return 'session_rejected'
  if (SOURCE_UNAVAILABLE_CODES.has(code)) return 'source_unavailable'
  if (code === 'unexpected_status' || Number(err?.status)) {
    return 'upstream_status'
  }
  return 'failed'
}
