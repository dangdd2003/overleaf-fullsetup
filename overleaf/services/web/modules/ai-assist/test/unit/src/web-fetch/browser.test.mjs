import { describe, it, afterEach } from 'vitest'
import { expect } from 'chai'
import sinon from 'sinon'
import Settings from '@overleaf/settings'
import {
  BrowserRoute,
  SidecarGate,
  sharedBrowserRoute,
} from '../../../../app/src/web-fetch/routes/browser.mjs'

const TOKEN = 't'.repeat(32)
const BASE_URL = 'http://overleaf-browser:3000'

/**
 * The calls that read a page. The capacity probe (GET /v1/health) that the
 * route makes before its first page read is not one of them.
 */
function pageCalls(fetchFn) {
  return fetchFn
    .getCalls()
    .filter(call => !String(call.args[0]).endsWith('/v1/health'))
}

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

    const res = await route.fetchPage('https://example.com/src')
    expect(res.url).to.equal('https://example.com/dest')
    expect(res.body.toString('utf8')).to.equal(
      '<html><body>Raw Page</body></html>'
    )
    expect(res.contentType).to.equal('text/html; charset=utf-8')
    expect(res.truncated).to.equal(false)

    expect(pageCalls(fetchFn).length).to.equal(1)
    const [callUrl, callInit] = pageCalls(fetchFn)[0].args
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

    const [callUrl] = pageCalls(fetchFn)[0].args
    expect(callUrl).to.equal('http://overleaf-browser:3000/v1/render')
  })

  it('maps page HTTP status >= 400 to webError with status and http kind', async function () {
    const fetchFn = fakeFetch({ pageStatus: 404 })
    const route = new BrowserRoute({ baseUrl: BASE_URL, token: TOKEN, fetchFn })

    let error = null
    try {
      await route.fetchPage('https://example.com/gone')
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
      await route.fetchPage('https://example.com/a')
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
      await route403.fetchPage('https://example.com/private')
    } catch (err) {
      err403 = err
    }
    expect(err403?.kind).to.equal('content')
  })

  it('sharedBrowserRoute is on whenever the URL is set, even without a token', function () {
    const original = Settings.aiAssist
    try {
      Settings.aiAssist = {
        ...original,
        browser: { url: null, token: TOKEN },
      }
      expect(sharedBrowserRoute()).to.equal(null)

      Settings.aiAssist = {
        ...original,
        browser: { url: 'http://overleaf-browser:3000', token: null },
      }
      expect(sharedBrowserRoute()).to.be.instanceOf(BrowserRoute)

      Settings.aiAssist = {
        ...original,
        browser: {
          url: 'http://overleaf-browser:3000',
          token: TOKEN,
        },
      }
      const route = sharedBrowserRoute()
      expect(route).to.be.instanceOf(BrowserRoute)
      expect(sharedBrowserRoute()).to.equal(route)
    } finally {
      Settings.aiAssist = original
    }
  })

  it('refuses every request when the token is missing, without asking the sidecar', async function () {
    const fetchFn = fakeFetch()
    const route = new BrowserRoute({ baseUrl: BASE_URL, token: null, fetchFn })
    let error = null
    try {
      await route.fetchPage('https://example.com/a')
    } catch (err) {
      error = err
    }
    expect(error?.message).to.include('AI_ASSIST_BROWSER_TOKEN is not set')
    expect(error?.kind).to.equal('network')
    expect(fetchFn.called).to.equal(false)
  })

  it('fetchPage reads by /v1/raw with fetchPublicUrl\'s answer and size cap', async function () {
    const fetchFn = fakeFetch({ body: 'x'.repeat(100) })
    const route = new BrowserRoute({ baseUrl: BASE_URL, token: TOKEN, fetchFn })
    const res = await route.fetchPage('https://example.com/src#part', {
      maxBytes: 10,
      headers: { Accept: 'application/json' },
    })
    expect(res).to.include({
      status: 200,
      url: 'https://example.com/dest',
      truncated: true,
    })
    expect(res.body.length).to.equal(10)
    const [callUrl, callInit] = pageCalls(fetchFn)[0].args
    expect(callUrl).to.equal('http://overleaf-browser:3000/v1/raw')
    // The fragment is dropped and no caller header is forwarded
    expect(JSON.parse(callInit.body)).to.deep.equal({
      url: 'https://example.com/src',
    })
  })

  it('fetchPage refuses a private address or a bad port before asking the sidecar', async function () {
    const fetchFn = fakeFetch()
    const route = new BrowserRoute({ baseUrl: BASE_URL, token: TOKEN, fetchFn })
    for (const url of ['http://127.0.0.1/', 'http://[::127.0.0.1]/', 'http://example.com:25/']) {
      let error = null
      try {
        await route.fetchPage(url)
      } catch (err) {
        error = err
      }
      expect(error?.kind, url).to.equal('content')
    }
    expect(fetchFn.called).to.equal(false)
  })

  it('fetchPage and render check the address before asking the sidecar', async function () {
    const fetchFn = fakeFetch()
    const route = new BrowserRoute({ baseUrl: BASE_URL, token: TOKEN, fetchFn })
    for (const read of [
      route.fetchPage('http://127.0.0.1/'),
      route.render('http://user:pw@example.com/'),
    ]) {
      let error = null
      try {
        await read
      } catch (err) {
        error = err
      }
      expect(error?.kind).to.equal('content')
    }
    expect(fetchFn.called).to.equal(false)
  })

  it('stays available after a page the sidecar could not load (502)', async function () {
    const route = new BrowserRoute({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchFn: fakeFetch({ status: 502 }),
    })
    let error = null
    try {
      await route.fetchPage('https://example.com/broken')
    } catch (err) {
      error = err
    }
    expect(error).to.include({ status: 502, kind: 'network' })
    expect(route.available()).to.equal(true)
  })

  it('sends at most `capacity` page reads to the sidecar at once', async function () {
    let inFlight = 0
    let most = 0
    const fetchFn = sinon.stub().callsFake(async url => {
      if (url.endsWith('/v1/health')) {
        return new Response(JSON.stringify({ ok: true, capacity: 2 }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      inFlight++
      most = Math.max(most, inFlight)
      await new Promise(resolve => setTimeout(resolve, 5))
      inFlight--
      return new Response('<html><body>ok</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html', 'X-Page-Status': '200' },
      })
    })
    const route = new BrowserRoute({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchFn,
    })
    await Promise.all(
      [1, 2, 3, 4, 5].map(n => route.fetchPage(`https://example.com/${n}`))
    )
    const reads = fetchFn.getCalls().filter(call => call.args[0].endsWith('/v1/raw'))
    expect(reads.length).to.equal(5)
    expect(most).to.equal(2)
  })

  it('takes its page places from the sidecar capacity in /v1/health', async function () {
    let inFlight = 0
    let most = 0
    const fetchFn = sinon.stub().callsFake(async url => {
      if (url.endsWith('/v1/health')) {
        return new Response(JSON.stringify({ ok: true, capacity: 4 }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      inFlight++
      most = Math.max(most, inFlight)
      await new Promise(resolve => setTimeout(resolve, 5))
      inFlight--
      return new Response('<html><body>ok</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html', 'X-Page-Status': '200' },
      })
    })
    const route = new BrowserRoute({ baseUrl: BASE_URL, token: TOKEN, fetchFn })
    await Promise.all(
      [1, 2, 3, 4, 5, 6].map(n => route.fetchPage(`https://example.com/${n}`))
    )
    expect(most).to.equal(4)
    const healthCalls = fetchFn
      .getCalls()
      .filter(call => call.args[0] === `${BASE_URL}/v1/health`)
    expect(healthCalls.length).to.equal(1)
  })

  it('keeps the fallback of 2 when /v1/health cannot say, and asks again later', async function () {
    let now = 0
    let inFlight = 0
    let most = 0
    const fetchFn = sinon.stub().callsFake(async url => {
      if (url.endsWith('/v1/health')) throw new Error('refused')
      inFlight++
      most = Math.max(most, inFlight)
      await new Promise(resolve => setTimeout(resolve, 5))
      inFlight--
      return new Response('<html><body>ok</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html', 'X-Page-Status': '200' },
      })
    })
    const route = new BrowserRoute({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchFn,
      now: () => now,
    })
    await Promise.all([1, 2, 3, 4].map(n => route.fetchPage(`https://example.com/${n}`)))
    expect(most).to.equal(2)
    await route.fetchPage('https://example.com/5')
    const healthCalls = () =>
      fetchFn.getCalls().filter(call => call.args[0] === `${BASE_URL}/v1/health`)
    expect(healthCalls().length).to.equal(1)
    now += 31_000
    await route.fetchPage('https://example.com/6')
    expect(healthCalls().length).to.equal(2)
  })

  it('SidecarGate.resize lets waiting requests in when it grows', async function () {
    const gate = new SidecarGate(1)
    const first = await gate.acquire()
    let second = false
    const waiting = gate.acquire().then(() => {
      second = true
    })
    await Promise.resolve()
    expect(second).to.equal(false)
    gate.resize(2)
    await waiting
    expect(second).to.equal(true)
    first()
  })

  it('fetchFile reads a small file by /v1/fetch without waiting for page reads', async function () {
    let releaseRead
    const fetchFn = sinon.stub().callsFake(async url => {
      if (url.endsWith('/v1/raw')) {
        await new Promise(resolve => {
          releaseRead = resolve
        })
      }
      return new Response(Buffer.from([0, 0, 1, 0]), {
        status: 200,
        headers: { 'Content-Type': 'image/x-icon', 'X-Page-Status': '200' },
      })
    })
    const route = new BrowserRoute({
      baseUrl: BASE_URL,
      token: TOKEN,
      capacity: 1,
      fetchFn,
    })
    // The only page place is taken by a read that has not finished
    const read = route.fetchPage('https://example.com/slow')
    const icon = await route.fetchFile('https://example.com/favicon.ico', {
      maxBytes: 1024,
    })
    const head = await route.fetchFile('https://example.com/', { head: true })
    expect(head.contentType).to.equal('image/x-icon')
    expect(icon.contentType).to.equal('image/x-icon')
    expect(icon.body.length).to.equal(4)
    const [, init] = fetchFn
      .getCalls()
      .find(call => call.args[0] === `${BASE_URL}/v1/fetch`).args
    expect(JSON.parse(init.body)).to.deep.equal({
      url: 'https://example.com/favicon.ico',
    })
    const headCall = fetchFn
      .getCalls()
      .filter(call => call.args[0] === `${BASE_URL}/v1/fetch`)[1]
    expect(JSON.parse(headCall.args[1].body)).to.deep.equal({
      url: 'https://example.com/',
      head: true,
    })
    releaseRead()
    await read
    let refused = null
    try {
      await route.fetchFile('http://127.0.0.1/favicon.ico')
    } catch (err) {
      refused = err
    }
    expect(refused?.message).to.match(/not a public address/)
    // The raw read, then the two icon fetches; only the raw read probed capacity
    expect(pageCalls(fetchFn).length).to.equal(3)
    const probes = fetchFn
      .getCalls()
      .filter(call => call.args[0] === `${BASE_URL}/v1/health`)
    expect(probes.length).to.equal(1)
  })

  it('sends at most 8 small-file fetches at once, so a burst never overruns the gateway', async function () {
    let inFlight = 0
    let most = 0
    const fetchFn = sinon.stub().callsFake(async () => {
      inFlight++
      most = Math.max(most, inFlight)
      await new Promise(resolve => setTimeout(resolve, 5))
      inFlight--
      return new Response(Buffer.from([0, 0, 1, 0]), {
        status: 200,
        headers: { 'Content-Type': 'image/x-icon', 'X-Page-Status': '200' },
      })
    })
    const route = new BrowserRoute({ baseUrl: BASE_URL, token: TOKEN, fetchFn })
    await Promise.all(
      Array.from({ length: 20 }, (_, n) =>
        route.fetchFile(`https://site${n}.example/favicon.ico`)
      )
    )
    expect(fetchFn.callCount).to.equal(20)
    expect(most).to.equal(8)
  })

  it('a request that runs out of time does not mark the sidecar down', async function () {
    const fetchFn = sinon.stub().callsFake(
      (url, init) =>
        new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(init.signal.reason)
          )
        })
    )
    const route = new BrowserRoute({ baseUrl: BASE_URL, token: TOKEN, fetchFn })
    let error = null
    try {
      await route.fetchFile('https://example.com/favicon.ico', {
        timeoutMs: 20,
      })
    } catch (err) {
      error = err
    }
    expect(error?.kind).to.equal('network')
    expect(route.available()).to.equal(true)
  })

  it('stops waiting for a place when the request is cancelled', async function () {
    const gate = new SidecarGate(1)
    const hold = await gate.acquire()
    const controller = new AbortController()
    const waiting = gate.acquire({ signal: controller.signal })
    controller.abort()
    let error = null
    try {
      await waiting
    } catch (err) {
      error = err
    }
    expect(error?.code).to.equal('aborted')
    hold()
    expect(gate.busy).to.equal(0)
    expect(gate.waiting.length).to.equal(0)
  })

  it('safely handles malformed percent-encoded redirect URL in X-Page-Url header without throwing URIError', async function () {
    // Malformed percent-encoding like %E0%A4 that causes decodeURI to throw URIError
    const malformedUrl = 'https://example.com/dest?q=%E0%A4'
    const fetchFn = sinon.stub().callsFake(async () => {
      return new Response('<html><body>Page with bad redirect header</body></html>', {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'X-Page-Status': '200',
          'X-Page-Url': malformedUrl,
          'X-Page-Truncated': '0',
        },
      })
    })

    const route = new BrowserRoute({ baseUrl: BASE_URL, token: TOKEN, fetchFn })
    const res = await route.fetchPage('https://example.com/src')
    expect(res.url).to.equal(malformedUrl)
    expect(res.body.toString('utf8')).to.equal(
      '<html><body>Page with bad redirect header</body></html>'
    )
  })
})
