import { ProviderError } from '../AiAssistProviders.mjs'
import { adapterContext } from './adapters/common.mjs'
import { ADAPTERS, matchAdapter } from './adapters/index.mjs'
import { documentFromResponse, makeDocument } from './document.mjs'
import { assessContent } from './quality.mjs'
import {
  keepWorkingDocument,
  takeSearchPage,
  workingDocument,
} from './working-set.mjs'
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
 *   working set → cache → a search's page text → paid readers → site adapter
 *     → the page (direct GET, or the browser's raw read then render) → archives
 *
 * Configured provider readers run first; built-in fallbacks are tried only when
 * no provider is configured or all reader attempts fail. With the browser
 * sidecar configured, every request the fallbacks make (adapter, page,
 * archive) goes through it and none is ever made directly, even when the
 * browser fails. A reader slow to
 * answer is hedged: the next one starts alongside it and the first real
 * document wins. Every document passes the quality check, so a bot check or an
 * empty JavaScript shell counts as that route failing.
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
/**
 * How long a reader has before the next one is started alongside it. Most
 * readers answer well inside this; a slow one no longer holds up the read.
 */
export const READER_HEDGE_MS = 4000
// owner + cacheKey -> the read in flight, shared by every reader of the page
// in this process: parallel calls, a prefetch, and the browser's fix runs,
// which get a new WebFetcher per request
const inFlight = new Map()

export function clearFailureCache() {
  failureCache.clear()
}

/** How many reads are in flight in this process: for tests. */
export function readsInFlight() {
  return inFlight.size
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
    hedgeMs = READER_HEDGE_MS,
    owner = 'default',
    now = () => Date.now(),
  } = {}) {
    this.browser = browser
    // With the browser sidecar configured, every request this fetcher makes
    // on its own goes through it; `fetchPage` (a direct request) is never used
    this.fetchPage = browser
      ? (target, options) => browser.fetchPage(target, options)
      : fetchPage
    this.fetchFn = fetchFn
    this.rotator = rotator
    this.cache = cache
    this.cacheHours = cacheHours
    this.adapters = adapters
    this.budgetMs = budgetMs
    this.hedgeMs = hedgeMs
    this.owner = String(owner ?? 'default')
    this.now = now
  }

  /**
   * The document for `url`: unless `fresh`, from the working set, the cache
   * or the page text a search returned, else read by the ladder. Stamped with
   * `via` (the route that read it) and `fetchedAt`.
   */
  async read(url, { signal, fresh = false } = {}) {
    if (signal?.aborted) throw cancelled()
    const key = cacheKeyFor(url)
    const maxAgeMs = this.cacheHours * HOUR_MS
    const useCache = Boolean(this.cache) && maxAgeMs > 0

    if (!fresh) {
      const working = workingDocument(this.owner, key)
      if (working) return working

      if (useCache) {
        const cached = this.cache.get(key, maxAgeMs)
        const stale =
          cached?.partial &&
          this.now() - Date.parse(cached.fetchedAt) > PARTIAL_TTL_MS
        if (cached && !stale) {
          if (!cached.partial) keepWorkingDocument(this.owner, key, cached)
          return cached
        }
      }

      const searched = this._fromSearchPage(key)
      if (searched) {
        this._store(key, searched, useCache)
        return searched
      }

      const failed = failureCache.get(key)
      if (failed && this.now() - failed.at < FAILURE_TTL_MS) {
        throw failed.error
      }
    }

    // Calls for one page at the same time (page 1 and a find, a prefetch and
    // the model's own read) share one read
    if (fresh) return this._readAndStore(url, key, { signal, fresh, useCache })
    const id = `${this.owner}\n${key}`
    let reading = inFlight.get(id)
    const joined = Boolean(reading)
    if (!reading) {
      reading = this._readAndStore(url, key, {
        signal,
        fresh,
        useCache,
      }).finally(() => inFlight.delete(id))
      inFlight.set(id, reading)
    }
    try {
      return await reading
    } catch (err) {
      // The read joined was cancelled by its own caller, not by this one
      if (joined && err?.code === 'aborted' && !signal?.aborted) {
        return this._readAndStore(url, key, { signal, fresh, useCache })
      }
      throw err
    }
  }

  /**
   * The page text a search already returned for `key`, as a document, when it
   * is real content. Used once: after this the document is cached.
   */
  _fromSearchPage(key) {
    const page = takeSearchPage(this.owner, key)
    if (!page) return null
    try {
      const doc = makeDocument({
        url: page.url,
        title: page.title,
        text: page.text,
        published: page.published,
        format: page.format,
      })
      if (assessContent({ text: doc.text }) !== 'ok') return null
      return {
        ...doc,
        via: page.via,
        fetchedAt: new Date(this.now()).toISOString(),
      }
    } catch {
      return null
    }
  }

  /**
   * Keeps a document under `key`, and under the address it was read from
   * when a redirect led elsewhere, so either spelling finds it next time.
   */
  _store(key, doc, useCache) {
    const keys = [key]
    const landed = cacheKeyFor(doc.url)
    if (landed && landed !== key) keys.push(landed)
    for (const each of keys) {
      if (useCache) this.cache.set(each, doc)
      if (!doc.partial) keepWorkingDocument(this.owner, each, doc)
    }
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

    this._store(key, doc, useCache)
    return doc
  }

  /**
   * The configured readers, in plan order, hedged: each gets `hedgeMs` to
   * answer before the next starts alongside it, and a failure starts the next
   * at once. The first real document wins and the others are cancelled.
   */
  async _hedgedReaders(url, readerPlan, attempt, { fresh, readerDeadline }) {
    const race = new AbortController()
    const running = new Map()
    let next = 0
    let launched = 0
    const launch = () => {
      while (next < readerPlan.length) {
        const { provider, endpoints } = readerPlan[next++]
        if (!READERS[provider]) continue
        const timeout = Math.min(
          readerTimeoutMs(provider, this.rotator),
          Math.max(0, readerDeadline - this.now())
        )
        if (timeout <= 0) return
        const id = ++launched
        running.set(
          id,
          attempt(
            provider,
            timeout,
            stepSignal =>
              READERS[provider](url, {
                signal: AbortSignal.any([stepSignal, race.signal]),
                endpoints,
                rotator: this.rotator,
                router: this.rotator,
                fetchFn: this.fetchFn,
                fresh,
              }),
            { lenient: true }
          ).then(
            doc => ({ id, doc }),
            error => ({ id, error })
          )
        )
        return
      }
    }

    try {
      launch()
      while (running.size > 0) {
        let timer
        const hedge = new Promise(resolve => {
          timer = setTimeout(() => resolve(null), this.hedgeMs)
          timer.unref?.()
        })
        const outcome = await Promise.race([...running.values(), hedge])
        clearTimeout(timer)
        if (outcome === null) {
          launch()
          continue
        }
        running.delete(outcome.id)
        // Only the user's cancel gets here: a reader's own failure is a null
        if (outcome.error) throw outcome.error
        if (outcome.doc) return outcome.doc
        launch()
      }
      return null
    } finally {
      race.abort()
    }
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
        const doc = await this._hedgedReaders(url, readerPlan, attempt, {
          fresh,
          readerDeadline,
        })
        if (doc) return done(doc)
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

    // The page itself, by this.fetchPage: the browser's raw read when the
    // browser is configured, else a direct GET. Never both.
    const page = await attempt(
      this.browser ? 'browser-raw' : 'direct',
      this.browser ? STEP_TIMEOUT_MS.raw : STEP_TIMEOUT_MS.direct,
      stepSignal =>
        directRoute(url, { fetchPage: this.fetchPage, signal: stepSignal })
    )
    if (page) return done(page)

    // A full render, for a page that needs JavaScript or runs a bot check
    if (!gone && this.browser) {
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
    if (sawBrowserChallenge && !this.browser) {
      errorMsg +=
        ' This page needs a real browser (it runs a bot check or renders in JavaScript); the overleaf-browser sidecar can read it.'
    }

    throw webError(errorMsg, {
      // The sidecar went down during this read: not remembered as the page's
      // failure, so the next read tries again once it is back
      kind:
        this.browser && !this.browser.available() ? 'network' : 'ladder-failed',
    })
  }
}
