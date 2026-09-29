import { describe, it, afterEach } from 'vitest'
import { expect } from 'chai'
import sinon from 'sinon'
import Settings from '@overleaf/settings'
import {
  BrowserRoute,
  sharedBrowserRoute,
} from '../../../../app/src/web-fetch/routes/browser.mjs'

const TOKEN = 't'.repeat(32)
const BASE_URL = 'http://overleaf-browser:3000'

function fakeFetch({
  status = 200,
  pageStatus = 200,
  pageUrl = 'https://example.com/dest',
  contentType = 'text/html; charset=utf-8',
  body = '<html><body>Rendered</body></html>',
  truncated = '0',
} = {}) {
  return sinon.stub().callsFake(async (url, init) => {
    if (status >= 400) {
      return new Response(
        JSON.stringify({
          error: 'failed',
          kind: status >= 500 ? 'network' : 'content',
        }),
        {
          status,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }
    return new Response(body, {
      status,
      headers: {
        'Content-Type': contentType,
        'X-Page-Status': String(pageStatus),
        'X-Page-Url': encodeURI(pageUrl),
        'X-Page-Truncated': truncated,
      },
    })
  })
}

describe('BrowserRoute (HTTP client)', function () {
  it('calls /v1/raw with Bearer token and returns DocumentResponse', async function () {
    const fetchFn = fakeFetch({ body: '<html><body>Raw Page</body></html>' })
    const route = new BrowserRoute({ baseUrl: BASE_URL, token: TOKEN, fetchFn })

    const res = await route.raw('https://example.com/src')
    expect(res.url).to.equal('https://example.com/dest')
    expect(res.body.toString('utf8')).to.equal(
      '<html><body>Raw Page</body></html>'
    )
    expect(res.contentType).to.equal('text/html; charset=utf-8')
    expect(res.truncated).to.equal(false)

    expect(fetchFn.calledOnce).to.equal(true)
    const [callUrl, callInit] = fetchFn.firstCall.args
    expect(callUrl).to.equal('http://overleaf-browser:3000/v1/raw')
    expect(callInit.headers.Authorization).to.equal(`Bearer ${TOKEN}`)
    expect(JSON.parse(callInit.body)).to.deep.equal({
      url: 'https://example.com/src',
    })
  })

  it('calls /v1/render with Bearer token and returns DocumentResponse', async function () {
    const fetchFn = fakeFetch({
      body: '<html><body>Rendered Page</body></html>',
    })
    const route = new BrowserRoute({ baseUrl: BASE_URL, token: TOKEN, fetchFn })

    const res = await route.render('https://example.com/src')
    expect(res.url).to.equal('https://example.com/dest')
    expect(res.body.toString('utf8')).to.equal(
      '<html><body>Rendered Page</body></html>'
    )

    const [callUrl] = fetchFn.firstCall.args
    expect(callUrl).to.equal('http://overleaf-browser:3000/v1/render')
  })

  it('maps page HTTP status >= 400 to webError with status and http kind', async function () {
    const fetchFn = fakeFetch({ pageStatus: 404 })
    const route = new BrowserRoute({ baseUrl: BASE_URL, token: TOKEN, fetchFn })

    let error = null
    try {
      await route.raw('https://example.com/gone')
    } catch (err) {
      error = err
    }
    expect(error).to.include({ status: 404, kind: 'http' })
  })

  it('maps sidecar responses and error kinds correctly', async function () {
    // 503 sidecar busy -> network error and marks unavailable
    let clock = 1000
    const fetch503 = fakeFetch({ status: 503 })
    const route = new BrowserRoute({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchFn: fetch503,
      now: () => clock,
    })

    let err503 = null
    try {
      await route.raw('https://example.com/a')
    } catch (err) {
      err503 = err
    }
    expect(err503?.kind).to.equal('network')
    expect(route.available()).to.equal(false)

    clock += 31_000
    expect(route.available()).to.equal(true)

    // 400/403 -> content error
    const fetch403 = fakeFetch({ status: 403 })
    const route403 = new BrowserRoute({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchFn: fetch403,
    })
    let err403 = null
    try {
      await route403.raw('https://example.com/private')
    } catch (err) {
      err403 = err
    }
    expect(err403?.kind).to.equal('content')
  })

  it('sharedBrowserRoute requires both URL and TOKEN', function () {
    const original = Settings.aiAssist
    try {
      Settings.aiAssist = {
        ...original,
        browser: { url: 'http://overleaf-browser:3000', token: null, concurrency: 2 },
      }
      expect(sharedBrowserRoute()).to.equal(null)

      Settings.aiAssist = {
        ...original,
        browser: { url: null, token: TOKEN, concurrency: 2 },
      }
      expect(sharedBrowserRoute()).to.equal(null)

      Settings.aiAssist = {
        ...original,
        browser: {
          url: 'http://overleaf-browser:3000',
          token: TOKEN,
          concurrency: 3,
        },
      }
      const route = sharedBrowserRoute()
      expect(route).to.be.instanceOf(BrowserRoute)
      expect(sharedBrowserRoute()).to.equal(route)
    } finally {
      Settings.aiAssist = original
    }
  })
})
