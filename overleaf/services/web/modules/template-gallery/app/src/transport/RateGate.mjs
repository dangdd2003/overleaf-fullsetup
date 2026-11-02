// Outbound routing and pacing for every request the gallery makes upstream.
//
// A route is one way out: each enabled proxy (egress/EgressSettings.mjs), or
// the direct connection when no proxy is enabled. Requests to www.overleaf.com
// start at a fixed pace per route (fetchRpm a minute), so N proxies give N
// times the rate. S3 and Algolia are not paced.
//
// When upstream blocks a route (overleaf.com answers a plain 403 page, about
// 5 minutes long; 429/503 or Retry-After elsewhere) only that route pauses
// until the block ends; the request moves to the next free route at once. A
// route whose proxy or connection fails rests for a minute the same way.
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
// A route whose proxy or connection failed rests this long
const ROUTE_REST_MS = MINUTE
// An interactive caller does not wait longer than this for a paced start
const INTERACTIVE_MAX_WAIT_MS = 10 * SECOND

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
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
])

export function isTransientCode(code) {
  return typeof code === 'string' && TRANSIENT.has(code)
}

export function isTransientError(err) {
  return isTransientCode(err?.code)
}

/** True for an upstream block answer: the route was refused, not the item. */
export function isThrottledError(err) {
  return err?.hostThrottled === true
}

/** Requests a minute per route to www.overleaf.com. */
export function fetchRpm() {
  return (
    parseFetchRpm(Settings.templateGalleryFetchRpm) ??
    DEFAULTS.outbound.fetchRpm
  )
}

// hostKey -> Map(routeId -> state)
const routes = new Map()

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
    inFlight: 0,
    ok: 0,
    failed: 0,
    lastStatus: null,
    lastError: null,
    lastSuccessAt: null,
  }
}

// Routes follow the proxy settings on every call. Direct is used when no
// proxy is enabled, or when a caller pins it (e.g. a session bound to our IP).
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

function isRouteFailure(err) {
  const code = err?.code
  return (
    err?.message === 'socket hang up' ||
    (typeof code === 'string' &&
      (code.startsWith('EPROXY_') || NETWORK_CODES.has(code)))
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
      reject(signal.reason instanceof Error ? signal.reason : codedError('ABORT_ERR', 'request aborted', { name: 'AbortError' }))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

function noRouteError(hostKey, list, lastErr) {
  if (lastErr) return lastErr
  const now = Date.now()
  const waits = list
    .map(route => Math.max(route.blockedUntil, route.restUntil))
    .filter(at => at > now)
  if (waits.length === 0) return codedError('no_route', 'no outbound route')
  return codedError('host_backoff', `${hostKey} is blocking every route`, {
    hostKey,
    retryAt: new Date(Math.min(...waits)),
  })
}

/**
 * Runs fn({ egress }) on a free route for hostKey ('overleaf' | 's3' |
 * 'algolia'); pass egress to GuardedHttps. For overleaf the start waits for
 * the route's next paced slot. A blocked or failing route is set aside and the
 * call moves to the next route; it rejects when no route is left.
 *
 * @param {string} hostKey
 * @param {{ priority?: 'interactive'|'background', signal?: AbortSignal, egress?: string }} [opts]
 * @param {({ egress: object|null }) => Promise<any>} fn
 */
export async function withHostSlot(hostKey, opts, fn) {
  const host = HOSTS[hostKey]
  const interval = host?.paced ? Math.ceil(MINUTE / fetchRpm()) : 0
  const interactive = opts?.priority === 'interactive'
  const tried = new Set()
  let lastErr = null

  for (;;) {
    if (opts?.signal?.aborted) throw codedError('ABORT_ERR', 'request aborted', { name: 'AbortError' })
    const now = Date.now()
    const list = routesFor(hostKey, opts?.egress).filter(route =>
      opts?.egress ? route.id === opts.egress : true
    )
    const free = list.filter(route => !tried.has(route.id) && usable(route, now))
    if (free.length === 0) throw noRouteError(hostKey, list, lastErr)

    // The route whose next paced slot comes first
    const route = free.reduce((best, r) => (r.nextAt < best.nextAt ? r : best))
    const startAt = Math.max(now, route.nextAt)
    if (interactive && startAt - now > INTERACTIVE_MAX_WAIT_MS) {
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
        route.restUntil = Date.now() + ROUTE_REST_MS
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

