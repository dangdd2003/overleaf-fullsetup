// Outbound routing and pacing for every request the gallery makes upstream.
//
// A route is one way out: each enabled proxy (egress/EgressSettings.mjs), or
// the direct connection when no proxy is enabled. Requests to www.overleaf.com
// start at a fixed pace per route (fetchRpm a minute), so N proxies give N
// times the rate. S3 and Algolia are not paced.
//
// When upstream blocks a route (overleaf.com answers a plain 403 page, about
// 5 minutes long; 429/503 or Retry-After elsewhere) only that route pauses
// until the block ends; the request moves to the next free route at once.
// A route whose proxy or connection fails (a "route failure": proxy errors,
// connection resets, timeouts, DNS failures, TLS errors through a tunnel, gateway
// 502/504) rests briefly after one failure and for a minute after two in a row.
// The request then retries on another route, a bounded number of times with a
// short jittered pause. A route failure is flagged `routeFailure`: it says
// nothing about the item, so callers must not count it against the item.
// Callers are refused only when no route is left.

import Settings from '@overleaf/settings'
import * as EgressSettings from '../egress/EgressSettings.mjs'
import { DEFAULTS, parseFetchRpm } from '../TemplateGalleryDefaults.mjs'
import { OUTBOUND_BLOCKED } from './GuardedHttps.mjs'
import { logWarn } from '../observability/Log.mjs'

const SECOND = 1000
const MINUTE = 60 * SECOND

const DIRECT_ROUTE_ID = 'direct'
const HOSTS = Object.freeze({
  overleaf: { paced: true, blockStatuses: [403, 429, 503], blockMs: 5 * MINUTE },
  s3: { paced: false, blockStatuses: [429, 503], blockMs: MINUTE },
  algolia: { paced: false, blockStatuses: [429, 503], blockMs: MINUTE },
})
// A route rests this long after its second failure in a row
const ROUTE_REST_MS = MINUTE
// ...and this briefly after its first, so one reset does not take it out
const ROUTE_FIRST_REST_MS = 5 * SECOND
// Longest a caller waits for a paced slot, by priority. Background sync
// queues behind other background work, so interactive callers do not wait
// long; an admin refetch is worth a longer wait than a public page view.
const MAX_WAIT_MS = Object.freeze({
  background: 5 * SECOND,
  interactive: 10 * SECOND,
  admin: MINUTE,
})
// A call tries at most this many routes that failed, then gives up
const MAX_ROUTE_ATTEMPTS = 3
const RETRY_JITTER_MS = 500

// Codes that mean "not available right now" rather than "this item is bad".
export const TRANSIENT_ERROR_CODES = Object.freeze([
  'host_backoff',
  'host_busy',
  'no_route',
  OUTBOUND_BLOCKED,
  'EPROXY_UNREACHABLE',
  'EPROXY_AUTH',
  'EPROXY_CONNECT',
  'EPROXY_PROTOCOL',
])
const TRANSIENT = new Set(TRANSIENT_ERROR_CODES)
const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EAI_FAIL',
  'ENOTFOUND',
  'ENODATA',
  'ESERVFAIL',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'EPROTO',
  // Refused by the local address check: for a route this is a bad resolver
  // answer (for instance a fake-IP DNS), not a fact about the item.
  'EADDRBLOCKED',
  'ERR_STREAM_PREMATURE_CLOSE',
])
// TLS and HTTP parser errors that come from the tunnel or the proxy
const TLS_OR_PARSER_CODE = /^(ERR_TLS|ERR_SSL|ERR_SOCKET|ERR_HTTP|HPE_|CERT_|UNABLE_TO_|SELF_SIGNED|DEPTH_ZERO)/
const TLS_OR_PARSER_MESSAGES = Object.freeze([
  'socket hang up',
  'Client network socket disconnected',
])
// Gateway answers from a proxy or CDN in front of overleaf.com. A plain 500
// is left alone: it can be the item's own fault.
const GATEWAY_STATUSES = new Set([502, 504, 520, 521, 522, 523, 524, 525, 526])

const routes = new Map()

export function isTransientCode(code) {
  return typeof code === 'string' && TRANSIENT.has(code)
}

/**
 * True for a refusal that says nothing about the item: a code in the transient
 * list, a route failure, or an upstream block.
 */
export function isTransientError(err) {
  return (
    isTransientCode(err?.code) ||
    isRouteFailure(err) ||
    isThrottledError(err)
  )
}

/** True for an upstream block answer: the route was refused, not the item. */
export function isThrottledError(err) {
  return err?.hostThrottled === true
}

/**
 * True when the failure belongs to the route that carried the request (proxy,
 * connection, DNS on this server, TLS through a tunnel), so another route may
 * succeed. withHostSlot sets `routeFailure` on the error it finally throws.
 */
export function isRouteFailure(err) {
  if (err?.routeFailure === true) return true
  const code = err?.code
  if (typeof code === 'string') {
    if (code.startsWith('EPROXY_')) return true
    if (NETWORK_CODES.has(code) || TLS_OR_PARSER_CODE.test(code)) return true
  }
  if (TLS_OR_PARSER_MESSAGES.includes(err?.message)) return true
  return GATEWAY_STATUSES.has(statusOf(err))
}

/** Requests a minute per route to www.overleaf.com. */
export function fetchRpm() {
  return (
    parseFetchRpm(Settings.templateGalleryFetchRpm) ??
    DEFAULTS.outbound.fetchRpm
  )
}

// hostKey -> Map(routeId -> state)

function codedError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code }, extra)
}

function newRoute(id, egress) {
  return {
    id,
    egress,
    nextAt: 0,
    blockedUntil: 0,
    restUntil: 0,
    streak: 0,
    inFlight: 0,
    ok: 0,
    failed: 0,
    lastStatus: null,
    lastError: null,
    lastSuccessAt: null,
  }
}

// Routes follow the proxy settings on every call. Direct is used when no
// proxy is enabled, or when a caller pins it (a session bound to our IP).
function routesFor(hostKey, pinned = null) {
  if (!HOSTS[hostKey]) throw new Error(`unknown host key: ${hostKey}`)
  const { egresses } = EgressSettings.snapshot()
  const wanted = new Map(egresses.map(egress => [egress.id, egress]))
  if (egresses.length === 0 || pinned === DIRECT_ROUTE_ID) {
    wanted.set(DIRECT_ROUTE_ID, null)
  }
  let table = routes.get(hostKey)
  if (!table) routes.set(hostKey, (table = new Map()))
  for (const [id, egress] of wanted) {
    const route = table.get(id)
    if (route) route.egress = egress
    else table.set(id, newRoute(id, egress))
  }
  for (const [id, route] of table) {
    if (!wanted.has(id) && route.inFlight === 0) table.delete(id)
  }
  return [...table.values()].filter(route => wanted.has(route.id))
}

function usable(route, now) {
  return now >= route.blockedUntil && now >= route.restUntil
}

function statusOf(err) {
  return Number(err?.status || err?.statusCode) || null
}

function retryAfterMs(err) {
  return Number.isFinite(err?.retryAfterMs) ? Math.max(0, err.retryAfterMs) : null
}

function isBlock(hostKey, err) {
  return (
    HOSTS[hostKey].blockStatuses.includes(statusOf(err)) ||
    retryAfterMs(err) != null
  )
}

function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms)
    timer.unref?.()
    function done() {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }
    function onAbort() {
      clearTimeout(timer)
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : codedError('ABORT_ERR', 'request aborted', { name: 'AbortError' })
      )
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

function abortError() {
  return codedError('ABORT_ERR', 'request aborted', { name: 'AbortError' })
}

// How long to wait before picking a route again, or null to give up now. A
// caller waits only for a failed route to come back (or a resting one, when it
// has not tried anything yet), within its own wait cap and attempt budget.
function retryDelayMs(list, lastErr, attempts, capMs, now) {
  if (list.length === 0) return null
  if (lastErr && (!isRouteFailure(lastErr) || attempts >= MAX_ROUTE_ATTEMPTS)) {
    return null
  }
  const soonest = Math.min(
    ...list.map(route => Math.max(now, route.blockedUntil, route.restUntil))
  )
  const wait = soonest - now
  return wait <= capMs ? wait : null
}

function noRouteError(hostKey, list, lastErr) {
  if (lastErr) return lastErr
  const now = Date.now()
  const waits = list
    .map(route => Math.max(route.blockedUntil, route.restUntil))
    .filter(at => at > now)
  if (waits.length === 0) return codedError('no_route', 'no outbound route')
  // blocked: upstream refused the routes; otherwise they are resting after failures
  const blocked = list.some(route => route.blockedUntil > now)
  return codedError('host_backoff', `${hostKey} has no usable route right now`, {
    hostKey,
    blocked,
    retryAt: new Date(Math.min(...waits)),
  })
}

/**
 * Runs fn({ egress }) on a free route for hostKey ('overleaf' | 's3' |
 * 'algolia'); pass egress to GuardedHttps. For overleaf the start waits for
 * the route's next paced slot. A blocked route is set aside for the block and a
 * failing route for a short rest; the call moves to the next route at once.
 * When every route is down it waits briefly for one to come back (bounded by
 * the priority's wait cap), then rejects with the last error, flagged
 * `routeFailure` when the cause was the route rather than the item.
 *
 * @param {string} hostKey
 * @param {{ priority?: 'background'|'interactive'|'admin', signal?: AbortSignal, egress?: string }} [opts]
 * @param {({ egress: object|null }) => Promise<any>} fn
 */
export async function withHostSlot(hostKey, opts, fn) {
  const host = HOSTS[hostKey]
  if (!host) throw new Error(`unknown host key: ${hostKey}`)
  // A proxy list read from the database must be current before routing: a
  // fresh process or a proxy saved elsewhere would otherwise route direct.
  await EgressSettings.ensureLoaded?.()
  const interval = host.paced ? Math.ceil(MINUTE / fetchRpm()) : 0
  const priority = Object.hasOwn(MAX_WAIT_MS, opts?.priority) ? opts.priority : 'background'
  const interactive = priority !== 'background'
  const maxWaitMs = MAX_WAIT_MS[priority]
  const tried = new Set()
  let lastErr = null
  let attempts = 0

  for (;;) {
    if (opts?.signal?.aborted) throw abortError()
    const now = Date.now()
    const list = routesFor(hostKey, opts?.egress).filter(route =>
      opts?.egress ? route.id === opts.egress : true
    )
    const free = list.filter(route => !tried.has(route.id) && usable(route, now))
    if (free.length === 0) {
      const delay = retryDelayMs(list, lastErr, attempts, maxWaitMs, now)
      if (delay == null || opts?.egress) {
        throw noRouteError(hostKey, list, lastErr)
      }
      // Jitter spreads the retries of parallel callers apart
      await sleep(delay + Math.floor(Math.random() * RETRY_JITTER_MS), opts?.signal)
      tried.clear()
      continue
    }

    // The route whose next paced slot comes first
    const route = free.reduce((best, r) => (r.nextAt < best.nextAt ? r : best))
    const startAt = Math.max(now, route.nextAt)
    if (interactive && startAt - now > maxWaitMs) {
      throw codedError('host_busy', `${hostKey} has no free slot`, { hostKey })
    }
    route.nextAt = startAt + interval
    await sleep(startAt - now, opts?.signal)
    // Blocked while we waited: pick again
    if (!usable(route, Date.now())) continue

    route.inFlight++
    try {
      const result = await fn({ egress: route.egress })
      route.ok++
      route.streak = 0
      route.lastStatus = Number(result?.status) || null
      route.lastError = null
      route.lastSuccessAt = new Date()
      return result
    } catch (err) {
      route.failed++
      route.lastStatus = statusOf(err)
      route.lastError = String(err?.message || err).slice(0, 300)
      if (opts?.signal?.aborted) throw err
      if (isBlock(hostKey, err)) {
        err.hostThrottled = true
        const until = Date.now() + Math.max(host.blockMs, retryAfterMs(err) ?? 0)
        if (until > route.blockedUntil) {
          route.blockedUntil = until
          logWarn('route_blocked', {
            host: hostKey,
            route: route.id,
            status: statusOf(err),
            until: new Date(until),
          })
        }
      } else if (isRouteFailure(err)) {
        route.streak++
        const restMs = route.streak >= 2 ? ROUTE_REST_MS : ROUTE_FIRST_REST_MS
        route.restUntil = Math.max(route.restUntil, Date.now() + restMs)
        err.routeFailure = true
        attempts++
        logWarn('route_failed', {
          host: hostKey,
          route: route.id,
          code: err?.code ?? null,
          status: statusOf(err),
          streak: route.streak,
        })
      } else {
        throw err
      }
      tried.add(route.id)
      lastErr = err
      // A pinned call has nowhere else to go
      if (opts?.egress) throw err
    } finally {
      route.inFlight--
    }
  }
}

/** Routes of hostKey that can take work now. */
export function freeRoutes(hostKey) {
  const now = Date.now()
  return routesFor(hostKey).filter(route => usable(route, now)).length
}

/** All routes of hostKey, usable or not. */
export function routeCount(hostKey) {
  return routesFor(hostKey).length
}

/** Earliest time a blocked or resting route of hostKey is free again, or null. */
export function earliestReadyAt(hostKey) {
  const now = Date.now()
  const waits = routesFor(hostKey)
    .map(route => Math.max(route.blockedUntil, route.restUntil))
    .filter(at => at > now)
  return waits.length ? new Date(Math.min(...waits)) : null
}

/** True when every route of hostKey is blocked by upstream right now. */
export function isThrottling(hostKey) {
  const now = Date.now()
  const list = routesFor(hostKey)
  return list.length > 0 && list.every(route => route.blockedUntil > now)
}

/** Snapshot per host for the admin status API. */
export function getHostStatus() {
  const now = Date.now()
  const status = {}
  for (const hostKey of Object.keys(HOSTS)) {
    const list = [...(routes.get(hostKey)?.values() || [])]
    status[hostKey] = {
      maxPerMinute: HOSTS[hostKey].paced ? fetchRpm() : null,
      inFlight: list.reduce((sum, route) => sum + route.inFlight, 0),
      routes: list.map(route => ({
        id: route.id,
        inFlight: route.inFlight,
        blockedUntil: route.blockedUntil > now ? new Date(route.blockedUntil) : null,
        restUntil: route.restUntil > now ? new Date(route.restUntil) : null,
        lastStatus: route.lastStatus,
        lastError: route.lastError,
        lastSuccessAt: route.lastSuccessAt,
        ok: route.ok,
        failed: route.failed,
      })),
    }
  }
  return status
}

/** Drops all route state. Tests only. */
export function resetRateGateForTests() {
  routes.clear()
}
