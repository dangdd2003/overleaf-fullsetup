import { describe, it } from 'vitest'
import { expect } from 'chai'
import sinon from 'sinon'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import {
  curlChildEnv,
  curlFetch,
  DEFAULT_CURL_PATH,
  isCurlImpersonateAvailable,
  parseDumpedHeaders,
} from '../../../../app/src/web-fetch/curl.mjs'

describe('curl child environment', function () {
  it('passes only the allowlisted names, never the server secrets', function () {
    const env = curlChildEnv({
      PATH: '/usr/bin',
      HOME: '/home/app',
      TMPDIR: '/tmp/x',
      LANG: 'C.UTF-8',
      LC_ALL: 'C',
      SSL_CERT_FILE: '/etc/ca.pem',
      LD_PRELOAD: '/evil.so',
      OVERLEAF_SESSION_SECRET: 'session-secret',
      AI_ASSIST_BROWSER_TOKEN: 'browser-token',
      OPENAI_API_KEY: 'sk-test',
    })
    expect(env).to.deep.equal({
      PATH: '/usr/bin',
      HOME: '/home/app',
      TMPDIR: '/tmp/x',
      LANG: 'C.UTF-8',
      LC_ALL: 'C',
      SSL_CERT_FILE: '/etc/ca.pem',
    })
  })

  it('is what the spawned child receives', async function () {
    process.env['OVERLEAF_TEST_SECRET'] = 'do-not-pass'
    let spawnOptions = null
    const fakeSpawn = (bin, args, options) => {
      spawnOptions = options
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = sinon.stub()
      process.nextTick(() => {
        child.stdout.end('x')
        child.stderr.end(
          JSON.stringify({ http_code: 200, content_type: 'text/plain' }) + '\n'
        )
        child.emit('close', 0)
      })
      return child
    }
    try {
      await curlFetch('https://example.com/env', {
        lookup: sinon.stub().yields(null, [{ address: '93.184.216.34', family: 4 }]),
        spawnFn: fakeSpawn,
        curlBinary: '/usr/bin/curl-fake',
      })
    } finally {
      delete process.env['OVERLEAF_TEST_SECRET']
    }
    expect(spawnOptions.env).to.not.have.property('OVERLEAF_TEST_SECRET')
    expect(spawnOptions.env).to.not.have.property('LD_PRELOAD')
  })
})

describe('curlFetch', function () {
  it('pins guarded IP addresses via --resolve and disables proxy', async function () {
    const fakeLookup = sinon.stub().yields(null, [
      { address: '93.184.216.34', family: 4 },
      { address: '93.184.216.35', family: 4 },
    ])

    let spawnedArgs = null
    const fakeSpawn = (bin, args) => {
      spawnedArgs = args
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = sinon.stub()

      process.nextTick(() => {
        child.stdout.end('Hello world')
        child.stderr.end(
          JSON.stringify({
            http_code: 200,
            content_type: 'text/html; charset=utf-8',
            exitcode: 0,
            errormsg: '',
          }) + '\n'
        )
        child.emit('close', 0)
      })
      return child
    }

    const res = await curlFetch('https://example.com/test', {
      lookup: fakeLookup,
      spawnFn: fakeSpawn,
      curlBinary: '/usr/bin/curl-fake',
    })

    expect(spawnedArgs[0]).to.equal('-q')
    expect(spawnedArgs).to.include('--noproxy')
    expect(spawnedArgs).to.include('*')
    expect(spawnedArgs).to.include('--impersonate')
    expect(spawnedArgs).to.include('chrome150')
    expect(spawnedArgs).to.include('--resolve')
    expect(spawnedArgs).to.include(
      'example.com:443:93.184.216.34,93.184.216.35'
    )
    expect(res.status).to.equal(200)
    expect(res.body.toString('utf8')).to.equal('Hello world')
    expect(res.truncated).to.be.false
  })

  it('truncates stdout exceeding size cap and kills process', async function () {
    const fakeLookup = sinon
      .stub()
      .yields(null, [{ address: '93.184.216.34', family: 4 }])
    let killCalled = false

    const fakeSpawn = () => {
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = () => {
        killCalled = true
        child.emit('close', 0)
      }

      process.nextTick(() => {
        child.stdout.write('1234567890')
        child.stdout.write('extra bytes beyond cap')
        child.stderr.end(
          JSON.stringify({
            http_code: 200,
            content_type: 'text/plain',
            exitcode: 0,
            errormsg: '',
          }) + '\n'
        )
      })
      return child
    }

    const res = await curlFetch('https://example.com/test', {
      maxBytes: 10,
      lookup: fakeLookup,
      spawnFn: fakeSpawn,
      curlBinary: '/usr/bin/curl-fake',
    })

    expect(killCalled).to.be.true
    expect(res.truncated).to.be.true
    expect(res.body.length).to.equal(10)
    expect(res.body.toString('utf8')).to.equal('1234567890')
  })

  it('maps redirects to redirect url without reading body', async function () {
    const fakeLookup = sinon
      .stub()
      .yields(null, [{ address: '93.184.216.34', family: 4 }])

    const fakeSpawn = () => {
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = sinon.stub()

      process.nextTick(() => {
        child.stdout.end()
        child.stderr.end(
          JSON.stringify({
            http_code: 302,
            content_type: '',
            redirect_url: 'https://example.com/redirected',
            exitcode: 0,
            errormsg: '',
          }) + '\n'
        )
        child.emit('close', 0)
      })
      return child
    }

    const res = await curlFetch('https://example.com/old', {
      lookup: fakeLookup,
      spawnFn: fakeSpawn,
      curlBinary: '/usr/bin/curl-fake',
    })

    expect(res.redirect).to.equal('https://example.com/redirected')
  })

  it('rejects with webError on HTTP error status', async function () {
    const fakeLookup = sinon
      .stub()
      .yields(null, [{ address: '93.184.216.34', family: 4 }])

    const fakeSpawn = () => {
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = sinon.stub()

      process.nextTick(() => {
        child.stdout.end()
        child.stderr.end(
          JSON.stringify({
            http_code: 403,
            content_type: 'text/html',
            exitcode: 0,
            errormsg: '',
          }) + '\n'
        )
        child.emit('close', 0)
      })
      return child
    }

    let error = null
    try {
      await curlFetch('https://example.com/denied', {
        lookup: fakeLookup,
        spawnFn: fakeSpawn,
        curlBinary: '/usr/bin/curl-fake',
      })
    } catch (err) {
      error = err
    }

    expect(error).to.exist
    expect(error.status).to.equal(403)
    expect(error.kind).to.equal('http')
    expect(error.message).to.include('returned HTTP 403')
  })

  it('rejects with network webError on connection failure', async function () {
    const fakeLookup = sinon
      .stub()
      .yields(null, [{ address: '93.184.216.34', family: 4 }])

    const fakeSpawn = () => {
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = sinon.stub()

      process.nextTick(() => {
        child.stdout.end()
        child.stderr.end(
          JSON.stringify({
            http_code: 0,
            content_type: '',
            exitcode: 7,
            errormsg:
              'Failed to connect to example.com port 443: Connection refused',
          }) + '\n'
        )
        child.emit('close', 7)
      })
      return child
    }

    let error = null
    try {
      await curlFetch('https://example.com/refused', {
        lookup: fakeLookup,
        spawnFn: fakeSpawn,
        curlBinary: '/usr/bin/curl-fake',
      })
    } catch (err) {
      error = err
    }

    expect(error).to.exist
    expect(error.kind).to.equal('network')
    expect(error.message).to.include('Connection refused')
  })
})

describe('curl size cap without a timing line', function () {
  it('keeps the partial page, marked truncated, when the cap kills curl first', async function () {
    const fakeLookup = sinon
      .stub()
      .yields(null, [{ address: '93.184.216.34', family: 4 }])
    const fakeSpawn = () => {
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = () => {
        // Killed before -w could write the timing line: only the dumped headers
        process.nextTick(() => child.emit('close', null))
      }
      process.nextTick(() => {
        child.stderr.write('HTTP/2 200 \r\ncontent-type: text/html; charset=utf-8\r\n\r\n')
        child.stdout.write('0123456789')
        child.stdout.write('more than the cap')
      })
      return child
    }
    const res = await curlFetch('https://example.com/big', {
      maxBytes: 10,
      lookup: fakeLookup,
      spawnFn: fakeSpawn,
      curlBinary: '/usr/bin/curl-fake',
    })
    expect(res.truncated).to.be.true
    expect(res.status).to.equal(200)
    expect(res.contentType).to.equal('text/html; charset=utf-8')
    expect(res.body.toString('utf8')).to.equal('0123456789')
  })

  it('still reports a network error when curl dies before the cap and before any timing line', async function () {
    const fakeLookup = sinon
      .stub()
      .yields(null, [{ address: '93.184.216.34', family: 4 }])
    const fakeSpawn = () => {
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = () => {}
      process.nextTick(() => {
        child.stderr.end('curl: (28) Operation timed out\n')
        child.stdout.end()
        child.emit('close', 28)
      })
      return child
    }
    let err
    try {
      await curlFetch('https://example.com/slow', {
        maxBytes: 10,
        lookup: fakeLookup,
        spawnFn: fakeSpawn,
        curlBinary: '/usr/bin/curl-fake',
      })
    } catch (e) {
      err = e
    }
    expect(err?.kind).to.equal('network')
  })
})

describe('parseDumpedHeaders', function () {
  it('reads the status and content type of the last response', function () {
    const text =
      'HTTP/1.1 100 Continue\r\n\r\n' +
      'HTTP/2 301 \r\nlocation: /x\r\n\r\n' +
      'HTTP/2 404 \r\nContent-Type: application/pdf\r\n\r\n'
    expect(parseDumpedHeaders(text)).to.deep.equal({
      status: 404,
      contentType: 'application/pdf',
    })
  })

  it('answers zero and no type for text with no headers', function () {
    expect(parseDumpedHeaders('')).to.deep.equal({ status: 0, contentType: '' })
  })
})

