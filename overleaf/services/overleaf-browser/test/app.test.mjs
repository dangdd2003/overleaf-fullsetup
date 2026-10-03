import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../app.mjs'

const TEST_TOKEN = 'a'.repeat(32)

function fakeEngine({
  rawContent = '<html><body>Raw Page</body></html>',
  renderContent = '<html><body>Rendered Page</body></html>',
  status = 200,
  finalUrl = 'https://example.com/dest',
  contentType = 'text/html; charset=utf-8',
  rawChallenge = false,
} = {}) {
  return {
    version: () => 'Chrome 146.0.7680.31',
    raw: async () => ({
      status,
      finalUrl,
      contentType,
      body: Buffer.from(rawContent),
      challenge: rawChallenge,
    }),
    render: async () => ({
      status,
      finalUrl,
      contentType,
      body: Buffer.from(renderContent),
      challenge: false,
    }),
  }
}

async function listen(server) {
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return server.address().port
}

function post(port, path, url, init = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TEST_TOKEN}`,
    },
    body: JSON.stringify({ url }),
    ...init,
  })
}

function shut(app) {
  app.closeAllConnections()
  app.close()
}

test('GET /v1/health returns health info without authentication', async () => {
  const app = createApp({
    token: TEST_TOKEN,
    engine: fakeEngine(),
    capacity: 4,
  })
  const port = await listen(app)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/health`)
    assert.equal(res.status, 200)
    const json = await res.json()
    assert.deepEqual(json, {
      ok: true,
      api: 1,
      engine: 'patchright-chrome',
      browser: 'Chrome 146.0.7680.31',
      busy: 0,
      capacity: 4,
    })
  } finally {
    shut(app)
  }
})

test('rejects requests with missing or invalid bearer token in constant time', async () => {
  const app = createApp({ token: TEST_TOKEN, engine: fakeEngine() })
  const port = await listen(app)
  try {
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/raw`, {
      method: 'POST',
      body: JSON.stringify({ url: 'https://example.com/' }),
      headers: { 'Content-Type': 'application/json' },
    })
    assert.equal(noAuth.status, 401)

    const wrongAuth = await fetch(`http://127.0.0.1:${port}/v1/raw`, {
      method: 'POST',
      body: JSON.stringify({ url: 'https://example.com/' }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + 'b'.repeat(32),
      },
    })
    assert.equal(wrongAuth.status, 401)
  } finally {
    shut(app)
  }
})

test('POST /v1/raw executes raw fetch and returns response headers', async () => {
  const app = createApp({ token: TEST_TOKEN, engine: fakeEngine() })
  const port = await listen(app)
  try {
    const res = await post(port, '/v1/raw', 'https://example.com/source')
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.equal(res.headers.get('x-page-status'), '200')
    assert.equal(
      res.headers.get('x-page-url'),
      encodeURI('https://example.com/dest')
    )
    assert.equal(res.headers.get('x-page-truncated'), '0')
    assert.equal(await res.text(), '<html><body>Raw Page</body></html>')
  } finally {
    shut(app)
  }
})

test('POST /v1/render executes render and returns response headers', async () => {
  const app = createApp({ token: TEST_TOKEN, engine: fakeEngine() })
  const port = await listen(app)
  try {
    const res = await post(port, '/v1/render', 'https://example.com/source')
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.equal(res.headers.get('x-page-status'), '200')
    assert.equal(await res.text(), '<html><body>Rendered Page</body></html>')
  } finally {
    shut(app)
  }
})

test('validates request url and rejects invalid target or private IP with 400 or 403', async () => {
  const app = createApp({ token: TEST_TOKEN, engine: fakeEngine() })
  const port = await listen(app)
  try {
    const invalidUrl = await post(port, '/v1/raw', 'not-a-url')
    assert.equal(invalidUrl.status, 400)
    assert.equal((await invalidUrl.json()).kind, 'content')

    const privateUrl = await post(
      port,
      '/v1/raw',
      'http://127.0.0.1:8080/secret'
    )
    assert.equal(privateUrl.status, 403)
    assert.equal((await privateUrl.json()).kind, 'content')
  } finally {
    shut(app)
  }
})

test('a raw read that lands on a bot check cools the host down', async () => {
  const app = createApp({
    token: TEST_TOKEN,
    engine: fakeEngine({ rawChallenge: true }),
  })
  const port = await listen(app)
  try {
    const first = await post(port, '/v1/raw', 'https://guarded.example.com/a')
    assert.equal(first.status, 200)
    await first.text()
    const second = await post(port, '/v1/raw', 'https://guarded.example.com/b')
    assert.equal(second.status, 429)
    assert.equal(second.headers.get('retry-after'), '600')
    await second.text()
  } finally {
    shut(app)
  }
})

test('refuses with 429 when every browser page is busy', async () => {
  let open
  const gate = new Promise(resolve => {
    open = resolve
  })
  const engine = {
    ...fakeEngine(),
    raw: async () => {
      await gate
      return {
        status: 200,
        finalUrl: 'https://a.example.com/',
        contentType: 'text/html',
        body: Buffer.from('ok'),
        challenge: false,
      }
    },
  }
  const app = createApp({
    token: TEST_TOKEN,
    engine,
    capacity: 1,
    slotWaitMs: { raw: 50, render: 50 },
  })
  const port = await listen(app)
  try {
    const first = post(port, '/v1/raw', 'https://a.example.com/')
    await new Promise(resolve => setTimeout(resolve, 20))
    const second = await post(port, '/v1/raw', 'https://b.example.com/')
    assert.equal(second.status, 429)
    assert.equal(second.headers.get('retry-after'), '5')
    assert.deepEqual(await second.json(), {
      error: 'The browser is busy',
      kind: 'http',
    })
    open()
    const firstRes = await first
    assert.equal(firstRes.status, 200)
    assert.equal(await firstRes.text(), 'ok')
  } finally {
    shut(app)
  }
})

test('closes the browser read when the web side disconnects', async () => {
  let markStarted
  const started = new Promise(resolve => {
    markStarted = resolve
  })
  let markAborted
  const aborted = new Promise(resolve => {
    markAborted = resolve
  })
  const engine = {
    ...fakeEngine(),
    raw: (url, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            markAborted(true)
            const err = new Error('Request was cancelled')
            err.code = 'aborted'
            reject(err)
          },
          { once: true }
        )
        markStarted()
      }),
  }
  const app = createApp({ token: TEST_TOKEN, engine })
  const port = await listen(app)
  try {
    const controller = new AbortController()
    const request = post(port, '/v1/raw', 'https://slow.example.com/', {
      signal: controller.signal,
    }).catch(err => err)
    await started
    controller.abort()
    await request
    assert.equal(await aborted, true)
  } finally {
    shut(app)
  }
})

test('says when the engine cut the body', async () => {
  const engine = {
    ...fakeEngine(),
    raw: async () => ({
      status: 200,
      finalUrl: 'https://example.com/big.pdf',
      contentType: 'application/pdf',
      body: Buffer.from('%PDF-'),
      truncated: true,
      challenge: false,
    }),
  }
  const app = createApp({ token: TEST_TOKEN, engine })
  const port = await listen(app)
  try {
    const res = await post(port, '/v1/raw', 'https://example.com/big.pdf')
    assert.equal(res.headers.get('x-page-truncated'), '1')
    await res.text()
  } finally {
    shut(app)
  }
})


test('POST /v1/fetch reads a small file without a browser page or host pacing', async () => {
  const seen = []
  const engine = fakeEngine()
  engine.raw = async () => {
    throw new Error('no browser page for /v1/fetch')
  }
  const app = createApp({
    token: TEST_TOKEN,
    engine,
    capacity: 1,
    fetchFile: async url => {
      seen.push(url)
      return {
        status: 200,
        finalUrl: url,
        contentType: 'image/x-icon',
        body: Buffer.from([0, 0, 1, 0]),
        truncated: false,
      }
    },
  })
  const port = await listen(app)
  try {
    // Two at once to one host: neither waits for the other
    const started = Date.now()
    const answers = await Promise.all([
      post(port, '/v1/fetch', 'https://example.com/favicon.ico'),
      post(port, '/v1/fetch', 'https://example.com/'),
    ])
    assert.ok(Date.now() - started < 1000)
    for (const res of answers) {
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'image/x-icon')
      assert.equal(res.headers.get('x-page-status'), '200')
    }
    assert.equal(seen.length, 2)
    const refused = await post(port, '/v1/fetch', 'http://10.0.0.1/')
    assert.equal(refused.status, 403)
  } finally {
    shut(app)
  }
})

test('POST /v1/fetch refuses a host that is cooling down', async () => {
  const app = createApp({
    token: TEST_TOKEN,
    engine: fakeEngine({ rawChallenge: true }),
    fetchFile: async () => {
      throw new Error('not reached')
    },
  })
  const port = await listen(app)
  try {
    await post(port, '/v1/raw', 'https://example.com/')
    const res = await post(port, '/v1/fetch', 'https://example.com/favicon.ico')
    assert.equal(res.status, 429)
  } finally {
    shut(app)
  }
})

function botCheck() {
  return {
    status: 403,
    finalUrl: 'https://guarded.example/favicon.ico',
    contentType: 'text/html',
    body: Buffer.from('<title>Just a moment...</title>'),
    truncated: false,
  }
}

test('POST /v1/fetch asks Chrome for a file a bot check refuses, without waiting for page reads', async () => {
  let releaseRead
  const rawAsked = []
  const engine = {
    ...fakeEngine(),
    render: () =>
      new Promise(resolve => {
        releaseRead = () =>
          resolve({ status: 200, body: Buffer.from('page'), challenge: false })
      }),
    raw: async url => {
      rawAsked.push(url)
      return {
        status: 200,
        finalUrl: url,
        contentType: 'image/x-icon',
        body: Buffer.from([0, 0, 1, 0]),
        challenge: false,
      }
    },
  }
  const app = createApp({
    token: TEST_TOKEN,
    engine,
    capacity: 1,
    fetchFile: async () => botCheck(),
  })
  const port = await listen(app)
  try {
    // The only page place is held by a read
    const read = post(port, '/v1/render', 'https://other.example/')
    await new Promise(resolve => setTimeout(resolve, 20))
    const res = await post(port, '/v1/fetch', 'https://guarded.example/favicon.ico')
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'image/x-icon')
    assert.deepEqual(rawAsked, ['https://guarded.example/favicon.ico'])
    releaseRead()
    await read
    // An icon's bot check does not cool the host down for page reads
    const again = await post(port, '/v1/raw', 'https://guarded.example/')
    assert.equal(again.status, 200)
  } finally {
    shut(app)
  }
})

test('POST /v1/fetch passes head on, and asks Chrome for a page a bot check refuses', async () => {
  const asked = []
  const engine = fakeEngine({ rawContent: '<head><link rel="icon" href="/i.png"></head>' })
  const app = createApp({
    token: TEST_TOKEN,
    engine,
    fetchFile: async (url, options) => {
      asked.push(options.head)
      return botCheck()
    },
  })
  const port = await listen(app)
  try {
    const res = await post(port, '/v1/fetch', 'https://guarded.example/', {
      body: JSON.stringify({ url: 'https://guarded.example/', head: true }),
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('x-page-status'), '200')
    assert.match(await res.text(), /rel="icon"/)
    assert.deepEqual(asked, [true])
  } finally {
    shut(app)
  }
})
