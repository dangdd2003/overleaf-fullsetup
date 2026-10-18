import { describe, it, afterEach, beforeEach, vi } from 'vitest'
import { expect } from 'chai'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import http from 'node:http'
import https from 'node:https'
import dns from 'node:dns'
import os from 'node:os'
import zlib from 'node:zlib'
import {
  connectorFetch,
  connectorLookup,
  isSelfAddress,
  isPrivateAddress,
  providerFetch,
  validateConnectorUrl,
  ConnectorHeaders,
} from '../../../../app/src/connectors/ConnectorFetch.mjs'

// Requests never leave the test process: http(s).request is replaced with a
// fake that answers from `respond`. Every outgoing call is recorded.
function fakeNetwork(respond) {
  const sent = []
  for (const transport of [http, https]) {
    vi.spyOn(transport, 'request').mockImplementation((url, options, callback) => {
      const req = new EventEmitter()
      const written = []
      req.write = chunk => {
        written.push(Buffer.from(chunk))
        return true
      }
      req.end = () => {}
      req.setTimeout = () => {}
      req.destroy = () => {}
      const call = {
        url: url.href,
        method: options.method,
        headers: options.headers,
        body: () => Buffer.concat(written).toString('utf8'),
      }
      sent.push(call)
      const reply = respond(call)
      process.nextTick(() => {
        const res = Readable.from(
          reply.body === undefined ? [] : [Buffer.from(reply.body)]
        )
        res.statusCode = reply.status ?? 200
        res.statusMessage = ''
        res.headers = reply.headers ?? {}
        callback(res)
      })
      return req
    })
  }
  return sent
}

function answerWith(addresses) {
  return vi.spyOn(dns, 'lookup').mockImplementation((host, options, callback) => {
    callback(null, addresses)
  })
}

describe('ConnectorFetch', function () {
  afterEach(function () {
    vi.restoreAllMocks()
  })

  describe('validateConnectorUrl', function () {
    it('accepts public https and plain http addresses, returning the parsed URL', function () {
      const { parsed } = validateConnectorUrl('https://mcp.example.com/api')
      expect(parsed.href).to.equal('https://mcp.example.com/api')
      expect(() => validateConnectorUrl('http://mcp.corp.example:3000/sse')).to.not.throw()
    })

    it('refuses a private or LAN address a user typed in', function () {
      for (const url of [
        'http://192.168.77.20:8080/mcp',
        'https://10.20.30.40/mcp',
        'http://172.20.0.1:11434',
        'http://100.64.1.1/mcp',
        'http://[fd12:3456::1]/mcp',
      ]) {
        expect(() => validateConnectorUrl(url), url).to.throw(/private network address/)
      }
    })

    it('accepts a private address the admin configured in an existing server URL env var', function () {
      const saved = process.env.AI_ASSIST_MCP_URLS
      process.env.AI_ASSIST_MCP_URLS = 'http://192.168.77.20:8080/mcp'
      try {
        expect(() => validateConnectorUrl('http://192.168.77.20:8080/mcp')).to.not.throw()
        expect(() => validateConnectorUrl('http://192.168.77.21:8080/mcp')).to.throw()
      } finally {
        if (saved === undefined) delete process.env.AI_ASSIST_MCP_URLS
        else process.env.AI_ASSIST_MCP_URLS = saved
      }
    })

    it('rejects protocols other than http and https', function () {
      for (const url of ['ftp://example.com/x', 'file:///etc/passwd', 'ws://example.com']) {
        expect(() => validateConnectorUrl(url)).to.throw(/Invalid protocol/)
      }
    })

    it('rejects a string that is not a URL', function () {
      expect(() => validateConnectorUrl('not a url')).to.throw(/Invalid URL/)
    })

    it('refuses loopback in every spelling the URL parser normalises', function () {
      for (const url of [
        'http://127.0.0.1:8080/mcp',
        'http://127.1/mcp',
        'http://2130706433/mcp',
        'http://[::1]/mcp',
        'http://[::ffff:127.0.0.1]/mcp',
        'http://0.0.0.0/mcp',
      ]) {
        expect(() => validateConnectorUrl(url)).to.throw(
          /points at this Overleaf server/
        )
      }
    })

    it('refuses link-local, metadata, multicast, localhost and *.localhost targets', function () {
      for (const url of [
        'http://169.254.169.254/latest/meta-data/',
        'https://169.254.169.254/computeMetadata/v1/',
        'http://metadata.google.internal/computeMetadata/v1/',
        'http://metadata/computeMetadata/v1/',
        'http://224.0.0.251/mcp',
        'http://localhost:3000/mcp',
        'https://app.localhost/mcp',
      ]) {
        expect(() => validateConnectorUrl(url), url).to.throw(
          /points at this Overleaf server/
        )
      }
    })
  })

  describe('isSelfAddress', function () {
    it('is true for loopback, unspecified, link-local, metadata and multicast', function () {
      for (const address of [
        '127.0.0.1',
        '127.9.9.9',
        '0.0.0.0',
        '169.254.169.254',
        '224.0.0.1',
        '::1',
        '::',
        'fe80::1',
        '::ffff:127.0.0.1',
      ]) {
        expect(isSelfAddress(address), address).to.be.true
      }
    })

    it('is false for public and LAN addresses', function () {
      for (const address of [
        '93.184.216.34',
        '2606:4700:4700::1111',
        '10.20.30.40',
        '192.168.77.20',
      ]) {
        expect(isSelfAddress(address), address).to.be.false
      }
    })

    it('is true for IPv4 addresses written in IPv6 form, as a URL normalizes them', function () {
      // new URL('http://[::ffff:127.0.0.1]/').hostname is '[::ffff:7f00:1]'
      for (const address of [
        '::ffff:7f00:1',
        '::ffff:a9fe:a9fe', // ::ffff:169.254.169.254
        '::ffff:6464:64c8', // ::ffff:100.100.100.200
        '::ffff:0:7f00:1', // IPv4-translated
      ]) {
        expect(isSelfAddress(address), address).to.be.true
      }
      expect(isSelfAddress('::ffff:808:808')).to.be.false // ::ffff:8.8.8.8
    })

    it('is true for the AWS IPv6 and Alibaba metadata addresses', function () {
      expect(isSelfAddress('fd00:ec2::254')).to.be.true
      expect(isSelfAddress('100.100.100.200')).to.be.true
      expect(isSelfAddress('fd00:ec2::25')).to.be.false
    })

    it('treats anything that is not an IP as self, to be safe', function () {
      expect(isSelfAddress('example.com')).to.be.true
    })

    it('is true for every address this machine owns', function () {
      // Covers the case where the server is dialled by its own LAN address
      const owned = Object.values(os.networkInterfaces())
        .flat()
        .filter(entry => entry && !entry.internal)
        .map(entry => entry.address)
      for (const address of owned) {
        expect(isSelfAddress(address), address).to.be.true
      }
    })
  })

  describe('connectorLookup', function () {
    // Resolves with the callback's values, or rejects with its error
    function lookup(...args) {
      return new Promise((resolve, reject) => {
        connectorLookup(...args, (err, ...values) =>
          err ? reject(err) : resolve(values)
        )
      })
    }

    async function errorFrom(promise) {
      try {
        await promise
      } catch (err) {
        return err
      }
      return null
    }

    it('returns the address and family of a public answer', async function () {
      answerWith([{ address: '93.184.216.34', family: 4 }])
      const [address, family] = await lookup('mcp.example.com', {})
      expect(address).to.equal('93.184.216.34')
      expect(family).to.equal(4)
    })

    it('refuses an answer that points back at this server, or no answer at all', async function () {
      answerWith([{ address: '127.0.0.1', family: 4 }])
      const err = await errorFrom(lookup('rebind.example.com', {}))
      expect(err.code).to.equal('EADDRBLOCKED')
      expect(err.message).to.match(/resolves to this Overleaf server/)

      answerWith([])
      const empty = await errorFrom(lookup('nothing.example.com', {}))
      expect(empty.code).to.equal('EADDRBLOCKED')
    })

    it('refuses when any one of several answers is this server', async function () {
      answerWith([
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ])
      const err = await errorFrom(lookup('mixed.example.com', { all: true }))
      expect(err.code).to.equal('EADDRBLOCKED')
    })

    it('returns the whole list when asked for all answers', async function () {
      const list = [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:4700:4700::1111', family: 6 },
      ]
      answerWith(list)
      const [answers] = await lookup('dual.example.com', { all: true })
      expect(answers).to.deep.equal(list)
    })

    it('passes a lookup error straight through', async function () {
      vi.spyOn(dns, 'lookup').mockImplementation((host, options, callback) => {
        callback(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }))
      })
      const err = await errorFrom(lookup('missing.example.com', {}))
      expect(err.code).to.equal('ENOTFOUND')
    })

  })

  describe('ConnectorHeaders', function () {
    it('looks headers up case-insensitively', function () {
      const headers = new ConnectorHeaders({
        'Content-Type': 'application/json',
        Authorization: 'Bearer test',
      })
      expect(headers.get('content-type')).to.equal('application/json')
      expect(headers.get('CONTENT-TYPE')).to.equal('application/json')
      expect(headers.has('authorization')).to.be.true
      expect(headers.get('nonexistent')).to.be.null
    })

    it('joins array values and skips null and undefined ones', function () {
      const headers = new ConnectorHeaders({
        Accept: ['application/json', 'text/event-stream'],
        'X-Empty': null,
        'X-Missing': undefined,
      })
      expect(headers.get('accept')).to.equal('application/json, text/event-stream')
      expect(headers.has('x-empty')).to.be.false
      expect(headers.has('x-missing')).to.be.false
    })

  })

  describe('connectorFetch', function () {
    it('refuses to dial a loopback address without making a request', async function () {
      const sent = fakeNetwork(() => ({ body: 'should not be reached' }))

      let error = null
      try {
        await connectorFetch('http://127.0.0.1:3000/mcp')
      } catch (err) {
        error = err
      }
      expect(error.message).to.match(/points at this Overleaf server/)
      expect(sent).to.have.lengthOf(0)
    })

    it('parses a JSON response and sends the given headers and body on POST', async function () {
      const sent = fakeNetwork(() => ({
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ greeting: 'hello' }),
      }))

      const res = await connectorFetch('https://mcp.example.com/hello', {
        method: 'post',
        headers: { 'Content-Type': 'application/json', 'X-Trace': 'abc' },
        body: JSON.stringify({ ping: 'pong' }),
      })

      expect(res.ok).to.be.true
      expect(res.headers.get('content-type')).to.equal('application/json')
      expect(await res.json()).to.deep.equal({ greeting: 'hello' })
      expect(sent[0].method).to.equal('POST')
      expect(sent[0].headers['x-trace']).to.equal('abc')
      expect(sent[0].body()).to.equal(JSON.stringify({ ping: 'pong' }))
    })

    it('asks for compressed responses and decompresses gzip', async function () {
      const sent = fakeNetwork(() => ({
        headers: { 'content-encoding': 'gzip' },
        body: zlib.gzipSync('plain text response'),
      }))

      const res = await connectorFetch('https://mcp.example.com/text')

      expect(sent[0].headers['accept-encoding']).to.equal('gzip, deflate, br')
      expect(await res.text()).to.equal('plain text response')
    })

    it('follows a redirect and reports the final URL', async function () {
      fakeNetwork(({ url }) =>
        url.endsWith('/start')
          ? { status: 302, headers: { location: 'https://mcp.example.com/hello' } }
          : { body: JSON.stringify({ greeting: 'hello' }) }
      )

      const res = await connectorFetch('https://mcp.example.com/start')

      expect(res.url).to.equal('https://mcp.example.com/hello')
      expect(await res.json()).to.deep.equal({ greeting: 'hello' })
    })

    it('turns a POST into a GET on 303 and drops its body', async function () {
      const sent = fakeNetwork(({ url }) =>
        url.endsWith('/submit')
          ? { status: 303, headers: { location: 'https://mcp.example.com/result' } }
          : { body: 'done' }
      )

      await connectorFetch('https://mcp.example.com/submit', {
        method: 'POST',
        body: 'payload',
      })

      expect(sent[1].method).to.equal('GET')
      expect(sent[1].body()).to.equal('')
    })

    it('keeps Authorization on a same-origin redirect but strips it across origins', async function () {
      const sameOrigin = fakeNetwork(({ url }) =>
        url.endsWith('/a')
          ? { status: 302, headers: { location: 'https://mcp.example.com/b' } }
          : { body: 'ok' }
      )
      await connectorFetch('https://mcp.example.com/a', {
        headers: { Authorization: 'Bearer kept' },
      })
      expect(sameOrigin[1].headers.authorization).to.equal('Bearer kept')

      vi.restoreAllMocks()
      const crossOrigin = fakeNetwork(({ url }) =>
        url.endsWith('/a')
          ? { status: 302, headers: { location: 'https://other.example.net/b' } }
          : { body: 'ok' }
      )
      await connectorFetch('https://mcp.example.com/a', {
        headers: { Authorization: 'Bearer super-secret' },
      })
      expect(crossOrigin[1].headers.authorization).to.be.undefined
    })

    it('validates every redirect target, refusing one that points at this server', async function () {
      const sent = fakeNetwork(() => ({
        status: 302,
        headers: { location: 'http://127.0.0.1:8080/admin' },
      }))

      let error = null
      try {
        await connectorFetch('https://mcp.example.com/start')
      } catch (err) {
        error = err
      }
      expect(error.message).to.match(/points at this Overleaf server/)
      expect(sent).to.have.lengthOf(1)
    })

    it('detects a redirect loop', async function () {
      fakeNetwork(({ url }) => ({
        status: 302,
        headers: {
          location: url.endsWith('/loop-1')
            ? 'https://mcp.example.com/loop-2'
            : 'https://mcp.example.com/loop-1',
        },
      }))

      let error = null
      try {
        await connectorFetch('https://mcp.example.com/loop-1')
      } catch (err) {
        error = err
      }
      expect(error.message).to.match(/Redirect loop detected/)
    })

    it('returns a redirect unfollowed when redirect is manual', async function () {
      const sent = fakeNetwork(() => ({
        status: 302,
        headers: { location: 'https://mcp.example.com/elsewhere' },
      }))

      const res = await connectorFetch('https://mcp.example.com/start', {
        redirect: 'manual',
      })

      expect(res.status).to.equal(302)
      expect(res.headers.get('location')).to.equal('https://mcp.example.com/elsewhere')
      expect(sent).to.have.lengthOf(1)
    })
  })
})

describe('private addresses', function () {
  afterEach(function () {
    vi.restoreAllMocks()
  })

  it('classifies RFC 1918, CGNAT and ULA addresses as private, public ones not', function () {
    for (const address of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.9', '100.64.0.1', 'fd12::1']) {
      expect(isPrivateAddress(address), address).to.be.true
    }
    for (const address of ['93.184.216.34', '172.32.0.1', '8.8.8.8', '2606:4700::1111']) {
      expect(isPrivateAddress(address), address).to.be.false
    }
  })

  it('refuses a public-looking name that resolves to a private address', async function () {
    vi.spyOn(dns, 'lookup').mockImplementation((host, options, callback) => {
      callback(null, [{ address: '192.168.1.5', family: 4 }])
    })
    const err = await new Promise(resolve =>
      connectorLookup('ollama.example.com', { all: true }, e => resolve(e))
    )
    expect(err?.code).to.equal('EADDRBLOCKED')
    expect(err.message).to.match(/private network address/)
  })

  it('allows the private address of a host the admin named in an existing server URL variable', async function () {
    const saved = process.env.AI_ASSIST_SEARXNG_URLS
    process.env.AI_ASSIST_SEARXNG_URLS = 'http://searx.corp:8080'
    try {
      vi.spyOn(dns, 'lookup').mockImplementation((host, options, callback) => {
        callback(null, [{ address: '192.168.1.5', family: 4 }])
      })
      const [address] = await new Promise((resolve, reject) =>
        connectorLookup('searx.corp', {}, (e, a, f) => (e ? reject(e) : resolve([a, f])))
      )
      expect(address).to.equal('192.168.1.5')
    } finally {
      if (saved === undefined) delete process.env.AI_ASSIST_SEARXNG_URLS
      else process.env.AI_ASSIST_SEARXNG_URLS = saved
    }
  })
})

describe('connectorFetch against a local server', function () {
  let server
  let base
  let hits

  // Requests reach a real server on loopback; the lookup is injected, so the
  // loopback answer does not trip the guard, which is tested above
  const lookupToLoopback = (_host, options, callback) =>
    options?.all
      ? callback(null, [{ address: '127.0.0.1', family: 4 }])
      : callback(null, '127.0.0.1', 4)

  beforeEach(async function () {
    hits = []
    server = http.createServer((req, res) => {
      hits.push(req.url)
      if (req.url === '/sse') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('data: one\n\n')
        setTimeout(() => res.end('data: two\n\n'), 60)
        return
      }
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: `${base}/elsewhere` })
        res.end()
        return
      }
      if (req.url === '/drip') {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        const timer = setInterval(() => res.write('.'), 25)
        res.on('close', () => clearInterval(timer))
        return
      }
      res.writeHead(200)
      res.end('ok')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://example.test:${server.address().port}`
  })

  afterEach(async function () {
    await new Promise(resolve => server.close(resolve))
  })

  it('streams a provider reply as it arrives, through the pinned lookup', async function () {
    const res = await providerFetch(`${base}/sse`, { lookup: lookupToLoopback })
    const chunks = []
    for await (const chunk of res.body) chunks.push(Buffer.from(chunk).toString())
    expect(chunks.join('')).to.equal('data: one\n\ndata: two\n\n')
    expect(chunks.length).to.be.greaterThan(1)
  })

  it('refuses a provider redirect rather than following it', async function () {
    let err
    try {
      await providerFetch(`${base}/redirect`, { lookup: lookupToLoopback })
    } catch (e) {
      err = e
    }
    expect(err?.code).to.equal('EREDIRECTREFUSED')
    expect(hits).to.deep.equal(['/redirect'])
  })

  it('ends the body read when the caller aborts mid-stream', async function () {
    const controller = new AbortController()
    const res = await providerFetch(`${base}/drip`, {
      lookup: lookupToLoopback,
      signal: controller.signal,
    })
    const reading = (async () => {
      for await (const _chunk of res.body) {
        controller.abort()
      }
    })()
    let err
    try {
      await reading
    } catch (e) {
      err = e
    }
    expect(err).to.exist
  })

  it('cuts off a slow drip at the wall-clock deadline, though bytes keep arriving', async function () {
    const res = await connectorFetch(`${base}/drip`, {
      lookup: lookupToLoopback,
      deadlineMs: 300,
    })
    const started = Date.now()
    let err
    try {
      for await (const _chunk of res.body) {
        // each byte resets an idle timer; only the deadline ends this
      }
    } catch (e) {
      err = e
    }
    expect(err?.code).to.equal('ETIMEDOUT')
    expect(Date.now() - started).to.be.lessThan(2000)
  })
})

