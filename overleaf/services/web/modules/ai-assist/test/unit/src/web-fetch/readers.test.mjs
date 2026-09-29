import { describe, it, beforeEach } from 'vitest'
import { expect } from 'chai'
import sinon from 'sinon'
import {
  READERS,
  READER_ORDER,
  exaReader,
  jinaHeaders,
  jinaReader,
  ollamaReader,
  readerTimeoutMs,
  websearchapiReader,
} from '../../../../app/src/web-fetch/routes/readers.mjs'
import {
  WebRouter,
  clearEndpointHealth,
} from '../../../../app/src/web-fetch/routing.mjs'
import { normalizeWebSearchSettings } from '../../../../app/src/AiAssistWebTools.mjs'
import { ARTICLE_TEXT } from './helpers/pages.mjs'

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function routerFor(providers) {
  return new WebRouter(normalizeWebSearchSettings({ providers }), {
    healthStore: new Map(),
    ownerStore: new Map(),
  })
}

describe('page readers', function () {
  beforeEach(function () {
    clearEndpointHealth()
  })

  it('are tried in a fixed order', function () {
    expect(READER_ORDER).to.deep.equal([
      'ollama',
      'websearchapi',
      'tavily',
      'firecrawl',
      'firecrawlSelfHosted',
      'jina',
      'exa',
    ])
    expect(Object.keys(READERS)).to.have.members(READER_ORDER)
  })

  it('Exa: reads page content, highlights, and summary with configured options', async function () {
    const fetchFn = sinon.stub().resolves(
      jsonResponse({
        results: [
          {
            url: 'https://example.com/article',
            title: 'Exa Article',
            text: ARTICLE_TEXT,
            publishedDate: '2026-03-15T08:00:00.000Z',
          },
        ],
      })
    )
    const router = routerFor({
      exa: {
        enabled: true,
        apiKeys: ['exa-key-1'],
        read: {
          maxCharacters: 5000,
          highlights: true,
          numSentences: 3,
          summary: true,
          livecrawl: 'always',
          livecrawlTimeout: 25000,
        },
      },
    })
    const endpoints = router.plan('read')[0].endpoints
    const doc = await exaReader('https://example.com/article', {
      endpoints,
      router,
      fetchFn,
    })
    const [url, init] = fetchFn.firstCall.args
    expect(url).to.equal('https://api.exa.ai/contents')
    expect(init.headers['x-api-key']).to.equal('exa-key-1')
    const payload = JSON.parse(init.body)
    expect(payload.urls).to.deep.equal(['https://example.com/article'])
    expect(payload.text).to.deep.equal({ maxCharacters: 5000 })
    expect(payload.highlights).to.deep.equal({ numSentences: 3 })
    expect(payload.summary).to.be.true
    expect(payload.livecrawl).to.equal('always')
    expect(payload.livecrawlTimeout).to.equal(25000)
    expect(doc.title).to.equal('Exa Article')
    expect(doc.published).to.equal('2026-03-15')
    expect(readerTimeoutMs('exa', router)).to.equal(35_000)
  })

  it('Exa: throws when result status indicates error or empty content', async function () {
    const fetchFn = sinon.stub().resolves(
      jsonResponse({
        results: [],
        statuses: [{ id: '1', status: 'error', error: 'Page not found' }],
      })
    )
    const router = routerFor({
      exa: {
        enabled: true,
        apiKeys: ['exa-key-1'],
      },
    })
    const endpoints = router.plan('read')[0].endpoints
    const err = await exaReader('https://example.com/missing', {
      endpoints,
      router,
      fetchFn,
    }).catch(e => e)
    expect(err.message).to.include(
      'could not read https://example.com/missing: Page not found'
    )
  })

  it("Jina: sends the user's options as headers, and skips its cache when fresh", async function () {
    const fetchFn = sinon.stub().resolves(
      jsonResponse({
        code: 200,
        data: {
          title: 'J',
          content: ARTICLE_TEXT,
          httpStatus: 200,
          // Last-Modified, not a publication date
          publishedTime: 'Sat, 26 Sep 2026 09:10:30 GMT',
          metadata: { 'article:published_time': '2026-03-01T10:00:00Z' },
        },
      })
    )
    const router = routerFor({
      jina: {
        enabled: true,
        apiKeys: ['j1'],
        read: { engine: 'browser', removeSelector: 'nav, footer', timeout: 40 },
      },
    })
    const endpoints = router.plan('read')[0].endpoints
    const doc = await jinaReader('https://a.org/', {
      endpoints,
      router,
      fetchFn,
      fresh: true,
    })
    const [url, init] = fetchFn.firstCall.args
    expect(url).to.equal('https://r.jina.ai/')
    expect(JSON.parse(init.body)).to.deep.equal({ url: 'https://a.org/' })
    expect(init.headers).to.deep.equal({
      'Content-Type': 'application/json',
      Authorization: 'Bearer j1',
      Accept: 'application/json',
      'X-Engine': 'browser',
      'X-Timeout': '40',
      'X-Remove-Selector': 'nav, footer',
      'X-No-Cache': 'true',
    })
    expect(doc.title).to.equal('J')
    expect(doc.published).to.equal('2026-03-01')
    expect(readerTimeoutMs('jina', router)).to.equal(50_000)
  })

  it('Jina: sends the token budget, wait selector and cache tolerance, dropping the tolerance when fresh', function () {
    const read = normalizeWebSearchSettings({
      providers: {
        jina: {
          enabled: true,
          apiKeys: ['j1'],
          read: {
            tokenBudget: 5000,
            waitForSelector: '#main',
            cacheTolerance: 600,
          },
        },
      },
    }).providers.jina.read
    expect(jinaHeaders('j1', read)).to.include({
      'X-Token-Budget': '5000',
      'X-Wait-For-Selector': '#main',
      'X-Cache-Tolerance': '600',
    })
    expect(jinaHeaders('j1', read, { fresh: true })).to.not.have.property(
      'X-Cache-Tolerance'
    )
  })

  it('Jina: a page that answered with an error is not content', async function () {
    const fetchFn = sinon.stub().resolves(
      jsonResponse({
        code: 200,
        data: { title: 'Not Found', content: ARTICLE_TEXT, httpStatus: 404 },
      })
    )
    const router = routerFor({ jina: { enabled: true, apiKeys: ['j1'] } })
    const endpoints = router.plan('read')[0].endpoints
    const error = await jinaReader('https://a.org/gone', {
      endpoints,
      router,
      fetchFn,
    }).catch(err => err)
    expect(error.message).to.include('the page returned HTTP 404')
  })

  it('moves to the next key when one is refused, and throws to next provider on 500', async function () {
    const fetchFn = sinon.stub()
    fetchFn
      .onFirstCall()
      .resolves(jsonResponse({ error: 'Too Many Requests' }, 429))
    fetchFn
      .onSecondCall()
      .resolves(jsonResponse({ title: 'T', content: ARTICLE_TEXT }))
    const router = routerFor({
      ollama: { enabled: true, apiKeys: ['k1', 'k2'] },
    })
    const endpoints = router.plan('read')[0].endpoints

    const doc = await ollamaReader('https://a.org/', {
      endpoints,
      router,
      fetchFn,
    })
    expect(fetchFn.secondCall.args[1].headers.Authorization).to.equal(
      'Bearer k2'
    )
    expect(doc.title).to.equal('T')

    const failing = sinon.stub().resolves(jsonResponse({ error: 'boom' }, 500))
    let error
    try {
      const r2 = routerFor({ ollama: { enabled: true, apiKeys: ['k1', 'k2'] } })
      const r2Endpoints = r2.plan('read')[0].endpoints
      await ollamaReader('https://a.org/', {
        endpoints: r2Endpoints,
        router: r2,
        fetchFn: failing,
      })
    } catch (err) {
      error = err
    }
    expect(failing.callCount).to.equal(1)
    expect(error?.status).to.equal(500)
  })

  it('WebSearchAPI.ai: asks the scraper not to use its cache when fresh', async function () {
    const fetchFn = sinon
      .stub()
      .resolves(jsonResponse({ data: { title: 'S', content: ARTICLE_TEXT } }))
    const router = routerFor({
      websearchapi: {
        enabled: true,
        apiKeys: ['w1'],
        scrape: { engine: 'browser' },
      },
    })
    const endpoints = router.plan('read')[0].endpoints
    await websearchapiReader('https://a.org/', {
      endpoints,
      router,
      fetchFn,
      fresh: true,
    })
    expect(JSON.parse(fetchFn.firstCall.args[1].body)).to.deep.equal({
      url: 'https://a.org/',
      returnFormat: 'markdown',
      engine: 'browser',
      noCache: true,
    })
  })

  it('gives the WebSearchAPI.ai scraper its own timeout plus ten seconds', function () {
    const router = routerFor({
      websearchapi: { enabled: true, apiKeys: ['w1'], scrape: { timeout: 40 } },
    })
    expect(readerTimeoutMs('websearchapi', router)).to.equal(50_000)
    expect(readerTimeoutMs('ollama', router)).to.equal(30_000)
  })

  it('does not pause key health on content or challenge errors', async function () {
    const fetchFn = sinon.stub().resolves(
      jsonResponse({
        title: 'Just a moment...',
        content: 'Enable JavaScript and cookies to continue',
      })
    )
    const router = routerFor({ ollama: { enabled: true, apiKeys: ['k1'] } })
    const endpoints = router.plan('read')[0].endpoints
    const doc = await ollamaReader('https://a.org/', {
      endpoints,
      router,
      fetchFn,
    })
    expect(doc.title).to.equal('Just a moment...')
    // Router should still consider the endpoint healthy
    expect(router.isHealthy(endpoints[0])).to.be.true
  })
})
