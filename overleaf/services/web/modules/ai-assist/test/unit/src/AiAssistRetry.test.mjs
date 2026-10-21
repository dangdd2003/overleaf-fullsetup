import { describe, it } from 'vitest'
import { expect } from 'chai'
import sinon from 'sinon'
import { ProviderError } from '../../../app/src/AiAssistErrors.mjs'
import {
  RETRY_POLICIES,
  abortableSleep,
  classifyRetry,
  parseRetryAfterMs,
  parseShouldRetry,
  planRetry,
  resolveRetryPolicy,
  retryDelayMs,
  retryingEvent,
  streamWithRetry,
  withProviderRetry,
} from '../../../app/src/AiAssistRetry.mjs'

// Fast policy for the tests that actually wait
const quick = { maxRetries: 2, baseMs: 1, capMs: 2, maxRetryAfterMs: 50 }

function headersOf(values) {
  return new Map(Object.entries(values))
}

function statusError(status, extra = {}) {
  return new ProviderError(`HTTP ${status}`, { status, ...extra })
}

describe('AiAssistRetry', function () {
  describe('policies', function () {
    it('matches the shared contract', function () {
      expect(RETRY_POLICIES.background).to.deep.equal({
        maxRetries: 3,
        baseMs: 500,
        capMs: 8000,
        maxRetryAfterMs: 30000,
      })
      expect(RETRY_POLICIES.inline).to.include({ maxRetries: 1, capMs: 1000 })
      expect(RETRY_POLICIES.none.maxRetries).to.equal(0)
    })

    it('retries an interactive request up to 10 times', function () {
      expect(resolveRetryPolicy('interactive').maxRetries).to.equal(10)
    })
  })

  describe('retryDelayMs', function () {
    const policy = { baseMs: 500, capMs: 32000 }

    it('doubles from the base each retry, capped', function () {
      const delays = [1, 2, 3, 4, 7, 8].map(attempt =>
        retryDelayMs(attempt, policy, null, () => 0)
      )
      expect(delays).to.deep.equal([500, 1000, 2000, 4000, 32000, 32000])
    })

    it('adds up to 25% jitter', function () {
      expect(retryDelayMs(1, policy, null, () => 1)).to.equal(625)
      expect(retryDelayMs(2, policy, null, () => 0.5)).to.equal(1125)
    })

    it('is never shorter than what the server asked for', function () {
      expect(retryDelayMs(1, policy, 10000, () => 0)).to.equal(10000)
      expect(retryDelayMs(3, policy, 100, () => 0)).to.equal(2000)
    })
  })

  describe('parseRetryAfterMs', function () {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0)

    it('reads retry-after-ms as milliseconds', function () {
      expect(parseRetryAfterMs(headersOf({ 'retry-after-ms': '1500' }), now)).to.equal(1500)
    })

    it('reads retry-after as whole or fractional seconds', function () {
      expect(parseRetryAfterMs(headersOf({ 'retry-after': '7' }), now)).to.equal(7000)
      expect(parseRetryAfterMs(headersOf({ 'retry-after': '0.5' }), now)).to.equal(500)
    })

    it('reads retry-after as an HTTP date, relative to now', function () {
      const date = new Date(now + 20000).toUTCString()
      expect(parseRetryAfterMs(headersOf({ 'retry-after': date }), now)).to.equal(20000)
      const past = new Date(now - 5000).toUTCString()
      expect(parseRetryAfterMs(headersOf({ 'retry-after': past }), now)).to.equal(0)
    })

    it('prefers retry-after-ms when both are sent', function () {
      const headers = headersOf({ 'retry-after-ms': '250', 'retry-after': '9' })
      expect(parseRetryAfterMs(headers, now)).to.equal(250)
    })

    it('returns null when absent or unreadable', function () {
      expect(parseRetryAfterMs(headersOf({}), now)).to.be.null
      expect(parseRetryAfterMs(headersOf({ 'retry-after': 'soon' }), now)).to.be.null
      expect(parseRetryAfterMs(undefined, now)).to.be.null
    })

    it('accepts a plain object of headers too', function () {
      expect(parseRetryAfterMs({ 'retry-after': '3' }, now)).to.equal(3000)
    })
  })

  describe('parseShouldRetry', function () {
    it('reads x-should-retry true and false, and nothing else', function () {
      expect(parseShouldRetry(headersOf({ 'x-should-retry': 'true' }))).to.be.true
      expect(parseShouldRetry(headersOf({ 'x-should-retry': 'false' }))).to.be.false
      expect(parseShouldRetry(headersOf({ 'x-should-retry': 'maybe' }))).to.be.undefined
      expect(parseShouldRetry(headersOf({}))).to.be.undefined
    })
  })

  describe('classifyRetry', function () {
    it('retries rate limits, overload, server errors and timeouts', function () {
      expect(classifyRetry(statusError(429))).to.include({
        retryable: true,
        reason: 'Rate limited (429)',
      })
      expect(classifyRetry(statusError(529))).to.include({
        retryable: true,
        reason: 'API overloaded (529)',
      })
      expect(classifyRetry(statusError(503))).to.include({
        retryable: true,
        reason: 'Server error (503)',
        status: 503,
      })
      expect(classifyRetry(statusError(408)).retryable).to.be.true
      expect(classifyRetry(statusError(409)).retryable).to.be.true
      expect(
        classifyRetry(new ProviderError('Connection timed out', { code: 'providerTimeout' }))
      ).to.include({ retryable: true, reason: 'Connection timed out' })
      expect(
        classifyRetry(new ProviderError('Stream stalled', { code: 'providerStalled' }))
      ).to.include({ retryable: true, reason: 'Stream stalled' })
    })

    it('retries dropped connections, by code or by message', function () {
      expect(classifyRetry(Object.assign(new Error('read'), { code: 'ECONNRESET' })))
        .to.include({ retryable: true, reason: 'Connection reset' })
      expect(classifyRetry(new TypeError('fetch failed')))
        .to.include({ retryable: true, reason: 'Connection failed' })
      expect(classifyRetry(new Error('socket hang up')).reason).to.equal('Connection reset')
      expect(classifyRetry(new Error('terminated')).reason).to.equal('Connection reset')
    })

    it('does not retry request errors, auth, quota, or a user stop', function () {
      for (const status of [400, 401, 403, 404, 413, 422]) {
        expect(classifyRetry(statusError(status)).retryable, `${status}`).to.be.false
      }
      expect(classifyRetry(new ProviderError('bad key', { code: 'providerAuth' })).retryable).to.be.false
      expect(classifyRetry(new ProviderError('ctx', { code: 'contextExhausted' })).retryable).to.be.false
      expect(
        classifyRetry(Object.assign(new Error('You exceeded your current quota'), { status: 429 })).retryable
      ).to.be.false
      expect(classifyRetry(new ProviderError('Request was cancelled', { code: 'aborted' })).retryable).to.be.false
      expect(classifyRetry(new Error('something else')).retryable).to.be.false
    })

    it('obeys x-should-retry', function () {
      expect(classifyRetry(statusError(503, { shouldRetry: false })).retryable).to.be.false
      expect(classifyRetry({ shouldRetry: true, message: 'odd' }).retryable).to.be.true
    })
  })

  describe('planRetry', function () {
    const policy = { maxRetries: 2, baseMs: 100, capMs: 1000, maxRetryAfterMs: 5000 }

    it('plans the next retry with its delay and the reason', function () {
      const plan = planRetry(statusError(503), { attempt: 0, policy, random: () => 0 })
      expect(plan).to.include({
        retry: true,
        attempt: 1,
        retryInMs: 100,
        message: 'Server error (503)',
        status: 503,
      })
    })

    it('gives up with the original error once the retries are spent', function () {
      const err = statusError(503)
      const plan = planRetry(err, { attempt: 2, policy, random: () => 0 })
      expect(plan.retry).to.be.false
      expect(plan.error).to.equal(err)
    })

    it('fails at once, with a clear message, when the server asks for too long a wait', function () {
      const err = statusError(429, { retryAfterMs: 120000 })
      const plan = planRetry(err, { attempt: 0, policy, random: () => 0 })
      expect(plan.retry).to.be.false
      expect(plan.error).to.be.instanceOf(ProviderError)
      expect(plan.error.message).to.equal(
        'Provider asked to wait 120s before retrying; giving up'
      )
      expect(plan.error.status).to.equal(429)
    })

    it('waits the server time when it is longer than the backoff', function () {
      const err = statusError(429, { retryAfterMs: 3000 })
      const plan = planRetry(err, { attempt: 0, policy, random: () => 0 })
      expect(plan.retry).to.be.true
      expect(plan.retryInMs).to.equal(3000)
    })
  })

  describe('retryingEvent', function () {
    it('carries the run event fields', function () {
      const event = retryingEvent(
        { attempt: 2, retryInMs: 900, message: 'Rate limited (429)', status: 429 },
        { maxRetries: 10 },
        1000
      )
      expect(event).to.deep.equal({
        type: 'retrying',
        attempt: 2,
        maxRetries: 10,
        retryInMs: 900,
        retryAt: 1900,
        message: 'Rate limited (429)',
        status: 429,
      })
    })

    it('leaves status out when there is none', function () {
      const event = retryingEvent(
        { attempt: 1, retryInMs: 5, message: 'Connection reset' },
        quick,
        0
      )
      expect(event).to.not.have.property('status')
    })
  })

  describe('abortableSleep', function () {
    it('rejects with a cancellation when the signal aborts during the wait', async function () {
      const controller = new AbortController()
      const pending = abortableSleep(10000, controller.signal)
      controller.abort()
      const err = await pending.catch(e => e)
      expect(err).to.be.instanceOf(ProviderError)
      expect(err.code).to.equal('aborted')
      expect(err.message).to.equal('Request was cancelled')
    })

    it('rejects straight away when the signal is already aborted', async function () {
      const controller = new AbortController()
      controller.abort()
      const err = await abortableSleep(1, controller.signal).catch(e => e)
      expect(err.code).to.equal('aborted')
    })
  })

  describe('withProviderRetry', function () {
    it('returns the first success after transient failures and reports each retry', async function () {
      const attempts = []
      const retries = []
      const result = await withProviderRetry(
        async attempt => {
          attempts.push(attempt)
          if (attempt < 2) throw statusError(503)
          return 'ok'
        },
        { policy: quick, onRetry: event => retries.push(event) }
      )
      expect(result).to.equal('ok')
      expect(attempts).to.deep.equal([0, 1, 2])
      expect(retries.map(event => event.attempt)).to.deep.equal([1, 2])
      expect(retries[0]).to.include({ type: 'retrying', maxRetries: 2, message: 'Server error (503)' })
    })

    it('throws the last error once the policy is spent', async function () {
      const attemptFn = sinon.stub().rejects(statusError(500))
      const err = await withProviderRetry(attemptFn, { policy: quick }).catch(e => e)
      expect(attemptFn.callCount).to.equal(3)
      expect(err.status).to.equal(500)
    })

    it('does not retry a permanent failure', async function () {
      const attemptFn = sinon.stub().rejects(statusError(401))
      await withProviderRetry(attemptFn, { policy: quick }).catch(() => {})
      expect(attemptFn.callCount).to.equal(1)
    })

    it('does not retry when the provider says x-should-retry false', async function () {
      const attemptFn = sinon.stub().rejects(statusError(503, { shouldRetry: false }))
      await withProviderRetry(attemptFn, { policy: quick }).catch(() => {})
      expect(attemptFn.callCount).to.equal(1)
    })

    it('ends with a cancellation when aborted during the wait', async function () {
      const controller = new AbortController()
      const attemptFn = sinon.stub().rejects(statusError(503))
      const pending = withProviderRetry(attemptFn, {
        policy: { maxRetries: 3, baseMs: 10000, capMs: 10000, maxRetryAfterMs: 1 },
        signal: controller.signal,
      })
      setTimeout(() => controller.abort(), 10)
      const err = await pending.catch(e => e)
      expect(err.code).to.equal('aborted')
      expect(attemptFn.callCount).to.equal(1)
    })
  })

  describe('streamWithRetry', function () {
    it('starts the stream again after a retryable failure', async function () {
      let starts = 0
      const chunks = []
      for await (const chunk of streamWithRetry(
        async function* () {
          starts++
          if (starts === 1) throw statusError(529)
          yield { type: 'text', text: 'hello' }
        },
        { policy: quick }
      )) {
        chunks.push(chunk)
      }
      expect(starts).to.equal(2)
      expect(chunks).to.deep.equal([{ type: 'text', text: 'hello' }])
    })

    it('does not retry once canRetry says content has gone out', async function () {
      let starts = 0
      let sent = false
      const run = async () => {
        for await (const chunk of streamWithRetry(
          async function* () {
            starts++
            yield { type: 'text', text: 'partial' }
            sent = true
            throw statusError(503)
          },
          { policy: quick, canRetry: () => !sent }
        )) {
          void chunk
        }
      }
      const err = await run().catch(e => e)
      expect(starts).to.equal(1)
      expect(err.status).to.equal(503)
    })

    it('reports each retry through onRetry', async function () {
      const retries = []
      let starts = 0
      for await (const _chunk of streamWithRetry(
        async function* () {
          starts++
          if (starts < 3) throw statusError(429)
          yield { type: 'stop', reason: 'end_turn' }
        },
        { policy: quick, onRetry: event => retries.push(event) }
      )) {
        void _chunk
      }
      expect(retries.map(event => event.attempt)).to.deep.equal([1, 2])
    })
  })
})
