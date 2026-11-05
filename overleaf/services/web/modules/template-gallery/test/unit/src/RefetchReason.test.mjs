import { describe, it, expect } from 'vitest'
import { refetchReason } from '../../../app/src/transport/RefetchReason.mjs'
import { OUTBOUND_BLOCKED } from '../../../app/src/transport/GuardedHttps.mjs'

function coded(code, extra = {}) {
  return Object.assign(new Error(code), { code }, extra)
}

describe('refetchReason', () => {
  it('names a route problem, so the admin checks the proxies', () => {
    const routeErr = coded('ECONNRESET', { routeFailure: true })
    expect(refetchReason(routeErr)).toBe('routes_unavailable')
    expect(refetchReason(coded('EPROXY_CONNECT'))).toBe('routes_unavailable')
    expect(refetchReason(coded('host_busy'))).toBe('routes_unavailable')
    expect(refetchReason(coded('no_route'))).toBe('routes_unavailable')
    expect(refetchReason(coded('EAI_AGAIN'))).toBe('routes_unavailable')
  })

  it('tells an upstream block from a route problem', () => {
    expect(
      refetchReason(coded('EHTTP_403', { status: 403, hostThrottled: true }))
    ).toBe('blocked')
    expect(refetchReason(coded('upstream_blocked'))).toBe('blocked')
    expect(refetchReason(coded('host_backoff', { blocked: true }))).toBe(
      'blocked'
    )
    expect(refetchReason(coded('host_backoff', { blocked: false }))).toBe(
      'routes_unavailable'
    )
  })

  it('reports a refused target as not allowed', () => {
    expect(refetchReason(coded(OUTBOUND_BLOCKED))).toBe('not_allowed')
  })

  it('keeps HTTP 200 interstitials distinct from layout and transport errors', () => {
    expect(
      refetchReason(
        coded('upstream_challenge', { status: 403, hostThrottled: true })
      )
    ).toBe('challenge')
    expect(refetchReason(coded('upstream_login', { status: 401 }))).toBe(
      'login_required'
    )
    expect(refetchReason(coded('upstream_error_page', { status: 500 }))).toBe(
      'upstream_error'
    )
  })

  it('maps item and source outcomes', () => {
    expect(refetchReason(coded('timeout'))).toBe('timeout')
    expect(refetchReason(coded('detail_unparseable'))).toBe('unparseable')
    expect(refetchReason(coded('session_unauthorized'))).toBe(
      'session_rejected'
    )
    expect(refetchReason({ code: 'all_tiers_failed' })).toBe(
      'source_unavailable'
    )
    expect(refetchReason({ code: 'missing_main_text' })).toBe(
      'source_unavailable'
    )
    expect(refetchReason(coded('EHTTP_404', { status: 404 }))).toBe(
      'upstream_status'
    )
    expect(refetchReason(coded('unexpected_status'))).toBe('upstream_status')
  })

  it('falls back to a generic failure', () => {
    expect(refetchReason(null)).toBe('failed')
    expect(refetchReason(coded('something_else'))).toBe('failed')
  })
})
