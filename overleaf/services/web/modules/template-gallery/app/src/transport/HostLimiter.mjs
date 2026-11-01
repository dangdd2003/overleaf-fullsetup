// Concurrency and rate limits for every outbound request the gallery mirror makes.
//
// Each upstream host runs up to `maxInFlight` requests at once. Background
// work (the mirror sync) never takes the last `reservedInteractive` slots, so
// a user waiting on a page always gets a slot quickly. Interactive work runs
// before queued background work.
//
// Starts are spaced by an adaptive interval: it doubles (up to maxIntervalMs)
// whenever the host throttles us and shrinks back towards minIntervalMs while
// requests succeed, so the rate settles just below what the host accepts.
// For overleaf.com the floor comes from the request budget (fetchRpm, per
// lane): requests run in parallel, but no lane ever starts more than that many
// a minute. Lanes start at the budget, which is already conservative.
// Throttling (429/503, Retry-After, and overleaf.com's 403 block page) also
// pushes the host into backoff, and repeated failures open a circuit.
//
// Each host has one shared queue, and one or more lanes: the direct connection
// ('direct') and each enabled outbound proxy (see egress/EgressSettings.mjs).
// Every lane has its own slots, spacing, backoff and circuit, so a proxy that
// gets blocked does not slow the others down. A task starts on the best lane
// that is ready for it.

import Settings from '@overleaf/settings'
import { OUTBOUND_BLOCKED } from './GuardedHttps.mjs'
import * as EgressSettings from '../egress/EgressSettings.mjs'
import { DEFAULTS, parseFetchRpm } from '../TemplateGalleryDefaults.mjs'

const SECOND = 1000
const MINUTE = 60 * SECOND

const HOST_LIMITS = Object.freeze({
  overleaf: {
    // Slow requests (PDFs take up to minutes) overlap; the budget below, not
    // the slot count, sets the request rate
    maxInFlight: 6,
    reservedInteractive: 2,
    maxIntervalMs: 10_000,
    // overleaf.com answers a rate-limited client with a plain 403 page
    throttleStatuses: [403, 429, 503],
  },
  s3: { maxInFlight: 8, reservedInteractive: 2 },
  algolia: { maxInFlight: 4, reservedInteractive: 1 },
})
// The interval shrinks by SPEEDUP_FACTOR after every SPEEDUP_EVERY successes
const SPEEDUP_EVERY = 25
const SPEEDUP_FACTOR = 0.8
const DEFAULT_THROTTLE_STATUSES = [429, 503]
// A lane throttled this recently is the last choice for interactive work
const RECENT_THROTTLE_MS = 60 * SECOND
export const DIRECT_LANE_ID = 'direct'

export const BACKOFF_STEPS_MS = Object.freeze([
  30 * SECOND,
  2 * MINUTE,
  10 * MINUTE,
  60 * MINUTE,
])
export const CIRCUIT_FAILURE_THRESHOLD = 10
export const CIRCUIT_OPEN_MS = 10 * MINUTE

// An interactive caller never waits behind a backoff window longer than this;
// it gets a fast failure instead and the page renders without upstream data.
const INTERACTIVE_MAX_BACKOFF_WAIT_MS = 5 * SECOND

// Callers queued per host. When full, an interactive caller displaces the
// newest background task; anything else is refused with err.code 'host_busy'.
export const MAX_QUEUED_PER_HOST = 200
// Backstop for a task whose requests never settle. The request-level timeouts
// in GuardedHttps normally fire first; either way the lane is released.
export const TASK_TIMEOUT_MS = 5 * MINUTE

// Codes that mean "not available right now": the host is saturated, backing
// off, circuit-broken or stalled, or the request was refused before it was
// sent. None of them says anything about the item or session being asked for,
// so callers answer "try again later" instead of a 500 or a recorded failure.
export const TRANSIENT_ERROR_CODES = Object.freeze([
  'host_busy',
  'host_backoff',
  'host_task_timeout',
  'circuit_open',
  'limiter_reset',
  OUTBOUND_BLOCKED,
  'EPROXY_UNREACHABLE',
  'EPROXY_AUTH',
  'EPROXY_CONNECT',
  'EPROXY_PROTOCOL',
])
const TRANSIENT_CODE_SET = new Set(TRANSIENT_ERROR_CODES)

/**
 * @param {unknown} code
 * @returns {boolean}
 */
export function isTransientCode(code) {
  return typeof code === 'string' && TRANSIENT_CODE_SET.has(code)
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isTransientError(err) {
  return isTransientCode(/** @type {any} */ (err)?.code)
}

const PRIORITIES = Object.freeze(['interactive', 'background'])

// Network errors that come from the lane's own connection. Another lane may
// still reach the host, so the task can move there.
const LANE_NETWORK_CODES = Object.freeze([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EAI_AGAIN',
])

const hosts = new Map()

/**
 * Requests a minute each lane may send to overleaf.com:
 * TEMPLATE_GALLERY_FETCH_RPM when valid, else DEFAULTS.outbound.fetchRpm.
 */
export function fetchRpm() {
  return (
    parseFetchRpm(Settings.templateGalleryFetchRpm) ??
    DEFAULTS.outbound.fetchRpm
  )
}

function limitsFor(hostKey) {
  const limits = { ...HOST_LIMITS[hostKey] }
  if (hostKey === 'overleaf') {
    const intervalMs = Math.ceil(MINUTE / fetchRpm())
    limits.minIntervalMs = intervalMs
    limits.startIntervalMs = intervalMs
    limits.maxIntervalMs = Math.max(limits.maxIntervalMs, intervalMs)
  }
  return limits
}

function createHostState(hostKey) {
  return {
    hostKey,
    limits: limitsFor(hostKey),
    queues: { interactive: [], background: [] },
    lanes: new Map(),
    timer: null,
    totals: { rejected: 0, retries: 0 },
  }
}

function createLane(host, id, egress) {
  return {
    id,
    egress,
    limits: { ...host.limits },
    inFlight: { interactive: 0, background: 0 },
    intervalMs: host.limits.startIntervalMs ?? (host.limits.minIntervalMs || 0),
    nextStartAt: 0,
    successStreak: 0,
    lastStartAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
    lastStatus: null,
    lastThrottleAt: null,
    blockedUntil: 0,
    backoffLevel: 0,
    consecutiveFailures: 0,
    circuitOpenUntil: 0,
    totals: { ok: 0, failed: 0 },
  }
}

function getHost(hostKey) {
  if (!HOST_LIMITS[hostKey]) {
    throw new Error(`unknown host key: ${hostKey}`)
  }
  let host = hosts.get(hostKey)
  if (!host) {
    host = createHostState(hostKey)
    hosts.set(hostKey, host)
  }
  return host
}

function codedError(code, message, extra = {}) {
  const err = new Error(message)
  err.code = code
  Object.assign(err, extra)
  return err
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason
  return codedError('ABORT_ERR', 'request aborted', { name: 'AbortError' })
}

function circuitState(lane, now = Date.now()) {
  if (lane.circuitOpenUntil === 0) return 'closed'
  return now < lane.circuitOpenUntil ? 'open' : 'half_open'
}

function circuitOpenError(host, lane = null) {
  return codedError('circuit_open', `circuit open for ${host.hostKey}`, {
    hostKey: host.hostKey,
    retryAt: lane ? new Date(lane.circuitOpenUntil) : null,
  })
}

/**
 * Parses an HTTP Retry-After value (delta seconds or HTTP date) into ms.
 */
export function parseRetryAfterMs(value, now = Date.now()) {
  if (value == null || value === '') return null
  const raw = Array.isArray(value) ? value[0] : String(value).trim()
  if (/^\d+$/.test(raw)) return Number(raw) * SECOND
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return null
  return Math.max(0, at - now)
}

function statusOf(err) {
  return Number(err?.status || err?.statusCode) || null
}

function retryAfterOf(err) {
  if (Number.isFinite(err?.retryAfterMs)) return Math.max(0, err.retryAfterMs)
  const headers = err?.headers || err?.response?.headers
  return parseRetryAfterMs(headers?.['retry-after'])
}

// Throttling signals: the host asked us to slow down.
function isThrottle(lane, err) {
  const status = statusOf(err)
  const statuses = lane.limits.throttleStatuses || DEFAULT_THROTTLE_STATUSES
  return statuses.includes(status) || retryAfterOf(err) != null
}

/**
 * True for an error the host limiter classified as throttling: the host is
 * refusing us, not the item. Callers keep the item queued instead of failing it.
 */
export function isThrottledError(err) {
  return err?.hostThrottled === true
}

// Host health failures count towards the circuit breaker. A 404 (or a 403 on
// a host where 403 is not a throttle) is a healthy answer about a resource,
// so it resets the failure streak.
function isHostFailure(lane, err) {
  if (isThrottle(lane, err)) return true
  const status = statusOf(err)
  return status == null || status >= 500
}

// The failure belongs to the lane, not the item: the host throttled it, the
// proxy failed, or its connection broke. A resource answer (404, 410, parse
// errors) says nothing about the lane, so the task is not moved.
function isLaneFailure(err) {
  if (err?.hostThrottled === true) return true
  if (err?.message === 'socket hang up') return true
  const code = err?.code
  return (
    typeof code === 'string' &&
    (code.startsWith('EPROXY_') ||
      code === 'host_task_timeout' ||
      LANE_NETWORK_CODES.includes(code))
  )
}

// Whether a task that tried some lanes has an untried lane that can still
// serve it. A circuit-open lane counts as unable for now.
function canStillServe(host, task, now) {
  for (const lane of host.lanes.values()) {
    if (task.tried.has(lane.id)) continue
    if (circuitState(lane, now) === 'open') continue
    // An interactive task will not wait out a long backoff on that lane
    if (
      task.priority === 'interactive' &&
      lane.blockedUntil - now > INTERACTIVE_MAX_BACKOFF_WAIT_MS
    ) {
      continue
    }
    return true
  }
  return false
}

function rejectTask(host, task, err) {
  task.cleanup()
  host.totals.rejected++
  task.reject(err)
}

// A task that already failed on a lane rejects with that last error, so the
// caller sees the throttle or proxy failure rather than a limiter code.
function rejectQueued(host, makeError) {
  for (const priority of PRIORITIES) {
    const queue = host.queues[priority]
    while (queue.length > 0) {
      const task = queue.shift()
      rejectTask(host, task, makeError(task))
    }
  }
}

function queuedCount(host) {
  return host.queues.interactive.length + host.queues.background.length
}

function laneInFlight(lane) {
  return lane.inFlight.interactive + lane.inFlight.background
}

function inFlightCount(host) {
  let total = 0
  for (const lane of host.lanes.values()) total += laneInFlight(lane)
  return total
}

function queuedLaneIds(host) {
  const ids = new Set()
  for (const priority of PRIORITIES) {
    for (const task of host.queues[priority]) {
      if (task.laneId) ids.add(task.laneId)
    }
  }
  return ids
}

// Lanes follow the proxy settings. A lane stays while it has work in flight or
// queued, even after its proxy was switched off.
function syncLanes(host, pinnedIds = []) {
  const { useDirect, egresses } = EgressSettings.snapshot()
  const wanted = new Map()
  if (useDirect || pinnedIds.includes(DIRECT_LANE_ID)) {
    wanted.set(DIRECT_LANE_ID, null)
  }
  for (const egress of egresses) wanted.set(egress.id, egress)

  for (const [id, egress] of wanted) {
    const lane = host.lanes.get(id)
    if (lane) lane.egress = egress
    else host.lanes.set(id, createLane(host, id, egress))
  }

  const queued = queuedLaneIds(host)
  for (const [id, lane] of host.lanes) {
    if (wanted.has(id) || queued.has(id) || laneInFlight(lane) > 0) continue
    host.lanes.delete(id)
  }
}

function laneReady(lane, now) {
  return (
    now >= lane.blockedUntil &&
    now >= lane.nextStartAt &&
    circuitState(lane, now) !== 'open'
  )
}

// A lane can take a task when it has a free slot. Background work leaves the
// last reservedInteractive slots of each lane free for interactive callers.
function hasCapacity(lane, priority) {
  const { maxInFlight, reservedInteractive } = lane.limits
  if (laneInFlight(lane) >= maxInFlight) return false
  if (priority === 'interactive') return true
  const backgroundSlots = Math.max(1, maxInFlight - reservedInteractive)
  return lane.inFlight.background < backgroundSlots
}

// Lower is better: less loaded first, then no recent throttle, then direct
function compareLanes(a, b, now) {
  const ratioA = laneInFlight(a) / (a.limits.maxInFlight || 1)
  const ratioB = laneInFlight(b) / (b.limits.maxInFlight || 1)
  if (ratioA !== ratioB) return ratioA - ratioB
  const throttledA = isRecentlyThrottled(a, now) ? 1 : 0
  const throttledB = isRecentlyThrottled(b, now) ? 1 : 0
  if (throttledA !== throttledB) return throttledA - throttledB
  const directA = a.id === DIRECT_LANE_ID ? 0 : 1
  const directB = b.id === DIRECT_LANE_ID ? 0 : 1
  return directA - directB
}

function isRecentlyThrottled(lane, now) {
  return (
    lane.lastThrottleAt != null && now - lane.lastThrottleAt < RECENT_THROTTLE_MS
  )
}

// The best lane for a task, or null when none can start it now. A retried task
// skips the lanes it has already tried.
function pickLane(host, task, priority, now) {
  const candidates = task.laneId
    ? [host.lanes.get(task.laneId)].filter(Boolean)
    : [...host.lanes.values()].filter(lane => !task.tried.has(lane.id))
  let best = null
  for (const lane of candidates) {
    if (!laneReady(lane, now) || !hasCapacity(lane, priority)) continue
    if (!best || compareLanes(lane, best, now) < 0) best = lane
  }
  return best
}

// The next queued task that can start now, with the lane it will use
function takeTask(host, now) {
  for (const priority of PRIORITIES) {
    const queue = host.queues[priority]
    for (let index = 0; index < queue.length; index++) {
      const lane = pickLane(host, queue[index], priority, now)
      if (lane) {
        const [task] = queue.splice(index, 1)
        return { task, lane, priority }
      }
    }
  }
  return null
}

function schedulePump(host, delayMs) {
  if (host.timer) return
  host.timer = setTimeout(() => {
    host.timer = null
    pump(host)
  }, delayMs)
  host.timer.unref?.()
}

function recordSuccess(lane, result) {
  lane.totals.ok++
  lane.successStreak++
  if (lane.successStreak >= SPEEDUP_EVERY) {
    lane.successStreak = 0
    lane.intervalMs = Math.max(
      lane.limits.minIntervalMs || 0,
      Math.floor(lane.intervalMs * SPEEDUP_FACTOR)
    )
  }
  lane.lastSuccessAt = new Date()
  lane.lastStatus = Number(result?.status) || null
  lane.consecutiveFailures = 0
  lane.backoffLevel = 0
  lane.blockedUntil = 0
  lane.circuitOpenUntil = 0
}

function recordFailure(lane, err) {
  const now = Date.now()
  lane.totals.failed++
  lane.lastFailureAt = new Date(now)
  lane.lastError = String(err?.message || err).slice(0, 300)
  lane.lastStatus = statusOf(err)

  // Refused by the local allow-list before any request: the host was never asked.
  if (err?.code === OUTBOUND_BLOCKED) return

  if (!isHostFailure(lane, err)) {
    // The host answered; only the resource was unhappy.
    lane.consecutiveFailures = 0
    if (circuitState(lane, now) === 'half_open') lane.circuitOpenUntil = 0
    return
  }

  lane.consecutiveFailures++

  const throttled = isThrottle(lane, err)
  if (throttled && err && typeof err === 'object') err.hostThrottled = true
  if (throttled) lane.lastThrottleAt = now
  // Parallel requests hitting the same throttle count as one escalation
  if (throttled && now >= lane.blockedUntil) {
    lane.successStreak = 0
    lane.intervalMs = Math.min(
      lane.limits.maxIntervalMs || 0,
      Math.max(lane.intervalMs * 2, lane.limits.minIntervalMs || 0, 500)
    )
    const step =
      BACKOFF_STEPS_MS[Math.min(lane.backoffLevel, BACKOFF_STEPS_MS.length - 1)]
    const delay = Math.max(step, retryAfterOf(err) ?? 0)
    lane.blockedUntil = Math.max(lane.blockedUntil, now + delay)
    lane.backoffLevel = Math.min(lane.backoffLevel + 1, BACKOFF_STEPS_MS.length)
  }

  const wasHalfOpen = circuitState(lane, now) === 'half_open'
  if (wasHalfOpen || lane.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
    lane.circuitOpenUntil = now + CIRCUIT_OPEN_MS
  }
}

// Starts every queued task that has a ready lane, then arms a timer for the
// next lane that becomes ready. Tasks that can never run are rejected.
function pump(host) {
  if (host.timer) return
  syncLanes(host, queuedLaneIds(host))
  if (queuedCount(host) === 0) return

  const now = Date.now()
  if (host.lanes.size === 0) {
    rejectQueued(host, task =>
      task.lastErr ?? codedError('no_egress', 'no outbound route')
    )
    return
  }
  const lanes = [...host.lanes.values()]
  if (lanes.every(lane => circuitState(lane, now) === 'open')) {
    rejectQueued(host, task => task.lastErr ?? circuitOpenError(host))
    return
  }
  for (const priority of PRIORITIES) {
    const queue = host.queues[priority]
    for (let index = queue.length - 1; index >= 0; index--) {
      const task = queue[index]
      if (!task.laneId) {
        if (task.tried.size > 0 && !canStillServe(host, task, now)) {
          queue.splice(index, 1)
          rejectTask(host, task, task.lastErr)
        }
        continue
      }
      const lane = host.lanes.get(task.laneId)
      if (!lane) {
        queue.splice(index, 1)
        rejectTask(host, task, codedError('egress_unavailable', 'egress is gone'))
      } else if (circuitState(lane, now) === 'open') {
        queue.splice(index, 1)
        rejectTask(host, task, circuitOpenError(host, lane))
      }
    }
  }

  let next
  while ((next = takeTask(host, Date.now()))) {
    start(host, next.task, next.lane, next.priority)
  }

  if (queuedCount(host) === 0) return
  const wakeAt = nextWakeAt(host, Date.now())
  if (wakeAt !== null) schedulePump(host, wakeAt - Date.now())
}

// Earliest time a lane that is not circuit-open leaves its interval or backoff
function nextWakeAt(host, now) {
  let wake = null
  for (const lane of host.lanes.values()) {
    if (circuitState(lane, now) === 'open') continue
    const at = Math.max(lane.blockedUntil, lane.nextStartAt)
    if (at > now && (wake === null || at < wake)) wake = at
  }
  return wake
}

function start(host, task, lane, priority) {
  lane.inFlight[priority]++
  lane.lastStartAt = new Date()
  if (lane.intervalMs > 0) lane.nextStartAt = Date.now() + lane.intervalMs

  // The slot is released exactly once: when the task settles, or when the
  // per-task timeout gives up on it. A task that settles after that is ignored.
  // Each attempt gets its own timeout.
  let done = false
  let timer = null
  const finish = (ok, value) => {
    if (done) return
    done = true
    clearTimeout(timer)
    lane.inFlight[priority]--
    // A caller that aborted gets its abort error, never a retry
    if (!ok && task.signal?.aborted) value = abortError(task.signal)
    if (ok) recordSuccess(lane, value)
    else recordFailure(lane, value)

    // Pinned tasks never move. Otherwise the task goes to an untried lane when
    // this lane failed for a lane reason and another lane can take it.
    if (!ok && !task.laneId && isLaneFailure(value)) {
      task.tried.add(lane.id)
      task.lastErr = value
      syncLanes(host, queuedLaneIds(host))
      if (canStillServe(host, task, Date.now())) {
        host.totals.retries++
        host.queues[task.priority].unshift(task)
        pump(host)
        return
      }
    }

    task.cleanup()
    pump(host)
    if (ok) task.resolve(value)
    else task.reject(value)
  }
  timer = setTimeout(() => {
    finish(
      false,
      codedError(
        'host_task_timeout',
        `${host.hostKey} task exceeded ${task.timeoutMs}ms`,
        {
          hostKey: host.hostKey,
        }
      )
    )
  }, task.timeoutMs)
  timer.unref?.()

  Promise.resolve()
    .then(() => task.fn({ egress: lane.egress }))
    .then(
      result => finish(true, result),
      err => finish(false, err)
    )
}

function busyError(host) {
  const message = `${host.hostKey} already has ${MAX_QUEUED_PER_HOST} requests queued`
  return codedError('host_busy', message, { hostKey: host.hostKey })
}

/**
 * Runs fn({ egress }) in the next free slot for hostKey ('overleaf' | 's3' |
 * 'algolia'). `egress` is the proxy the slot's lane uses, or null for the direct
 * connection; pass it to GuardedHttps. Every outbound request to that host must
 * be issued from inside fn, one request per slot. A task that has not settled
 * after `timeoutMs` (default TASK_TIMEOUT_MS) releases its slot and rejects with
 * 'host_task_timeout'.
 *
 * opts.egress pins the task to one lane: 'direct' or an egress id. Without it
 * the task may use any lane. Such a task that fails because of its lane
 * (throttle, proxy error, timeout or network reset) is retried on each other
 * lane at most once, and rejects with the last error when none is left.
 *
 * @param {string} hostKey
 * @param {{ priority?: 'interactive'|'background', signal?: AbortSignal, timeoutMs?: number, egress?: string }} [opts]
 * @param {({ egress: object|null }) => Promise<any>} fn
 */
export function withHostSlot(hostKey, opts, fn) {
  const host = getHost(hostKey)
  const priority =
    opts?.priority === 'interactive' ? 'interactive' : 'background'
  const signal = opts?.signal || null
  const timeoutMs = opts?.timeoutMs > 0 ? opts.timeoutMs : TASK_TIMEOUT_MS
  const laneId = typeof opts?.egress === 'string' ? opts.egress : null
  const now = Date.now()

  if (signal?.aborted) return Promise.reject(abortError(signal))

  syncLanes(host, laneId ? [laneId] : [])
  if (host.lanes.size === 0) {
    host.totals.rejected++
    return Promise.reject(codedError('no_egress', 'no outbound route'))
  }
  const lanes = laneId
    ? [host.lanes.get(laneId)].filter(Boolean)
    : [...host.lanes.values()]
  if (lanes.length === 0) {
    host.totals.rejected++
    return Promise.reject(
      codedError('egress_unavailable', `egress ${laneId} is not available`)
    )
  }

  if (lanes.every(lane => circuitState(lane, now) === 'open')) {
    host.totals.rejected++
    return Promise.reject(circuitOpenError(host, lanes[0]))
  }

  if (
    priority === 'interactive' &&
    lanes.every(lane => lane.blockedUntil - now > INTERACTIVE_MAX_BACKOFF_WAIT_MS)
  ) {
    host.totals.rejected++
    const retryAt = Math.min(...lanes.map(lane => lane.blockedUntil))
    return Promise.reject(
      codedError('host_backoff', `${hostKey} is backing off`, {
        hostKey,
        retryAt: new Date(retryAt),
      })
    )
  }

  return new Promise((resolve, reject) => {
    const task = {
      fn,
      resolve,
      reject,
      priority,
      signal,
      timeoutMs,
      laneId,
      tried: new Set(),
      lastErr: null,
      cleanup: () => {},
    }
    if (queuedCount(host) >= MAX_QUEUED_PER_HOST) {
      const displaced =
        priority === 'interactive' ? host.queues.background.pop() : undefined
      host.totals.rejected++
      if (!displaced) return reject(busyError(host))
      displaced.cleanup()
      displaced.reject(busyError(host))
    }
    if (signal) {
      const onAbort = () => {
        const queue = host.queues[priority]
        const index = queue.indexOf(task)
        if (index !== -1) {
          queue.splice(index, 1)
          reject(abortError(signal))
        }
      }
      signal.addEventListener('abort', onAbort, { once: true })
      task.cleanup = () => signal.removeEventListener('abort', onAbort)
    }
    host.queues[priority].push(task)
    pump(host)
  })
}

/**
 * True when nothing is queued or running for hostKey.
 */
export function isHostIdle(hostKey) {
  const host = hosts.get(hostKey)
  if (!host) return true
  return inFlightCount(host) === 0 && queuedCount(host) === 0
}

function toDate(ms) {
  return ms > Date.now() ? new Date(ms) : null
}

function latestDate(values) {
  const present = values.filter(Boolean)
  if (present.length === 0) return null
  return new Date(Math.max(...present.map(date => date.getTime())))
}

// Sum of ready lanes' slots (maxInFlight - reservedInteractive). A lane is
// ready when it is not backing off and its circuit is not open.
export function capacity(hostKey) {
  const host = getHost(hostKey)
  syncLanes(host)
  const now = Date.now()
  let total = 0
  for (const lane of host.lanes.values()) {
    if (circuitState(lane, now) === 'open' || lane.blockedUntil > now) continue
    total += Math.max(
      0,
      lane.limits.maxInFlight - lane.limits.reservedInteractive
    )
  }
  return Math.max(0, total)
}

/**
 * Earliest time a lane that is backing off leaves backoff, or null when no
 * lane is backing off.
 *
 * @returns {Date|null}
 */
export function earliestReadyAt(hostKey) {
  const host = getHost(hostKey)
  syncLanes(host)
  const now = Date.now()
  let earliest = null
  for (const lane of host.lanes.values()) {
    if (lane.blockedUntil <= now) continue
    if (earliest === null || lane.blockedUntil < earliest) {
      earliest = lane.blockedUntil
    }
  }
  return earliest === null ? null : new Date(earliest)
}

function laneStatus(lane, now) {
  return {
    id: lane.id,
    inFlight: laneInFlight(lane),
    intervalMs: lane.intervalMs,
    backoffUntil: toDate(lane.blockedUntil),
    circuit: circuitState(lane, now),
    lastError: lane.lastError,
    lastSuccessAt: lane.lastSuccessAt,
    lastStatus: lane.lastStatus,
  }
}

/**
 * Snapshot of every host's limiter state. Host-level fields combine the
 * lanes; `lanes` has each lane on its own.
 */
export function getHostStatus() {
  const now = Date.now()
  const status = {}
  for (const hostKey of Object.keys(HOST_LIMITS)) {
    const host = hosts.get(hostKey) || createHostState(hostKey)
    const lanes = [...host.lanes.values()]
    const circuits = lanes.map(lane => circuitState(lane, now))
    const lastFailed = lanes
      .filter(lane => lane.lastFailureAt)
      .sort((a, b) => b.lastFailureAt - a.lastFailureAt)[0]
    const backingOff = lanes.filter(lane => lane.blockedUntil > now)
    const openUntil = lanes
      .filter(lane => lane.circuitOpenUntil > now)
      .map(lane => lane.circuitOpenUntil)
    status[hostKey] = {
      maxInFlight: host.limits.maxInFlight,
      // Starts a minute allowed per lane, or null for an unpaced host
      maxPerMinute:
        host.limits.minIntervalMs > 0
          ? Math.floor(MINUTE / host.limits.minIntervalMs)
          : null,
      intervalMs: Math.max(0, ...lanes.map(lane => lane.intervalMs)),
      inFlight: {
        interactive: lanes.reduce((sum, lane) => sum + lane.inFlight.interactive, 0),
        background: lanes.reduce((sum, lane) => sum + lane.inFlight.background, 0),
      },
      queued: {
        interactive: host.queues.interactive.length,
        background: host.queues.background.length,
      },
      busy: inFlightCount(host) > 0,
      circuit:
        lanes.length > 0 && circuits.every(state => state === 'open')
          ? 'open'
          : circuits.includes('half_open')
            ? 'half_open'
            : 'closed',
      circuitOpenUntil:
        openUntil.length > 0 ? toDate(Math.min(...openUntil)) : null,
      backoffUntil:
        backingOff.length > 0
          ? toDate(Math.min(...backingOff.map(lane => lane.blockedUntil)))
          : null,
      backoffLevel: Math.max(0, ...lanes.map(lane => lane.backoffLevel)),
      consecutiveFailures: Math.max(
        0,
        ...lanes.map(lane => lane.consecutiveFailures)
      ),
      lastStartAt: latestDate(lanes.map(lane => lane.lastStartAt)),
      lastSuccessAt: latestDate(lanes.map(lane => lane.lastSuccessAt)),
      lastFailureAt: latestDate(lanes.map(lane => lane.lastFailureAt)),
      lastError: lastFailed?.lastError ?? null,
      totals: {
        ok: lanes.reduce((sum, lane) => sum + lane.totals.ok, 0),
        failed: lanes.reduce((sum, lane) => sum + lane.totals.failed, 0),
        rejected: host.totals.rejected,
        retries: host.totals.retries,
      },
      lanes: lanes.map(lane => laneStatus(lane, now)),
    }
  }
  return status
}

/**
 * Overrides a host's limits in tests, e.g. { maxInFlight: 1, reservedInteractive: 0 }
 * for a serial host. Applies to every lane of the host.
 */
export function setHostLimitsForTests(hostKey, overrides) {
  const host = getHost(hostKey)
  // A test that sets the floor starts its lanes there too
  const limits =
    'minIntervalMs' in overrides && !('startIntervalMs' in overrides)
      ? { ...overrides, startIntervalMs: overrides.minIntervalMs }
      : overrides
  host.limits = { ...host.limits, ...limits }
  for (const lane of host.lanes.values()) {
    lane.limits = { ...lane.limits, ...limits }
    if ('minIntervalMs' in limits) lane.intervalMs = limits.minIntervalMs
  }
}

/**
 * Drops all queues, timers and counters. Queued callers are rejected.
 */
export function resetHostLimiterForTests() {
  for (const host of hosts.values()) {
    if (host.timer) clearTimeout(host.timer)
    rejectQueued(host, () => codedError('limiter_reset', 'host limiter reset'))
  }
  hosts.clear()
}

export default {
  withHostSlot,
  fetchRpm,
  isHostIdle,
  getHostStatus,
  capacity,
  earliestReadyAt,
  parseRetryAfterMs,
  setHostLimitsForTests,
  resetHostLimiterForTests,
  isThrottledError,
  BACKOFF_STEPS_MS,
  CIRCUIT_FAILURE_THRESHOLD,
  CIRCUIT_OPEN_MS,
  MAX_QUEUED_PER_HOST,
  TASK_TIMEOUT_MS,
}
