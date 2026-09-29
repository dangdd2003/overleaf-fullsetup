import { ProviderError } from '../AiAssistProviders.mjs'
import { adapterContext } from './adapters/common.mjs'
import { ADAPTERS, matchAdapter } from './adapters/index.mjs'
import { documentFromResponse } from './document.mjs'
import { assessContent } from './quality.mjs'
import { archiveTodayRoute, waybackRoute } from './routes/archives.mjs'
import { directRoute } from './routes/direct.mjs'
import { READERS, READER_ORDER, readerTimeoutMs } from './routes/readers.mjs'
import { parseFetchUrl } from './transport.mjs'
import { HOUR_MS, clip, webError } from './util.mjs'
import { cacheKeyFor } from './urls.mjs'
import {
  recordHostFailure,
  recordHostSuccess,
  isStepSkipped,
} from './host-memory.mjs'

/**
 * Reads one URL by the first route that yields real content:
 *
 *   cache → paid readers → site adapter → direct GET → headless browser → archives
 *
 * Configured provider readers run first; built-in fallbacks are tried only when
 * no provider is configured or all reader attempts fail. Every document passes
 * the quality check, so a bot check or an empty JavaScript shell counts as that
 * route failing.
 */

/** The whole ladder for one URL, however many routes it climbs. */
export const READ_BUDGET_MS = 90_000
const STEP_TIMEOUT_MS = {
  adapter: 45_000,
  raw: 25_000,
  direct: 20_000,
  render: 45_000,
  archive: 20_000,
}
/** A partial result is reused only briefly, so a later read retries the ladder. */
const PARTIAL_TTL_MS = 10 * 60 * 1000
/** The page is gone: only an archive can still have it. */
const GONE_STATUSES = new Set([404, 410])
const ARCHIVES = [
  ['wayback', waybackRoute],
  ['archive.today', archiveTodayRoute],
]
const FAILURE_TTL_MS = 10 * 60 * 1000 // 10 minutes
const failureCache = new Map() // cacheKey -> { at: number, error: Error }

export function clearFailureCache() {
  failureCache.clear()
}

function cancelled() {
  return new ProviderError('Request was cancelled', { code: 'aborted' })
}

function reasonOf(err) {
  if (Number.isInteger(err?.status)) return `HTTP ${err.status}`
  if (err?.kind === 'thin') return 'too little text'
  return clip(String(err?.message || 'failed').replace(/\.$/, ''), 160)
}

export class WebFetcher {
  constructor({
    fetchPage,
    fetchFn = fetch,
    rotator = null,
    browser = null,
    cache = null,
    cacheHours = 0,
    adapters = ADAPTERS,
    budgetMs = READ_BUDGET_MS,
    now = () => Date.now(),
  } = {}) {
    this.fetchPage = fetchPage
    this.fetchFn = fetchFn
    this.rotator = rotator
    this.browser = browser
    this.cache = cache
    this.cacheHours = cacheHours
    this.adapters = adapters
    this.budgetMs = budgetMs
    this.now = now
    // cacheKeyFor(url) -> the read in flight for it
    this.pending = new Map()
  }

  /**
   * The document for `url`: from the cache unless `fresh`, else read by the
   * ladder. Stamped with `via` (the route that read it) and `fetchedAt`.
   */
  async read(url, { signal, fresh = false } = {}) {
    if (signal?.aborted) throw cancelled()
    const key = cacheKeyFor(url)
    if (!fresh) {
      const failed = failureCache.get(key)
      if (failed && this.now() - failed.at < FAILURE_TTL_MS) {
        throw failed.error
      }
    }

    const maxAgeMs = this.cacheHours * HOUR_MS
    const useCache = Boolean(this.cache) && maxAgeMs > 0
    if (useCache && !fresh) {
      const cached = this.cache.get(key, maxAgeMs)
      const stale =
        cached?.partial &&
        this.now() - Date.parse(cached.fetchedAt) > PARTIAL_TTL_MS
      if (cached && !stale) return cached
    }

    // Calls made together for one page (page 1 and a find, say) share one
    // read. They come from one run, which aborts them all with one signal.
    if (fresh) return this._readAndStore(url, key, { signal, fresh, useCache })
    let reading = this.pending.get(key)
    if (!reading) {
      reading = this._readAndStore(url, key, {
        signal,
        fresh,
        useCache,
      }).finally(() => this.pending.delete(key))
      this.pending.set(key, reading)
    }
    return reading
  }

  /** Reads `url` by the ladder, then caches the document or remembers the failure. */
  async _readAndStore(url, key, { signal, fresh, useCache }) {
    let doc
    try {
      doc = await this._ladder(url, {
        signal,
        fresh,
        deadline: this.now() + this.budgetMs,
        useAdapters: true,
      })
      failureCache.delete(key)
    } catch (err) {
      if (
        !signal?.aborted &&
        err?.kind !== 'network' &&
        err?.status !== 429 &&
        !(err?.status >= 500)
      ) {
        failureCache.set(key, { at: this.now(), error: err })
      }
      throw err
    }

    if (useCache) this.cache.set(key, doc)
    return doc
  }

  async _ladder(url, { signal, fresh, deadline, useAdapters }) {
    // A bad URL or a private address fails here, before any route, so no
    // reader or archive is ever handed one.
    const parsed = parseFetchUrl(url)
    const host = parsed.hostname
    const tried = []
    let best = null
    let gone = false
    let sawBrowserChallenge = false

    const keep = (name, doc) => {
      if (!best || doc.text.length > best.doc.text.length) best = { name, doc }
    }
    const done = doc => ({
      ...doc,
      fetchedAt: new Date(this.now()).toISOString(),
    })

    /** Runs one route; its document if it passes the quality check, else null. */
    const attempt = async (name, timeoutMs, run, { lenient = false } = {}) => {
      if (!fresh && isStepSkipped(host, name, this.now())) {
        tried.push(`${name}: skipped (recently blocked)`)
        return null
      }
      const remaining = deadline - this.now()
      if (remaining <= 0) {
        tried.push(`${name}: out of time`)
        return null
      }
      const stepSignal = AbortSignal.timeout(Math.min(timeoutMs, remaining))
      const combined = signal
        ? AbortSignal.any([signal, stepSignal])
        : stepSignal
      let outcome
      try {
        outcome = await run(combined)
      } catch (err) {
        // The user's cancel first, then this step's timeout: the transport
        // reports either abort as a cancellation.
        if (signal?.aborted) throw cancelled()
        if (stepSignal.aborted) {
          recordHostFailure(host, name, 'timed out')
          tried.push(`${name}: timed out`)
          return null
        }
        if (!lenient) {
          // Unclassified: a fault, not a refusal. Content: no route can help.
          if (!err?.kind || err.kind === 'content') throw err
          if (
            GONE_STATUSES.has(err.status) &&
            (name === 'direct' ||
              name === 'browser-raw' ||
              name === 'browser-render')
          ) {
            gone = true
          }
          if (
            err.status === 401 ||
            err.status === 403 ||
            err.status === 429 ||
            err.status === 451
          ) {
            recordHostFailure(host, name, `HTTP ${err.status}`)
          }
        }
        tried.push(`${name}: ${reasonOf(err)}`)
        return null
      }
      if (!outcome) {
        tried.push(`${name}: nothing found`)
        return null
      }
      if (outcome.fallback) {
        keep(name, outcome.fallback)
        tried.push(`${name}: metadata only`)
        return null
      }
      const verdict = outcome.quality ?? assessContent({ text: outcome.text })
      if (verdict === 'ok') {
        recordHostSuccess(host, name)
        return { ...outcome, via: outcome.via ?? name }
      }
      if (verdict === 'challenge') {
        sawBrowserChallenge = true
        recordHostFailure(host, name, 'bot check')
      } else if (verdict === 'thin') {
        sawBrowserChallenge = true
        keep(name, outcome)
      }
      tried.push(
        `${name}: ${verdict === 'challenge' ? 'bot check not cleared' : 'too little text'}`
      )
      return null
    }

    // 1. Paid provider readers run first if configured
    if (!gone && this.rotator) {
      const readerPlan =
        typeof this.rotator.plan === 'function'
          ? this.rotator.plan('read')
          : READER_ORDER.filter(name =>
              this.rotator.pool.some(e => e.provider === name)
            ).map(name => ({
              provider: name,
              endpoints: this.rotator.pool.filter(e => e.provider === name),
            }))

      if (readerPlan.length > 0) {
        const firstTimeout = readerTimeoutMs(
          readerPlan[0].provider,
          this.rotator
        )
        const readerBudget = Math.max(40_000, firstTimeout)
        const readerDeadline = Math.min(deadline, this.now() + readerBudget)

        for (const { provider, endpoints } of readerPlan) {
          if (!READERS[provider]) continue
          const timeout = Math.min(
            readerTimeoutMs(provider, this.rotator),
            Math.max(0, readerDeadline - this.now())
          )
          if (timeout <= 0) break

          const doc = await attempt(
            provider,
            timeout,
            stepSignal =>
              READERS[provider](url, {
                signal: stepSignal,
                endpoints,
                rotator: this.rotator,
                router: this.rotator,
                fetchFn: this.fetchFn,
                fresh,
              }),
            { lenient: true }
          )
          if (doc) return done(doc)
        }
      }
    }

    // 2. Built-in fallbacks: adapters, direct fetch, browser, archives
    if (useAdapters) {
      const adapter = matchAdapter(url, this.adapters)
      if (adapter) {
        const doc = await attempt(
          adapter.name,
          STEP_TIMEOUT_MS.adapter,
          stepSignal =>
            adapter.read(
              url,
              adapterContext({
                fetchPage: this.fetchPage,
                signal: stepSignal,
                fresh,
                ladder: target =>
                  this._ladder(target, {
                    signal: stepSignal,
                    fresh,
                    deadline,
                    useAdapters: false,
                  }),
              })
            ),
          // An adapter is a shortcut: when it breaks, read the page normally
          { lenient: true }
        )
        if (doc) return done(doc)
      }
    }

    // Plain fetch: prefer sidecar raw when available, fall back to local direct GET
    let direct = null
    if (this.browser?.available()) {
      direct = await attempt(
        'browser-raw',
        STEP_TIMEOUT_MS.raw,
        async stepSignal => {
          const resp = await this.browser.raw(url, { signal: stepSignal })
          return await documentFromResponse(resp)
        },
        { lenient: true }
      )
    }

    if (!direct) {
      direct = await attempt('direct', STEP_TIMEOUT_MS.direct, stepSignal =>
        directRoute(url, { fetchPage: this.fetchPage, signal: stepSignal })
      )
    }
    if (direct) return done(direct)

    // Full browser render: when sidecar is available
    if (!gone && this.browser?.available()) {
      const doc = await attempt(
        'browser-render',
        STEP_TIMEOUT_MS.render,
        async stepSignal => {
          const resp = await this.browser.render(url, { signal: stepSignal })
          return await documentFromResponse(resp)
        }
      )
      if (doc) return done(doc)
    }

    for (const [name, route] of ARCHIVES) {
      const doc = await attempt(name, STEP_TIMEOUT_MS.archive, stepSignal =>
        route(url, { fetchPage: this.fetchPage, signal: stepSignal })
      )
      if (doc) return done(doc)
    }

    if (best) {
      return done({
        ...best.doc,
        via: best.doc.via ?? best.name,
        partial: true,
      })
    }

    let errorMsg = `Could not read ${url}: ${tried.join(' · ')}.`
    if (sawBrowserChallenge && (!this.browser || !this.browser.available())) {
      errorMsg +=
        ' This page needs a real browser (it runs a bot check or renders in JavaScript); the overleaf-browser sidecar can read it.'
    }

    throw webError(errorMsg, {
      kind: 'ladder-failed',
    })
  }
}
