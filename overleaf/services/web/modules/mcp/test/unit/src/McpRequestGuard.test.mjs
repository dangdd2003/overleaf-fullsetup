import { describe, it, expect, vi, beforeEach } from 'vitest'
import Settings from '@overleaf/settings'

const ip = { consume: vi.fn() }
const token = { consume: vi.fn() }
vi.mock('../../../app/src/McpRateLimit.mjs', async importOriginal => {
  const actual = await importOriginal()
  return {
    ...actual,
    getMcpRateLimiters: () => ({ ip, token }),
  }
})

const requireMcpAuth = vi.fn()
vi.mock('../../../app/src/McpAuthMiddleware.mjs', () => ({
  requireMcpAuth: (...args) => requireMcpAuth(...args),
}))

const { mcpRequestGuard, MCP_MAX_UPLOAD_BODY_BYTES } = await import(
  '../../../app/src/McpRequestGuard.mjs'
)

/** A minimal request that express.json can read, driven by a stream. */
async function run({ method = 'POST', url, headers = {}, body, auth }) {
  const { Readable } = await import('node:stream')
  const req = Readable.from(body == null ? [] : [Buffer.from(body)])
  Object.assign(req, {
    method,
    originalUrl: url,
    url,
    ip: '1.2.3.4',
    headers: {
      ...(body != null ? { 'content-length': String(Buffer.byteLength(body)) } : {}),
      ...headers,
    },
    is: type => {
      const ct = headers['content-type'] || ''
      return ct.split(';')[0].trim() === type ? type : false
    },
    mcpUserId: undefined,
  })
  const r = {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v
    },
    status(s) {
      this.statusCode = s
      return this
    },
    json(b) {
      this.body = b
      this.ended = true
      return this
    },
  }
  const outcome = await new Promise(resolve => {
    const next = err => resolve({ next: true, err })
    ip.consume.mockResolvedValue({})
    requireMcpAuth.mockImplementation(
      auth || ((_req, _res, cb) => cb())
    )
    mcpRequestGuard(req, r, next)
    // Give the body parser a moment to finish reading the stream.
    setTimeout(() => resolve({ next: false }), 50)
  })
  return { req, res: r, ...outcome }
}

beforeEach(() => {
  vi.clearAllMocks()
  Settings.max_json_request_size = 1024
})

describe('mcpRequestGuard', () => {
  it('answers a rate-limited IP with the McpError envelope before authenticating', async () => {
    ip.consume.mockRejectedValue({ msBeforeNext: 2000 })
    const r = { headers: {}, setHeader(k, v) { this.headers[k] = v }, status(s) { this.statusCode = s; return this }, json(b) { this.body = b } }
    mcpRequestGuard({ ip: '1.2.3.4', originalUrl: '/api/v0/mcp/tags', headers: {} }, r, vi.fn())
    await vi.waitFor(() => expect(r.statusCode).toBe(429))
    expect(r.body.code).toBe('rate_limited')
    expect(r.headers['Retry-After']).toBe('2')
    expect(requireMcpAuth).not.toHaveBeenCalled()
  })

  it('does not read the body of an unauthenticated request', async () => {
    const { res, next } = await run({
      url: '/api/v0/mcp/projects',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"x"}',
      auth: (_req, res) => res.status(401).json({ code: 'unauthorized' }),
    })
    expect(res.statusCode).toBe(401)
    expect(next).toBe(false)
  })

  it('rejects a form-urlencoded body with a validation error', async () => {
    const { res } = await run({
      url: '/api/v0/mcp/tags',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'name=x',
    })
    expect(res.statusCode).toBe(400)
    expect(res.body.code).toBe('validation_error')
  })

  it('answers an over-limit JSON body with payload_too_large in the McpError shape', async () => {
    const { res } = await run({
      url: '/api/v0/mcp/tags',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x'.repeat(2000) }),
    })
    expect(res.statusCode).toBe(413)
    expect(res.body.code).toBe('payload_too_large')
  })

  it('allows the large limit only on the file upload route', async () => {
    const big = JSON.stringify({ contentBase64: 'x'.repeat(2000) })
    const upload = await run({
      method: 'POST',
      url: '/api/v0/mcp/projects/p1/file',
      headers: { 'content-type': 'application/json' },
      body: big,
    })
    expect(upload.next).toBe(true)
    expect(upload.req.body).toEqual({ contentBase64: 'x'.repeat(2000) })
    expect(MCP_MAX_UPLOAD_BODY_BYTES).toBe(70 * 1024 * 1024)

    const other = await run({
      method: 'POST',
      url: '/api/v0/mcp/projects/p1/doc',
      headers: { 'content-type': 'application/json' },
      body: big,
    })
    expect(other.res.statusCode).toBe(413)
  })

  it('reports malformed JSON as a validation error', async () => {
    const { res } = await run({
      url: '/api/v0/mcp/tags',
      headers: { 'content-type': 'application/json' },
      body: '{"name":',
    })
    expect(res.statusCode).toBe(400)
    expect(res.body.code).toBe('validation_error')
  })

  it('parses a valid JSON body and continues', async () => {
    const { req, next } = await run({
      url: '/api/v0/mcp/tags',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"thesis"}',
    })
    expect(next).toBe(true)
    expect(req.body).toEqual({ name: 'thesis' })
    expect(req._body).toBe(true)
  })

  it('serves the public OpenAPI document without authenticating', async () => {
    const { next } = await run({ method: 'GET', url: '/api/v0/mcp/openapi.json' })
    expect(next).toBe(true)
    expect(requireMcpAuth).not.toHaveBeenCalled()
  })

  it('serves the public OpenAPI document with trailing slash without authenticating', async () => {
    const { next } = await run({
      method: 'GET',
      url: '/api/v0/mcp/openapi.json/',
    })
    expect(next).toBe(true)
    expect(requireMcpAuth).not.toHaveBeenCalled()
  })

  it('allows the large limit on the file upload route with trailing slash', async () => {
    const big = JSON.stringify({ contentBase64: 'x'.repeat(2000) })
    const upload = await run({
      method: 'POST',
      url: '/api/v0/mcp/projects/p1/file/',
      headers: { 'content-type': 'application/json' },
      body: big,
    })
    expect(upload.next).toBe(true)
    expect(upload.req.body).toEqual({ contentBase64: 'x'.repeat(2000) })
  })

  it('propagates errors from rate limit checking to next', async () => {
    const error = new Error('rate limiter broken')
    ip.consume.mockRejectedValue(error)
    const next = vi.fn()
    mcpRequestGuard(
      { ip: '1.2.3.4', originalUrl: '/api/v0/mcp/tags', headers: {} },
      {},
      next
    )
    await vi.waitFor(() => expect(next).toHaveBeenCalledWith(error))
  })

  it('handles routeOf correctly when URL does not start with MCP_PATH', async () => {
    const { next } = await run({
      method: 'GET',
      url: '/openapi.json',
    })
    expect(next).toBe(true)
    expect(requireMcpAuth).not.toHaveBeenCalled()
  })
})
