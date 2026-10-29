// Per-host politeness for every outbound request the gallery mirror makes.
//
// Each upstream host gets one serial queue with a minimum start-to-start
// interval. Interactive work (a user is waiting) always runs before queued
// background work. 429/503 responses push the host into backoff (honouring
// Retry-After) and repeated failures open a circuit that fails fast.

const SECOND = 1000
const MINUTE = 60 * SECOND

const HOST_RATES = Object.freeze({
  overleaf: { intervalMs: 1000, jitterMs: 300 },
  s3: { intervalMs: 250, jitterMs: 0 },
  algolia: { intervalMs: 250, jitterMs: 0 },
})

export const BACKOFF_STEPS_MS = Object.freeze([
  30 * SECOND,
  2 * MINUTE,
  10 * MINUTE,
  60 * MINUTE,
])
export const CIRCUIT_FAILURE_THRESHOLD = 5
export const CIRCUIT_OPEN_MS = 10 * MINUTE

// An interactive caller never waits behind a backoff window longer than this;
// it gets a fast failure instead and the page renders without upstream data.
const INTERACTIVE_MAX_BACKOFF_WAIT_MS = 5 * SECOND

const PRIORITIES = Object.freeze(['interactive', 'background'])

const hosts = new Map()

function createHostState(hostKey) {
  return {
    hostKey,
    rate: HOST_RATES[hostKey],
    queues: { interactive: [], background: [] },
    inFlight: null,
    timer: null,
    nextStartAt: 0,
    lastStartAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
    blockedUntil: 0,
    backoffLevel: 0,
    consecutiveFailures: 0,
    circuitOpenUntil: 0,
    totals: { ok: 0, failed: 0, rejected: 0 },
  }
}

function getHost(hostKey) {
  if (!HOST_RATES[hostKey]) {
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

function circuitState(host, now = Date.now()) {
  if (host.circuitOpenUntil === 0) return 'closed'
  return now < host.circuitOpenUntil ? 'open' : 'half_open'
}

function circuitOpenError(host) {
  return codedError('circuit_open', `circuit open for ${host.hostKey}`, {
    hostKey: host.hostKey,
    retryAt: new Date(host.circuitOpenUntil),
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
function isThrottle(err) {
  const status = statusOf(err)
  return status === 429 || status === 503 || retryAfterOf(err) != null
}

// Host health failures count towards the circuit breaker. A 404 or 403 is a
// healthy answer about a resource, so it resets the failure streak.
function isHostFailure(err) {
  if (isThrottle(err)) return true
  const status = statusOf(err)
  return status == null || status >= 500
}

function rejectQueued(host, makeError) {
  for (const priority of PRIORITIES) {
    const queue = host.queues[priority]
    while (queue.length > 0) {
      const task = queue.shift()
      task.cleanup()
      host.totals.rejected++
      task.reject(makeError())
    }
  }
}

function queuedCount(host) {
  return host.queues.interactive.length + host.queues.background.length
}

function nextTask(host) {
  return host.queues.interactive[0] || host.queues.background[0] || null
}

function shiftTask(host) {
  return host.queues.interactive.length > 0
    ? host.queues.interactive.shift()
    : host.queues.background.shift()
}

function schedulePump(host, delayMs) {
  if (host.timer) return
  host.timer = setTimeout(() => {
    host.timer = null
    pump(host)
  }, delayMs)
  host.timer.unref?.()
}

function recordSuccess(host) {
  host.totals.ok++
  host.lastSuccessAt = new Date()
  host.consecutiveFailures = 0
  host.backoffLevel = 0
  host.blockedUntil = 0
  host.circuitOpenUntil = 0
}

function recordFailure(host, err) {
  const now = Date.now()
  host.totals.failed++
  host.lastFailureAt = new Date(now)
  host.lastError = String(err?.message || err).slice(0, 300)

  if (!isHostFailure(err)) {
    // The host answered; only the resource was unhappy.
    host.consecutiveFailures = 0
    if (circuitState(host, now) === 'half_open') host.circuitOpenUntil = 0
    return
  }

  host.consecutiveFailures++

  if (isThrottle(err)) {
    const step =
      BACKOFF_STEPS_MS[Math.min(host.backoffLevel, BACKOFF_STEPS_MS.length - 1)]
    const delay = Math.max(step, retryAfterOf(err) ?? 0)
    host.blockedUntil = Math.max(host.blockedUntil, now + delay)
    host.backoffLevel = Math.min(host.backoffLevel + 1, BACKOFF_STEPS_MS.length)
  }

  const wasHalfOpen = circuitState(host, now) === 'half_open'
  if (wasHalfOpen || host.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
    host.circuitOpenUntil = now + CIRCUIT_OPEN_MS
    rejectQueued(host, () => circuitOpenError(host))
  }
}

function pump(host) {
  if (host.inFlight || host.timer) return
  const head = nextTask(host)
  if (!head) return

  const now = Date.now()
  if (circuitState(host, now) === 'open') {
    rejectQueued(host, () => circuitOpenError(host))
    return
  }

  const readyAt = Math.max(host.nextStartAt, host.blockedUntil)
  if (readyAt > now) {
    schedulePump(host, readyAt - now)
    return
  }

  const task = shiftTask(host)
  task.cleanup()
  host.inFlight = task
  host.lastStartAt = new Date(now)
  const jitter = host.rate.jitterMs ? Math.random() * host.rate.jitterMs : 0
  host.nextStartAt = now + host.rate.intervalMs + Math.round(jitter)

  Promise.resolve()
    .then(() => task.fn())
    .then(
      result => {
        recordSuccess(host)
        host.inFlight = null
        pump(host)
        task.resolve(result)
      },
      err => {
        recordFailure(host, err)
        host.inFlight = null
        pump(host)
        task.reject(err)
      }
    )
}

/**
 * Runs fn() in the next free slot for hostKey ('overleaf' | 's3' | 'algolia').
 * Every outbound request to that host must be issued from inside fn, one
 * request per slot.
 *
 * @param {string} hostKey
 * @param {{ priority?: 'interactive'|'background', signal?: AbortSignal }} [opts]
 * @param {() => Promise<any>} fn
 */
export function withHostSlot(hostKey, opts, fn) {
  const host = getHost(hostKey)
  const priority = opts?.priority === 'interactive' ? 'interactive' : 'background'
  const signal = opts?.signal || null
  const now = Date.now()

  if (signal?.aborted) return Promise.reject(abortError(signal))

  if (circuitState(host, now) === 'open') {
    host.totals.rejected++
    return Promise.reject(circuitOpenError(host))
  }

  if (
    priority === 'interactive' &&
    host.blockedUntil - now > INTERACTIVE_MAX_BACKOFF_WAIT_MS
  ) {
    host.totals.rejected++
    return Promise.reject(
      codedError('host_backoff', `${hostKey} is backing off`, {
        hostKey,
        retryAt: new Date(host.blockedUntil),
      })
    )
  }

  return new Promise((resolve, reject) => {
    const task = { fn, resolve, reject, cleanup: () => {} }
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
 * True when nothing is queued or running for hostKey, so background trickle
 * work can be started without delaying anyone.
 */
export function isHostIdle(hostKey) {
  const host = hosts.get(hostKey)
  if (!host) return true
  return !host.inFlight && queuedCount(host) === 0
}

function toDate(ms) {
  return ms > Date.now() ? new Date(ms) : null
}

/**
 * Snapshot of every host for the admin status API.
 */
export function getHostStatus() {
  const now = Date.now()
  const status = {}
  for (const hostKey of Object.keys(HOST_RATES)) {
    const host = hosts.get(hostKey) || createHostState(hostKey)
    status[hostKey] = {
      intervalMs: host.rate.intervalMs,
      queued: {
        interactive: host.queues.interactive.length,
        background: host.queues.background.length,
      },
      busy: Boolean(host.inFlight),
      circuit: circuitState(host, now),
      circuitOpenUntil: toDate(host.circuitOpenUntil),
      backoffUntil: toDate(host.blockedUntil),
      backoffLevel: host.backoffLevel,
      consecutiveFailures: host.consecutiveFailures,
      lastStartAt: host.lastStartAt,
      lastSuccessAt: host.lastSuccessAt,
      lastFailureAt: host.lastFailureAt,
      lastError: host.lastError,
      totals: { ...host.totals },
    }
  }
  return status
}

/**
 * Allows test suites to override the host interval and jitter (e.g. 0ms for fast tests).
 */
export function setHostRateForTests(hostKey, rate) {
  const host = getHost(hostKey)
  host.rate = { ...host.rate, ...rate }
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
  isHostIdle,
  getHostStatus,
  parseRetryAfterMs,
  setHostRateForTests,
  resetHostLimiterForTests,
  BACKOFF_STEPS_MS,
  CIRCUIT_FAILURE_THRESHOLD,
  CIRCUIT_OPEN_MS,
}
