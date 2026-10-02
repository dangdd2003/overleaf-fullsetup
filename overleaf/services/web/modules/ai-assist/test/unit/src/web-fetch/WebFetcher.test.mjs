import { describe, it, beforeEach } from 'vitest'
import { expect } from 'chai'
import sinon from 'sinon'
import {
  WebFetcher,
  clearFailureCache,
  readsInFlight,
} from '../../../../app/src/web-fetch/WebFetcher.mjs'
import {
  clearWorkingSet,
  keepSearchPage,
} from '../../../../app/src/web-fetch/working-set.mjs'
import {
  documentFromResponse,
  makeDocument,
} from '../../../../app/src/web-fetch/document.mjs'
import { webError } from '../../../../app/src/web-fetch/util.mjs'
import { ProviderError } from '../../../../app/src/AiAssistProviders.mjs'
import { WebRouter } from '../../../../app/src/web-fetch/routing.mjs'
import { clearHostMemory } from '../../../../app/src/web-fetch/host-memory.mjs'
import {
  EndpointRotator,
  clearEndpointHealth,
  normalizeWebSearchSettings,
} from '../../../../app/src/AiAssistWebTools.mjs'
import {
  ARTICLE_TEXT,
  CLOUDFLARE_CHALLENGE,
  articlePage,
  htmlResponse,
  spaShell,
} from './helpers/pages.mjs'

const PAGE = 'https://example.com/a'
const refused = status =>
  webError(`${PAGE} returned HTTP ${status}.`, { status, kind: 'http' })

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * A fetchPage stub: `page` answers the page itself (a response, or an error
 * to throw); the archives have no copy unless `wayback` is given.
 */
function site({ page, wayback } = {}) {
  return sinon.stub().callsFake(async url => {
    if (url.startsWith('https://archive.org/wayback/available')) {
      const closest = wayback
        ? { available: true, status: '200', timestamp: '20260407153000' }
        : undefined
      return {
        url,
        contentType: 'application/json',
        body: Buffer.from(
          JSON.stringify({ archived_snapshots: closest ? { closest } : {} })
        ),
      }
    }
    if (url.startsWith('https://web.archive.org/'))
      return htmlResponse(url, wayback)
    if (url.startsWith('https://archive.ph/')) throw refused(404)
    if (page instanceof Error) throw page
    return htmlResponse(url, page)
  })
}

function rotatorFor(providers) {
  return new WebRouter(normalizeWebSearchSettings({ providers }), {
    healthStore: new Map(),
    ownerStore: new Map(),
  })
}

function memoryCache() {
  const map = new Map()
  return {
    map,
    get: key => map.get(key) ?? null,
    set: (key, value) => map.set(key, value),
  }
}

describe('WebFetcher', function () {
  beforeEach(function () {
    clearEndpointHealth()
    clearHostMemory()
    clearFailureCache()
    clearWorkingSet()
  })

  it('returns the direct read when it is real content', async function () {
    const fetcher = new WebFetcher({ fetchPage: site({ page: articlePage() }) })
    const doc = await fetcher.read(PAGE)
    expect(doc.via).to.equal('direct')
    expect(doc.fetchedAt).to.match(/^\d{4}-\d{2}-\d{2}T/)
    expect(doc.text).to.include('siunitx')
  })

  it('reads a page once for calls made at the same time', async function () {
    const fetchPage = site({ page: articlePage() })
    const fetcher = new WebFetcher({ fetchPage })

    const [first, second] = await Promise.all([
      fetcher.read(PAGE),
      fetcher.read('https://www.example.com/a/'),
    ])

    expect(fetchPage.callCount).to.equal(1)
    expect(second).to.equal(first)
    expect(readsInFlight()).to.equal(0)
  })

  it('hands the failure of a shared read to every caller', async function () {
    // How many requests one failing read makes, whatever routes it climbs
    const alone = site({ page: refused(500) })
    await new WebFetcher({ fetchPage: alone }).read(PAGE).catch(() => {})
    clearFailureCache()
    clearHostMemory()

    const fetchPage = site({ page: refused(500) })
    const fetcher = new WebFetcher({ fetchPage })
    const outcomes = await Promise.allSettled([
      fetcher.read(PAGE),
      fetcher.read(PAGE),
    ])

    expect(outcomes.map(outcome => outcome.status)).to.deep.equal([
      'rejected',
      'rejected',
    ])
    expect(outcomes[1].reason).to.equal(outcomes[0].reason)
    expect(fetchPage.callCount).to.equal(alone.callCount)
    expect(readsInFlight()).to.equal(0)
  })

  it('moves past a refused direct read to the browser', async function () {
    const browserDocResponse = {
      url: PAGE,
      contentType: 'text/html; charset=utf-8',
      body: Buffer.from(articlePage()),
      truncated: false,
    }
    const browser = {
      available: () => true,
      raw: sinon.stub().rejects(refused(403)),
      render: sinon.stub().resolves(browserDocResponse),
    }
    const fetcher = new WebFetcher({
      fetchPage: site({ page: refused(403) }),
      browser,
    })
    const doc = await fetcher.read(PAGE)
    expect(doc.via).to.equal('browser-render')
    expect(browser.render.calledOnceWith(PAGE)).to.equal(true)
  })

  it('treats a bot check as a failure and keeps climbing', async function () {
    const fetchFn = sinon
      .stub()
      .resolves(jsonResponse({ title: 'Ollama', content: ARTICLE_TEXT }))
    const fetcher = new WebFetcher({
      fetchPage: site({ page: CLOUDFLARE_CHALLENGE }),
      fetchFn,
      rotator: rotatorFor({ ollama: { enabled: true, apiKeys: ['o1'] } }),
    })
    const doc = await fetcher.read(PAGE)
    expect(doc.via).to.equal('ollama')
  })

  // Review Focus 3: Provider-first flow
  it('asks paid readers before site adapters and direct fetch', async function () {
    const fetchPage = site({ page: articlePage() })
    const fetchFn = sinon
      .stub()
      .callsFake(async url =>
        url.startsWith('https://ollama.com')
          ? jsonResponse({ error: 'down' }, 500)
          : jsonResponse({ data: { title: 'W', content: ARTICLE_TEXT } })
      )
    const browser = {
      available: () => true,
      read: sinon.stub().resolves(articlePage()),
    }
    const fetcher = new WebFetcher({
      fetchPage,
      fetchFn,
      browser,
      rotator: rotatorFor({
        ollama: { enabled: true, apiKeys: ['o1'] },
        websearchapi: { enabled: true, apiKeys: ['w1'] },
      }),
    })
    const doc = await fetcher.read(PAGE)
    expect(doc.via).to.equal('websearchapi')
    // Readers were called before any direct fetchPage or browser call
    expect(fetchFn.firstCall.args[0]).to.equal(
      'https://ollama.com/api/web_fetch'
    )
    expect(fetchFn.secondCall.args[0]).to.equal(
      'https://api.websearchapi.ai/scrape'
    )
    expect(fetchPage.called).to.equal(false)
    expect(browser.read.called).to.equal(false)
  })

  // Review Focus 3
  it("rejects a reader's bot-check text and moves on", async function () {
    const fetchFn = sinon.stub().callsFake(async url =>
      url === 'https://ollama.com/api/web_fetch'
        ? jsonResponse({
            title: 'Just a moment...',
            content:
              'Just a moment... Enable JavaScript and cookies to continue',
          })
        : jsonResponse({ data: { title: 'W', content: ARTICLE_TEXT } })
    )
    const fetcher = new WebFetcher({
      fetchPage: site({ page: refused(403) }),
      fetchFn,
      rotator: rotatorFor({
        ollama: { enabled: true, apiKeys: ['o1'] },
        websearchapi: { enabled: true, apiKeys: ['w1'] },
      }),
    })
    const doc = await fetcher.read(PAGE)
    expect(doc.via).to.equal('websearchapi')
  })

  it('goes straight to the archives when the page is gone', async function () {
    const browser = { available: () => true, read: sinon.stub() }
    const fetcher = new WebFetcher({
      fetchPage: site({ page: refused(404), wayback: articlePage() }),
      browser,
    })
    const doc = await fetcher.read(PAGE)
    expect(doc.via).to.equal('wayback')
    expect(doc.archived).to.equal('2026-04-07')
    expect(browser.read.called).to.equal(false)
  })

  it('stops at once for a private address', async function () {
    const fetchPage = site({ page: articlePage() })
    const fetcher = new WebFetcher({ fetchPage })
    let error
    try {
      await fetcher.read('http://127.0.0.1:8080/admin')
    } catch (err) {
      error = err
    }
    expect(error?.message).to.match(/not a public address/)
    expect(fetchPage.called).to.equal(false)
  })

  it('returns the longest thin read as partial when nothing better works', async function () {
    const shellWithTeaser = spaShell().replace(
      '<div id="root"></div>',
      '<div id="root"></div><p>Short teaser text.</p>'
    )
    const fetcher = new WebFetcher({
      fetchPage: site({ page: shellWithTeaser }),
    })
    const doc = await fetcher.read(PAGE)
    expect(doc.partial).to.equal(true)
    expect(doc.via).to.equal('direct')
  })

  it('names every route it tried when all fail', async function () {
    const fetcher = new WebFetcher({ fetchPage: site({ page: refused(403) }) })
    let error
    try {
      await fetcher.read(PAGE)
    } catch (err) {
      error = err
    }
    expect(error?.message).to.match(
      /^Could not read https:\/\/example\.com\/a: direct: HTTP 403 · wayback: .*no archived copy · archive\.today: .*no archive\.today copy\.$/
    )
  })

  it('stops climbing when the time budget is spent', async function () {
    let clock = 0
    const fetchPage = sinon.stub().callsFake(async () => {
      clock += 100_000
      throw refused(403)
    })
    const fetcher = new WebFetcher({ fetchPage, now: () => clock })
    let error
    try {
      await fetcher.read(PAGE)
    } catch (err) {
      error = err
    }
    expect(fetchPage.callCount).to.equal(1)
    expect(error?.message).to.include('wayback: out of time')
  })

  it('stops when the user cancels', async function () {
    const controller = new AbortController()
    controller.abort()
    const fetchPage = sinon.stub().callsFake(async (url, { signal }) => {
      if (signal.aborted)
        throw new ProviderError('Request was cancelled', { code: 'aborted' })
      return htmlResponse(url, articlePage())
    })
    let error
    try {
      await new WebFetcher({ fetchPage }).read(PAGE, {
        signal: controller.signal,
      })
    } catch (err) {
      error = err
    }
    expect(error?.code).to.equal('aborted')
  })

  it('surfaces an unexpected fault unchanged', async function () {
    const fetcher = new WebFetcher({
      fetchPage: sinon.stub().rejects(new Error('boom')),
    })
    let error
    try {
      await fetcher.read(PAGE)
    } catch (err) {
      error = err
    }
    expect(error?.message).to.equal('boom')
  })

  it('reuses the cache unless asked for a fresh read', async function () {
    const fetchPage = site({ page: articlePage() })
    const cache = memoryCache()
    const fetcher = new WebFetcher({ fetchPage, cache, cacheHours: 24 })
    await fetcher.read(PAGE)
    await fetcher.read(PAGE)
    expect(fetchPage.callCount).to.equal(1)
    await fetcher.read(PAGE, { fresh: true })
    expect(fetchPage.callCount).to.equal(2)
  })

  it('retries a partial result once it is ten minutes old', async function () {
    const fetchPage = site({ page: articlePage() })
    const cache = memoryCache()
    cache.set(PAGE, {
      ...makeDocument({ url: PAGE, title: 'Old', text: 'Teaser only' }),
      partial: true,
      fetchedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
    })
    const doc = await new WebFetcher({ fetchPage, cache, cacheHours: 24 }).read(
      PAGE
    )
    expect(fetchPage.calledOnce).to.equal(true)
    expect(doc.partial).to.equal(undefined)
  })

  it("keeps an adapter's fallback as the partial answer", async function () {
    const adapter = {
      name: 'fake',
      match: () => true,
      read: async url => ({
        fallback: makeDocument({ url, title: 'Meta', text: 'Abstract only.' }),
      }),
    }
    const fetcher = new WebFetcher({
      fetchPage: site({ page: refused(403) }),
      adapters: [adapter],
    })
    const doc = await fetcher.read(PAGE)
    expect(doc).to.include({
      partial: true,
      via: 'fake',
      text: 'Abstract only.',
    })
  })

  it('carries on past an adapter that fails', async function () {
    const adapter = {
      name: 'broken',
      match: () => true,
      read: async () => {
        throw new Error('bug')
      },
    }
    const fetcher = new WebFetcher({
      fetchPage: site({ page: articlePage() }),
      adapters: [adapter],
    })
    expect((await fetcher.read(PAGE)).via).to.equal('direct')
  })

  it('uses sidecar raw as plain fetch and falls back to local direct when sidecar is unavailable', async function () {
    const rawDocResponse = {
      url: PAGE,
      contentType: 'text/html; charset=utf-8',
      body: Buffer.from(articlePage()),
      truncated: false,
    }
    const browser = {
      available: sinon.stub().returns(true),
      raw: sinon.stub().resolves(rawDocResponse),
      render: sinon.stub(),
    }
    const fetchPage = site({ page: refused(403) })
    const fetcher = new WebFetcher({ fetchPage, browser })
    const doc = await fetcher.read(PAGE)
    expect(doc.via).to.equal('browser-raw')
    expect(browser.raw.calledOnceWith(PAGE)).to.equal(true)
    expect(fetchPage.called).to.equal(false)

    // When sidecar raw throws network error, falls back to directRoute
    clearWorkingSet()
    browser.raw.rejects(webError('sidecar down', { kind: 'network' }))
    const directFetchPage = site({ page: articlePage() })
    const fallbackFetcher = new WebFetcher({
      fetchPage: directFetchPage,
      browser,
    })
    const fallbackDoc = await fallbackFetcher.read(PAGE)
    expect(fallbackDoc.via).to.equal('direct')
    expect(directFetchPage.called).to.equal(true)
  })

  it('runs sidecar render when raw / direct yields a bot check', async function () {
    const renderDocResponse = {
      url: PAGE,
      contentType: 'text/html; charset=utf-8',
      body: Buffer.from(articlePage()),
      truncated: false,
    }
    const browser = {
      available: sinon.stub().returns(true),
      raw: sinon.stub().rejects(refused(403)),
      render: sinon.stub().resolves(renderDocResponse),
    }
    const fetchPage = site({ page: CLOUDFLARE_CHALLENGE })
    const fetcher = new WebFetcher({ fetchPage, browser })
    const doc = await fetcher.read(PAGE)
    expect(doc.via).to.equal('browser-render')
    expect(browser.render.calledOnceWith(PAGE)).to.equal(true)
  })

  it('caches failures for 10 minutes unless fresh is true', async function () {
    const fetchPage = sinon.stub().rejects(refused(403))
    const fetcher = new WebFetcher({ fetchPage })

    let err1
    try {
      await fetcher.read(PAGE)
    } catch (e) {
      err1 = e
    }
    expect(err1).to.exist
    const callsAfterFirst = fetchPage.callCount

    // Immediate second call should hit failure cache
    let err2
    try {
      await fetcher.read(PAGE)
    } catch (e) {
      err2 = e
    }
    expect(err2.message).to.equal(err1.message)
    expect(fetchPage.callCount).to.equal(callsAfterFirst)

    // fresh: true bypasses failure cache
    try {
      await fetcher.read(PAGE, { fresh: true })
    } catch {}
    expect(fetchPage.callCount).to.be.greaterThan(callsAfterFirst)
  })

  it('skips host steps remembered in host-memory unless fresh is true', async function () {
    clearHostMemory()
    const fetchPage = sinon.stub().rejects(refused(403))
    const fetcher = new WebFetcher({ fetchPage })

    try {
      await fetcher.read(PAGE, { fresh: true })
    } catch {}
    const firstRunCalls = fetchPage.callCount

    // On subsequent fetch, direct route is skipped due to host memory
    try {
      await fetcher.read(PAGE, { fresh: false })
    } catch {}
    // Only archive routes should have been attempted
    expect(fetchPage.callCount).to.be.lessThan(firstRunCalls * 2)
  })

  it('starts the next reader alongside one slow to answer', async function () {
    let slowSignal = null
    const fetchFn = sinon.stub().callsFake((url, init) => {
      if (url.startsWith('https://ollama.com')) {
        slowSignal = init?.signal
        // Answers only when cancelled
        return new Promise((resolve, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          )
        )
      }
      return Promise.resolve(
        jsonResponse({ data: { title: 'W', content: ARTICLE_TEXT } })
      )
    })
    const fetcher = new WebFetcher({
      fetchPage: site({ page: articlePage() }),
      fetchFn,
      hedgeMs: 20,
      rotator: rotatorFor({
        ollama: { enabled: true, apiKeys: ['o1'] },
        websearchapi: { enabled: true, apiKeys: ['w1'] },
      }),
    })
    const started = Date.now()
    const doc = await fetcher.read(PAGE)
    expect(doc.via).to.equal('websearchapi')
    expect(Date.now() - started).to.be.lessThan(5000)
    // The slow reader is cancelled once another has answered
    expect(slowSignal?.aborted).to.equal(true)
  })

  it('reads a page from the text a search returned for it', async function () {
    const fetchPage = site({ page: articlePage() })
    keepSearchPage('u1', PAGE, {
      url: PAGE,
      title: 'From search',
      text: ARTICLE_TEXT,
      format: 'markdown',
      via: 'tavily',
    })
    const cache = memoryCache()
    const fetcher = new WebFetcher({
      fetchPage,
      cache,
      cacheHours: 24,
      owner: 'u1',
    })
    const doc = await fetcher.read(PAGE)
    expect(doc.via).to.equal('tavily')
    expect(doc.title).to.equal('From search')
    expect(fetchPage.called).to.equal(false)
    expect(cache.map.has(PAGE)).to.equal(true)
    // Another user's read does not see it
    clearWorkingSet()
    const other = new WebFetcher({ fetchPage, owner: 'u2' })
    expect((await other.read(PAGE)).via).to.equal('direct')
  })

  it('keeps a redirected page under both addresses', async function () {
    const landed = 'https://example.com/b'
    const fetchPage = sinon
      .stub()
      .callsFake(async () => htmlResponse(landed, articlePage()))
    const cache = memoryCache()
    const fetcher = new WebFetcher({ fetchPage, cache, cacheHours: 24 })
    await fetcher.read(PAGE)
    clearWorkingSet()
    const again = await fetcher.read(landed)
    expect(again.url).to.equal(landed)
    expect(fetchPage.callCount).to.equal(1)
  })

  it('answers later reads from memory even with caching off', async function () {
    const fetchPage = site({ page: articlePage() })
    const fetcher = new WebFetcher({ fetchPage, cacheHours: 0 })
    const first = await fetcher.read(PAGE)
    const second = await new WebFetcher({ fetchPage, cacheHours: 0 }).read(
      PAGE
    )
    expect(second).to.equal(first)
    expect(fetchPage.callCount).to.equal(1)
  })

  it('appends plain error message when bot check fails without browser', async function () {
    const fetchPage = sinon
      .stub()
      .resolves(htmlResponse(PAGE, CLOUDFLARE_CHALLENGE))
    const fetcher = new WebFetcher({ fetchPage, browser: null })

    let error = null
    try {
      await fetcher.read(PAGE, { fresh: true })
    } catch (e) {
      error = e
    }
    expect(error).to.exist
    expect(error.message).to.include(
      'This page needs a real browser (it runs a bot check or renders in JavaScript); the overleaf-browser sidecar can read it.'
    )
  })
})
