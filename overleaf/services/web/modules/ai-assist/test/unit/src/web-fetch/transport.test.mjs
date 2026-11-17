import { describe, it } from 'vitest'
import { expect } from 'chai'
import sinon from 'sinon'
import http from 'node:http'
import zlib from 'node:zlib'
import {
  BROWSER_HEADERS,
  fetchPublicUrl,
  isPublicAddress,
  parseFetchUrl,
} from '../../../../app/src/web-fetch/transport.mjs'

describe('transport', function () {
  it('refuses IPv6 forms that embed an IPv4 address, and reserved IPv6 ranges', function () {
    for (const address of [
      '::',
      '::1',
      '::7f00:1', // ::127.0.0.1, IPv4-compatible
      '::a00:1', // ::10.0.0.1
      '::ffff:0:7f00:1', // ::ffff:0:127.0.0.1, IPv4-translated
      '3fff::1',
      '5f00::1',
    ]) {
      expect(isPublicAddress(address), address).to.equal(false)
    }
    expect(isPublicAddress('8.8.8.8')).to.equal(true)
    expect(isPublicAddress('2606:4700:4700::1111')).to.equal(true)
  })

  it('parseFetchUrl refuses those addresses written into a URL', function () {
    for (const url of [
      'http://[::127.0.0.1]/',
      'http://[::ffff:0:127.0.0.1]/',
      'http://[3fff::1]/',
    ]) {
      expect(() => parseFetchUrl(url), url).to.throw(/not a public address/)
    }
  })

  it('parseFetchUrl refuses a URL that carries a username or password', function () {
    for (const url of [
      'https://user:secret@example.com/',
      'https://user@example.com/',
      'https://example.com@127.0.0.1/',
    ]) {
      expect(() => parseFetchUrl(url), url).to.throw(
        /username or password/
      )
    }
    expect(parseFetchUrl('https://example.com/a').toString()).to.equal(
      'https://example.com/a'
    )
  })

  it('parseFetchUrl refuses the ports browsers refuse, and keeps web ports', function () {
    for (const url of [
      'http://example.com:25/',
      'https://example.com:22/',
      'http://example.com:6667/',
      'http://example.com:0/',
    ]) {
      expect(() => parseFetchUrl(url), url).to.throw(/is not a web port/)
    }
    for (const url of [
      'http://example.com/',
      'https://example.com/',
      'https://example.com:8443/',
      'http://example.com:8080/',
    ]) {
      expect(parseFetchUrl(url).hostname).to.equal('example.com')
    }
  })

  it('BROWSER_HEADERS claims Chrome 150 with complete sec-ch-ua headers', function () {
    expect(BROWSER_HEADERS['User-Agent']).to.include('Chrome/150.0.0.0')
    expect(BROWSER_HEADERS['sec-ch-ua']).to.include('"Chromium";v="150"')
    expect(BROWSER_HEADERS['sec-ch-ua-mobile']).to.equal('?0')
    expect(BROWSER_HEADERS['sec-ch-ua-platform']).to.equal('"Linux"')
  })

  it('fetchPublicUrl routes to curlFetch when impersonate is true and binary is available', async function () {
    const fakeCurl = sinon.stub().resolves({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: Buffer.from('curl content'),
      truncated: false,
    })

    const res = await fetchPublicUrl('https://example.com/impersonated', {
      impersonate: true,
      curlFn: fakeCurl,
      isCurlAvailable: () => true,
    })

    expect(fakeCurl.calledOnce).to.be.true
    expect(res.body.toString('utf8')).to.equal('curl content')
  })

  it('fetchPublicUrl falls back to Node transport when impersonate is true but binary is missing', async function () {
    const fakeLookup = sinon
      .stub()
      .yields(null, [{ address: '93.184.216.34', family: 4 }])
    const fakeRequestOnce = sinon.stub().resolves({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: Buffer.from('node fallback content'),
      truncated: false,
    })

    const res = await fetchPublicUrl('https://example.com/fallback', {
      impersonate: true,
      lookup: fakeLookup,
      isCurlAvailable: () => false,
      requestOnceFn: fakeRequestOnce,
    })

    expect(fakeRequestOnce.calledOnce).to.be.true
    expect(res.body.toString('utf8')).to.equal('node fallback content')
  })

  it('truncates oversized gzipped responses and cleans up the decompression stream', async function () {
    const compressed = zlib.gzipSync(Buffer.alloc(256 * 1024, 'A'))
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Encoding': 'gzip',
      })
      res.end(compressed)
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    const localLookup = (_host, opts, cb) => {
      const callback = typeof opts === 'function' ? opts : cb
      if (typeof opts === 'object' && opts?.all) {
        return callback(null, [{ address: '127.0.0.1', family: 4 }])
      }
      return callback(null, '127.0.0.1', 4)
    }

    try {
      const res = await fetchPublicUrl(`http://example.com:${port}/bomb`, {
        maxBytes: 1024,
        lookup: localLookup,
      })
      expect(res.truncated).to.be.true
      expect(res.body.length).to.equal(1024)
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('propagates compressed response errors to the caller instead of leaving an unhandled stream error', async function () {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Encoding': 'gzip',
      })
      res.write(Buffer.from('not-valid-gzip-data'))
      res.end()
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    const localLookup = (_host, opts, cb) => {
      const callback = typeof opts === 'function' ? opts : cb
      if (typeof opts === 'object' && opts?.all) {
        return callback(null, [{ address: '127.0.0.1', family: 4 }])
      }
      return callback(null, '127.0.0.1', 4)
    }

    try {
      let caught = null
      try {
        await fetchPublicUrl(`http://example.com:${port}/bad-gzip`, {
          lookup: localLookup,
        })
      } catch (err) {
        caught = err
      }
      expect(caught).to.exist
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })
})
