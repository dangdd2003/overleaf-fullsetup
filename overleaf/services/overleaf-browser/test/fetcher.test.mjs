import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import zlib from 'node:zlib'
import { createEgressProxy } from '../proxy.mjs'
import { fetchSmall } from '../fetcher.mjs'

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}

/** A site behind the real egress proxy, which allows only its port. */
async function siteBehindProxy(handler) {
  const site = http.createServer(handler)
  const sitePort = await listen(site)
  const lines = []
  const proxy = createEgressProxy({
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    isPublic: () => true,
    ports: new Set([sitePort]),
    log: line => lines.push(line),
  })
  const proxyPort = await listen(proxy)
  return {
    base: `http://site.example:${sitePort}`,
    proxyUrl: `http://127.0.0.1:${proxyPort}`,
    lines,
    close() {
      site.closeAllConnections()
      site.close()
      proxy.closeAllConnections()
      proxy.close()
    },
  }
}

test('fetchSmall reads a file through the egress proxy and follows redirects', async () => {
  const icon = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16])
  const env = await siteBehindProxy((req, res) => {
    if (req.url === '/old.ico') {
      res.writeHead(301, { Location: '/favicon.ico' }).end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'image/x-icon' }).end(icon)
  })
  try {
    const read = await fetchSmall(`${env.base}/old.ico`, {
      proxyUrl: env.proxyUrl,
    })
    assert.equal(read.status, 200)
    assert.equal(read.finalUrl, `${env.base}/favicon.ico`)
    assert.equal(read.contentType, 'image/x-icon')
    assert.deepEqual(read.body, icon)
    assert.equal(read.truncated, false)
    // Both hops went out through the proxy
    assert.equal(env.lines.filter(l => l.startsWith('egress http')).length, 2)
  } finally {
    env.close()
  }
})

test('fetchSmall decompresses and cuts the body at maxBytes', async () => {
  const page = Buffer.from('<head>' + 'x'.repeat(5000) + '</head>')
  const env = await siteBehindProxy((req, res) => {
    res
      .writeHead(200, {
        'Content-Type': 'text/html',
        'Content-Encoding': 'gzip',
      })
      .end(zlib.gzipSync(page))
  })
  try {
    const whole = await fetchSmall(`${env.base}/`, { proxyUrl: env.proxyUrl })
    assert.deepEqual(whole.body, page)
    const cut = await fetchSmall(`${env.base}/`, {
      proxyUrl: env.proxyUrl,
      maxBytes: 100,
    })
    assert.equal(cut.body.length, 100)
    assert.equal(cut.truncated, true)
  } finally {
    env.close()
  }
})

test('fetchSmall hands back a page error as its status and times out as 504', async () => {
  const env = await siteBehindProxy((req, res) => {
    if (req.url === '/slow') return
    res.writeHead(404, { 'Content-Type': 'text/html' }).end('nope')
  })
  try {
    const missing = await fetchSmall(`${env.base}/missing`, {
      proxyUrl: env.proxyUrl,
    })
    assert.equal(missing.status, 404)
    await assert.rejects(
      fetchSmall(`${env.base}/slow`, { proxyUrl: env.proxyUrl, timeoutMs: 100 }),
      err => err.status === 504 && err.kind === 'network'
    )
  } finally {
    env.close()
  }
})

test('fetchSmall with head stops reading a page at </head>', async () => {
  const head = '<html><head><link rel="icon" href="/i.png"></HEAD>'
  const env = await siteBehindProxy((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.write(head)
    // The rest of a heavy page, which never needs to arrive
    const timer = setInterval(() => res.write('x'.repeat(1000)), 10)
    res.on('close', () => clearInterval(timer))
  })
  try {
    const read = await fetchSmall(`${env.base}/`, {
      proxyUrl: env.proxyUrl,
      head: true,
      timeoutMs: 2000,
    })
    assert.equal(read.status, 200)
    assert.ok(read.body.toString().startsWith(head))
    assert.ok(read.body.length < 5000)
  } finally {
    env.close()
  }
})
