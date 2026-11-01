import http from 'node:http'
import zlib from 'node:zlib'
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest'
import {
  requestRaw,
  fetchStream,
} from '../../../app/src/transport/GuardedHttps.mjs'
import { rejectionOf } from './S-P4-support.mjs'

// URLs still pass the production port/host checks. Only the final HTTP dial
// is redirected to an ephemeral fixture port, so this suite never competes
// with the dev server on port 80 or requires a privileged listener.

const HOST = 'gallery.test.example'
const URL_BASE = `http://${HOST}/template.zip`

function loopbackLookup(hostname, options, callback) {
  if (options?.all) return callback(null, [{ address: '127.0.0.1', family: 4 }])
  callback(null, '127.0.0.1', 4)
}

const baseOpts = {
  allowedHosts: [HOST],
  lookupFn: loopbackLookup,
  timeoutMs: 5_000,
}

let handler = null
const sockets = new Set()
const server = http.createServer((req, res) => handler(req, res))
server.on('connection', (socket) => {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
})

beforeAll(async () => {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
})

const actualRequest = http.request
let requestSpy
beforeEach(() => {
  requestSpy = vi
    .spyOn(http, 'request')
    .mockImplementation((url, options, callback) => {
      const original = new URL(url)
      const dial = new URL(original)
      dial.port = String(server.address().port)
      return actualRequest(
        dial,
        {
          ...options,
          headers: { ...options.headers, host: original.host },
        },
        callback
      )
    })
})

afterEach(() => {
  requestSpy?.mockRestore()
  handler = null
  for (const socket of sockets) socket.destroy()
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('S-P4 GuardedHttps: response and decompressor failures never hang a caller', () => {
  it('decodes a gzip body', async () => {
    handler = (req, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip' })
      res.end(zlib.gzipSync('template body'))
    }
    const out = await requestRaw(URL_BASE, baseOpts)
    expect(out.status).toBe(200)
    expect(out.body.toString('utf8')).toBe('template body')
  })

  it('rejects when the connection drops in the middle of a gzip body', async () => {
    handler = (req, res) => {
      const gz = zlib.gzipSync('x'.repeat(50_000))
      res.writeHead(200, {
        'content-encoding': 'gzip',
        'content-length': String(gz.length),
      })
      res.write(gz.subarray(0, 40))
      setTimeout(() => req.socket.destroy(), 30)
    }
    expect(await rejectionOf(requestRaw(URL_BASE, baseOpts))).toBeInstanceOf(
      Error
    )
  })

  it('rejects a corrupt gzip body with the decompressor error', async () => {
    handler = (req, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip' })
      res.end('this is not gzip data at all')
    }
    expect(await rejectionOf(requestRaw(URL_BASE, baseOpts))).toMatchObject({
      code: 'Z_DATA_ERROR',
    })
  })

  it('rejects a plain body that stalls past the idle timeout', async () => {
    handler = (req, res) => {
      res.writeHead(200, { 'content-length': '100' })
      res.write('partial')
    }
    const started = Date.now()
    const err = await rejectionOf(
      requestRaw(URL_BASE, { ...baseOpts, idleTimeoutMs: 150 })
    )
    expect(err).toMatchObject({ code: 'ETIMEDOUT' })
    expect(Date.now() - started).toBeLessThan(4_000)
  })

  it('keeps a slow but steady body alive: the idle timer re-arms on every chunk', async () => {
    handler = (req, res) => {
      res.writeHead(200)
      let i = 0
      const timer = setInterval(() => {
        res.write(`c${i}`)
        i++
        if (i === 5) {
          clearInterval(timer)
          res.end()
        }
      }, 40)
      res.on('close', () => clearInterval(timer))
    }
    const out = await requestRaw(URL_BASE, { ...baseOpts, idleTimeoutMs: 200 })
    expect(out.body.toString('utf8')).toBe('c0c1c2c3c4')
  })

  it('rejects when a plain body is cut before it completes', async () => {
    handler = (req, res) => {
      res.writeHead(200)
      res.write('abc')
      setTimeout(() => req.socket.destroy(), 30)
    }
    expect(await rejectionOf(requestRaw(URL_BASE, baseOpts))).toBeInstanceOf(
      Error
    )
  })

  it('rejects when an error body is cut short instead of waiting forever', async () => {
    handler = (req, res) => {
      res.writeHead(500)
      res.write('boom')
      setTimeout(() => req.socket.destroy(), 30)
    }
    expect(await rejectionOf(requestRaw(URL_BASE, baseOpts))).toBeInstanceOf(
      Error
    )
  })

  it('still caps the body at maxBytes and reports truncation', async () => {
    handler = (req, res) => {
      res.writeHead(200)
      res.end('0123456789'.repeat(10))
    }
    const out = await requestRaw(URL_BASE, { ...baseOpts, maxBytes: 25 })
    expect(out.truncated).toBe(true)
    expect(out.body.toString('utf8')).toBe('0123456789012345678901234')
  })
})

describe('S-P4 GuardedHttps fetchStream: a broken body errors the stream', () => {
  it('streams a complete plain body', async () => {
    handler = (req, res) => {
      res.writeHead(200)
      res.end('hello stream')
    }
    const { stream } = await fetchStream(URL_BASE, baseOpts)
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    expect(Buffer.concat(chunks).toString('utf8')).toBe('hello stream')
  })

  it('errors the stream with ETIMEDOUT when the body stalls', async () => {
    handler = (req, res) => {
      res.writeHead(200)
      res.write('abc')
    }
    const { stream } = await fetchStream(URL_BASE, {
      ...baseOpts,
      idleTimeoutMs: 150,
    })
    const err = await rejectionOf(
      (async () => {
        for await (const chunk of stream) void chunk
      })()
    )
    expect(err).toMatchObject({ code: 'ETIMEDOUT' })
  })

  it('errors the stream when a gzip body is cut by the peer', async () => {
    handler = (req, res) => {
      const gz = zlib.gzipSync('y'.repeat(50_000))
      res.writeHead(200, {
        'content-encoding': 'gzip',
        'content-length': String(gz.length),
      })
      res.write(gz.subarray(0, 40))
      setTimeout(() => req.socket.destroy(), 30)
    }
    const { stream } = await fetchStream(URL_BASE, baseOpts)
    const err = await rejectionOf(
      (async () => {
        for await (const chunk of stream) void chunk
      })()
    )
    expect(err).toBeInstanceOf(Error)
  })

  it('releases the upstream connection when the consumer gives up on the stream', async () => {
    let serverSideClosed = false
    handler = (req, res) => {
      res.writeHead(200)
      res.write('first chunk')
      res.on('close', () => {
        serverSideClosed = true
      })
    }
    const { stream } = await fetchStream(URL_BASE, baseOpts)
    await new Promise((resolve) => stream.once('readable', resolve))
    stream.destroy()
    for (let i = 0; i < 50 && !serverSideClosed; i++) await sleep(20)
    expect(serverSideClosed).toBe(true)
  })
})

describe('S-P4 GuardedHttps redirects: every hop is checked, credentials stay on their origin', () => {
  // The official PDF URL redirects to a signed object on a second host.
  const SIGNED_HOST = 'signed.test.example'
  const SIGNED_URL = `http://${SIGNED_HOST}/signed.pdf`

  it('follows a redirect to a host on the allow-list', async () => {
    handler = (req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: SIGNED_URL })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/pdf' })
      res.end('%PDF-1.4 signed')
    }
    const { stream } = await fetchStream(
      URL_BASE.replace('/template.zip', '/start'),
      {
        ...baseOpts,
        allowedHosts: [HOST, SIGNED_HOST],
      }
    )
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    expect(Buffer.concat(chunks).toString('utf8')).toBe('%PDF-1.4 signed')
  })

  it('refuses a redirect to a host outside the allow-list before connecting to it', async () => {
    handler = (req, res) => {
      res.writeHead(302, { location: SIGNED_URL })
      res.end()
    }
    const err = await rejectionOf(
      fetchStream(URL_BASE, { ...baseOpts, allowedHosts: [HOST] })
    )
    expect(err.code).toBe('EOUTBOUND_BLOCKED')
    expect(err.message).toContain(
      'Outbound target blocked: signed.test.example'
    )
  })

  it('does not forward credentials to the redirected host', async () => {
    let cookieOnSignedHop = 'not-requested'
    handler = (req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: SIGNED_URL })
        res.end()
        return
      }
      cookieOnSignedHop = req.headers.cookie
      res.writeHead(200)
      res.end('ok')
    }
    const { stream } = await fetchStream(
      URL_BASE.replace('/template.zip', '/start'),
      {
        ...baseOpts,
        allowedHosts: [HOST, SIGNED_HOST],
        headers: {
          Cookie: 'session=secret',
          Authorization: 'Bearer x',
          Accept: 'application/pdf',
        },
      }
    )
    for await (const chunk of stream) void chunk
    expect(cookieOnSignedHop).toBeUndefined()
  })
})
