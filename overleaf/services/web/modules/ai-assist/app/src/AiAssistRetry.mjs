import logger from '@overleaf/logger'
import { cancelledError, ProviderError } from './AiAssistErrors.mjs'

/**
 * One retry layer for upstream provider requests, modelled on Claude Code: an
 * exponential backoff with jitter, a server's Retry-After honoured, and a cap
 * on how long the server may ask us to wait before we give up instead.
 *
 * Each caller picks a policy by how much a person is waiting on it.
 */
export const RETRY_POLICIES = {
  // An agent run, compaction, or a relayed chat with a visible status line
  interactive: {
    maxRetries: 10,
    baseMs: 500,
    capMs: 32000,
    maxRetryAfterMs: 60000,
  },
  // Titles and other jobs nobody is watching
  background: {
    maxRetries: 3,
    baseMs: 500,
    capMs: 8000,
    maxRetryAfterMs: 30000,
  },
  // Inline completions and suggestions, where a late answer is worthless
  inline: {
    maxRetries: 1,
    baseMs: 250,
    capMs: 1000,
    maxRetryAfterMs: 1000,
  },
  // Connection tests and model lists: report the first failure as it is
  none: {
    maxRetries: 0,
    baseMs: 0,
    capMs: 0,
    maxRetryAfterMs: 0,
  },
}

/** A copy of the named policy, so a caller can never change the shared one. */
export function resolveRetryPolicy(name) {
  return { ...(RETRY_POLICIES[name] ?? RETRY_POLICIES.none) }
}

function policyOf(policy) {
  return typeof policy === 'string'
    ? resolveRetryPolicy(policy)
    : (policy ?? RETRY_POLICIES.none)
}

function readHeader(headers, name) {
  if (!headers) return null
  const value =
    typeof headers.get === 'function' ? headers.get(name) : headers[name]
  return value == null ? null : String(value).trim()
}

/**
 * How long a server asked us to wait, in ms: `retry-after-ms`, then
 * `retry-after` as seconds or an HTTP date. Null when it asked for nothing.
 */
export function parseRetryAfterMs(headers, now = Date.now()) {
  const ms = readHeader(headers, 'retry-after-ms')
  if (ms && /^\d+(\.\d+)?$/.test(ms)) return Math.round(Number(ms))

  const seconds = readHeader(headers, 'retry-after')
  if (!seconds) return null
  if (/^\d+(\.\d+)?$/.test(seconds)) return Math.round(Number(seconds) * 1000)
  const date = Date.parse(seconds)
  if (Number.isFinite(date)) return Math.max(0, date - now)
  return null
}

/** `x-should-retry` as the provider sent it: true, false, or undefined when absent. */
export function parseShouldRetry(headers) {
  const value = readHeader(headers, 'x-should-retry')
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

/** The retry fields of an error reply: what the clients put on their ProviderError. */
export function retryHeaders(headers, now = Date.now()) {
  return {
    retryAfterMs: parseRetryAfterMs(headers, now),
    shouldRetry: parseShouldRetry(headers),
  }
}

/**
 * The wait before retry number `attempt` (1-based): the exponential step, capped,
 * with up to 25% jitter, and never less than what the server asked for.
 */
export function retryDelayMs(
  attempt,
  policy,
  retryAfterMs = null,
  random = Math.random
) {
  const step = Math.min(
    policy.capMs,
    policy.baseMs * Math.pow(2, Math.max(attempt, 1) - 1)
  )
  const jittered = step * (1 + random() * 0.25)
  return Math.round(Math.max(jittered, retryAfterMs ?? 0))
}

const NEVER_RETRY_STATUSES = new Set([400, 401, 403, 404, 413, 422])
const NEVER_RETRY_CODES = new Set([
  'aborted',
  'providerAuth',
  'invalidProviderUrl',
  'invalidProviderSettings',
  'restrictedProviderUrl',
  'contextExhausted',
])
const NETWORK_RESET_CODES = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'])
const NETWORK_TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'])
const QUOTA_RE = /insufficient[_ ]quota|quota|billing|credit balance/i

function retryable(reason, status) {
  return { retryable: true, reason, status }
}

function networkReason(err) {
  const codes = [err.code, err.cause?.code]
  if (codes.some(code => NETWORK_RESET_CODES.has(code))) return 'Connection reset'
  if (codes.some(code => NETWORK_TIMEOUT_CODES.has(code))) {
    return 'Connection timed out'
  }
  if (codes.includes('ECONNREFUSED')) return 'Connection refused'
  const message = String(err.message ?? '')
  if (message.includes('socket hang up') || message === 'terminated') {
    return 'Connection reset'
  }
  if (message.includes('network timeout')) return 'Connection timed out'
  if (message.includes('fetch failed') || err.code === 'network') {
    return 'Connection failed'
  }
  return null
}

/**
 * Whether an error is worth another attempt, and the short reason the page
 * shows for it. Status and code first, then the network failures.
 */
export function classifyRetry(err) {
  const status = typeof err?.status === 'number' ? err.status : undefined
  const none = { retryable: false, reason: '', status }
  if (!err) return none
  if (err.name === 'AbortError' || NEVER_RETRY_CODES.has(err.code)) return none
  if (NEVER_RETRY_STATUSES.has(status)) return none
  if (err.shouldRetry === false) return none
  if (status === 429 && QUOTA_RE.test(String(err.message ?? ''))) return none

  if (err.code === 'providerTimeout') {
    return retryable('Connection timed out', status)
  }
  if (err.code === 'providerStalled') return retryable('Stream stalled', status)

  if (status === 429) return retryable('Rate limited (429)', status)
  if (status === 529) return retryable('API overloaded (529)', status)
  if (status === 408) return retryable('Request timed out (408)', status)
  if (status === 409) return retryable('Conflict (409)', status)
  if (status >= 500 && status < 600) {
    return retryable(`Server error (${status})`, status)
  }

  const network = networkReason(err)
  if (network) return retryable(network, undefined)

  if (err.shouldRetry === true) {
    return retryable('Provider asked to retry', status)
  }
  return none
}

/**
 * What to do after `err` failed attempt number `attempt` (0 for the first
 * try). Returns { retry: true, attempt, retryInMs, message, status } to wait
 * and go again, or { retry: false, error } with the error to throw. A server
 * that asks for longer than the policy allows fails here, with a clear message.
 */
export function planRetry(err, { attempt = 0, policy, random = Math.random }) {
  const resolved = policyOf(policy)
  const verdict = classifyRetry(err)
  if (!verdict.retryable || attempt >= resolved.maxRetries) {
    return { retry: false, error: err }
  }

  const retryAfterMs = Number.isFinite(err.retryAfterMs)
    ? err.retryAfterMs
    : null
  if (retryAfterMs != null && retryAfterMs > resolved.maxRetryAfterMs) {
    return {
      retry: false,
      error: new ProviderError(
        `Provider asked to wait ${Math.ceil(retryAfterMs / 1000)}s before retrying; giving up`,
        {
          code: err.code ?? 'providerError',
          status: err.status,
          hint: err.hint,
        }
      ),
    }
  }

  return {
    retry: true,
    attempt: attempt + 1,
    retryInMs: retryDelayMs(attempt + 1, resolved, retryAfterMs, random),
    message: verdict.reason,
    status: verdict.status,
  }
}

/** The `retrying` event a page shows for a planned retry (see the run event contract). */
export function retryingEvent(plan, policy, now = Date.now()) {
  const resolved = policyOf(policy)
  return {
    type: 'retrying',
    attempt: plan.attempt,
    maxRetries: resolved.maxRetries,
    retryInMs: plan.retryInMs,
    retryAt: now + plan.retryInMs,
    message: plan.message,
    ...(plan.status != null ? { status: plan.status } : {}),
  }
}

/** Waits `ms`, rejecting with a cancellation error if `signal` aborts first. */
export function abortableSleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(cancelledError())
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(cancelledError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function isCancellation(err) {
  return err?.name === 'AbortError' || err?.code === 'aborted'
}

/**
 * The catch step shared by both retry loops: rethrows unless `err` earns
 * another attempt, otherwise reports the retry, waits it out, and returns the
 * next attempt number.
 */
async function nextAttempt(
  err,
  attempt,
  policy,
  { signal, onRetry, canRetry, random }
) {
  if (signal?.aborted) throw cancelledError()
  if (isCancellation(err)) throw err
  if (canRetry && !canRetry()) throw err
  const plan = planRetry(err, { attempt, policy, random })
  if (!plan.retry) throw plan.error
  logger.warn(
    { attempt: plan.attempt, status: plan.status, message: plan.message },
    '[AiAssist] Transient error from provider, retrying'
  )
  await onRetry?.(retryingEvent(plan, policy))
  await abortableSleep(plan.retryInMs, signal)
  return plan.attempt
}

/**
 * Runs `attemptFn(attempt)` until it succeeds or the policy gives up. Each call
 * is a whole attempt, so anything it sets up (a connect timer) starts afresh.
 */
export async function withProviderRetry(
  attemptFn,
  { policy, signal, onRetry, random } = {}
) {
  const resolved = policyOf(policy)
  let attempt = 0
  for (;;) {
    if (signal?.aborted) throw cancelledError()
    try {
      return await attemptFn(attempt)
    } catch (err) {
      attempt = await nextAttempt(err, attempt, resolved, {
        signal,
        onRetry,
        random,
      })
    }
  }
}

/**
 * The async-generator form: `makeStream(attempt)` is started again on a
 * retryable failure, while `canRetry()` allows it (for instance, while nothing
 * has been forwarded to the caller yet).
 */
export async function* streamWithRetry(
  makeStream,
  { policy, signal, onRetry, canRetry, random } = {}
) {
  const resolved = policyOf(policy)
  let attempt = 0
  for (;;) {
    if (signal?.aborted) throw cancelledError()
    try {
      yield* makeStream(attempt)
      return
    } catch (err) {
      attempt = await nextAttempt(err, attempt, resolved, {
        signal,
        onRetry,
        canRetry,
        random,
      })
    }
  }
}
