import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

const dnsLookup = vi.fn()
vi.mock('node:dns/promises', () => ({
  default: { lookup: dnsLookup },
  lookup: dnsLookup,
}))

const httpRequest = vi.fn()
const httpsRequest = vi.fn()
vi.mock('node:http', () => ({ default: { request: httpRequest } }))
vi.mock('node:https', () => ({ default: { request: httpsRequest } }))

const { default: McpUrlFetcher } = await import(
  '../../../../../app/src/Features/Mcp/McpUrlFetcher.mjs'
)

function fakeRes({ statusCode = 200, headers = {}, chunks = [] }) {
  const res = new EventEmitter()
  res.statusCode = statusCode
  res.headers = headers
  res.destroy = () => {}
  res._emit = () => {
    setImmediate(() => {
      for (const c of chunks) res.emit('data', Buffer.from(c))
      res.emit('end')
    })
  }
  return res
}

// http.request(url, options, cb) -> immediately deliver `res` (and stream it),
// or emit a transport error.
function stubRequest(target, res, { error, stream = true } = {}) {
  target.mockImplementation((url, options, cb) => {
    const req = new EventEmitter()
    req.destroy = () => {}
    req.end = () => {
      setImmediate(() => {
        if (error) {
          req.emit('error', error)
          return
        }
        cb(res)
        if (stream && res._emit) res._emit()
      })
    }
    return req
  })
}

async function expectRejectCode(promise, code) {
  let err
  try {
    await promise
  } catch (e) {
    err = e
  }
  expect(err, 'expected the call to reject').toBeDefined()
  expect(err.info?.code).toBe(code)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('McpUrlFetcher SSRF guard', () => {
  it('rejects localhost', async () => {
    await expectRejectCode(
      McpUrlFetcher.fetchToBuffer('http://127.0.0.1/x', { maxBytes: 100 }),
      'ssrf_blocked'
    )
    expect(dnsLookup).not.toHaveBeenCalled()
  })

  it('rejects private ranges', async () => {
    await expectRejectCode(
      McpUrlFetcher.fetchToBuffer('http://10.0.0.5/x', { maxBytes: 100 }),
      'ssrf_blocked'
    )
  })

  it('rejects link-local metadata address', async () => {
    await expectRejectCode(
      McpUrlFetcher.fetchToBuffer('http://169.254.169.254/latest/meta-data', {
        maxBytes: 100,
      }),
      'ssrf_blocked'
    )
  })

  it('rejects non-http(s) schemes', async () => {
    await expectRejectCode(
      McpUrlFetcher.fetchToBuffer('file:///etc/passwd', { maxBytes: 100 }),
      'ssrf_blocked'
    )
  })

  it('rejects bracketed IPv6 loopback http://[::1]/', async () => {
    await expectRejectCode(
      McpUrlFetcher.fetchToBuffer('http://[::1]/', { maxBytes: 100 }),
      'ssrf_blocked'
    )
  })

  it('rejects decimal-encoded 127.0.0.1 (http://2130706433/)', async () => {
    await expectRejectCode(
      McpUrlFetcher.fetchToBuffer('http://2130706433/', { maxBytes: 100 }),
      'ssrf_blocked'
    )
  })

  it('rejects http://0.0.0.0/', async () => {
    await expectRejectCode(
      McpUrlFetcher.fetchToBuffer('http://0.0.0.0/', { maxBytes: 100 }),
      'ssrf_blocked'
    )
  })

  it('rejects when DNS returns a mix of public and private addresses', async () => {
    dnsLookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.1.2.3', family: 4 },
    ])
    await expectRejectCode(
      McpUrlFetcher.fetchToBuffer('http://example.com/x', { maxBytes: 100 }),
      'ssrf_blocked'
    )
    expect(httpRequest).not.toHaveBeenCalled()
  })

  it('does not follow redirects - a 3xx surfaces as fetch_failed', async () => {
    dnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    const res = fakeRes({
      statusCode: 302,
      headers: { location: 'http://10.0.0.1/' },
    })
    stubRequest(httpRequest, res, { stream: false })
    await expectRejectCode(
      McpUrlFetcher.fetchToBuffer('http://example.com/x', { maxBytes: 100 }),
      'fetch_failed'
    )
  })

  it('surfaces a transport error as fetch_failed', async () => {
    dnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    stubRequest(httpRequest, null, { error: new Error('ECONNRESET') })
    await expectRejectCode(
      McpUrlFetcher.fetchToBuffer('http://example.com/x', { maxBytes: 100 }),
      'fetch_failed'
    )
  })

  it('preserves underlying cause when response stream emits error', async () => {
    dnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    const res = fakeRes({ statusCode: 200 })
    const underlying = new Error('Premature close')
    res._emit = () => {
      setImmediate(() => res.emit('error', underlying))
    }
    stubRequest(httpRequest, res)
    let thrown
    try {
      await McpUrlFetcher.fetchToBuffer('http://example.com/x', {
        maxBytes: 100,
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeDefined()
    expect(thrown.info?.code).toBe('fetch_failed')
    expect(thrown.info?.cause).toBe(underlying)
  })

  it('aborts and rejects too_large once the byte cap is exceeded', async () => {
    dnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    const res = fakeRes({
      statusCode: 200,
      headers: { 'content-type': 'image/png' },
      chunks: ['aaaaaaaaaa'],
    })
    stubRequest(httpRequest, res)
    await expectRejectCode(
      McpUrlFetcher.fetchToBuffer('http://example.com/x', { maxBytes: 3 }),
      'too_large'
    )
  })

  it('returns the buffer and content-type on success', async () => {
    dnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    const res = fakeRes({
      statusCode: 200,
      headers: { 'content-type': 'image/png' },
      chunks: ['hello ', 'world'],
    })
    stubRequest(httpRequest, res)
    const out = await McpUrlFetcher.fetchToBuffer('http://example.com/x', {
      maxBytes: 1000,
    })
    expect(out.buffer.toString()).toBe('hello world')
    expect(out.contentType).toBe('image/png')
  })
})

describe('McpUrlFetcher.parseIpLiteral and isBlockedIp', () => {
  it('correctly normalises octal and hex IP literals and blocks loopback', () => {
    const octalLoopback = McpUrlFetcher.parseIpLiteral('0177.0.0.1')
    expect(octalLoopback).toBe('127.0.0.1')
    expect(McpUrlFetcher.isBlockedIp(octalLoopback)).toBe(true)

    const hexLoopback = McpUrlFetcher.parseIpLiteral('0x7f.0.0.1')
    expect(hexLoopback).toBe('127.0.0.1')
    expect(McpUrlFetcher.isBlockedIp(hexLoopback)).toBe(true)

    const bareHex = McpUrlFetcher.parseIpLiteral('0x7f000001')
    expect(bareHex).toBe('127.0.0.1')
    expect(McpUrlFetcher.isBlockedIp(bareHex)).toBe(true)

    expect(McpUrlFetcher.parseIpLiteral('0178.0.0.1')).toBeNull()
  })

  it('blocks IPv4-mapped IPv6 private addresses and unspecified', () => {
    expect(McpUrlFetcher.isBlockedIp('::ffff:10.0.0.1')).toBe(true)
    expect(McpUrlFetcher.isBlockedIp('::')).toBe(true)
    expect(McpUrlFetcher.isBlockedIp('0.0.0.0')).toBe(true)
  })
  it('allows a public address', () => {
    expect(McpUrlFetcher.isBlockedIp('93.184.216.34')).toBe(false)
  })
})
