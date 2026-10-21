import { describe, it, expect, vi } from 'vitest'
import settings from '@overleaf/settings'
import {
  rateLimitGate,
  mcpRateLimited,
  oauthRateLimited,
} from '../../../app/src/McpRateLimit.mjs'

function res() {
  const headers = {}
  return {
    headers,
    statusCode: 200,
    body: null,
    setHeader(k, v) {
      headers[k] = v
    },
    status(s) {
      this.statusCode = s
      return this
    },
    json(b) {
      this.body = b
      return this
    },
  }
}

describe('rateLimitGate', () => {
  it('calls next when the limiter allows the request', async () => {
    const limiter = { consume: vi.fn().mockResolvedValue({}) }
    const next = vi.fn()
    const gate = rateLimitGate(limiter, {
      getUserId: req => req.mcpTokenId,
      respond: vi.fn(),
    })
    gate({ ip: '1.2.3.4', mcpTokenId: 'tok' }, res(), next)
    await vi.waitFor(() => expect(next).toHaveBeenCalledWith())
    expect(limiter.consume).toHaveBeenCalledWith('tok', 1, { method: 'userId' })
  })

  it('keys on the IP when ipOnly is set, and when no user id is known', async () => {
    const limiter = { consume: vi.fn().mockResolvedValue({}) }
    const gate = rateLimitGate(limiter, {
      ipOnly: true,
      getUserId: () => 'ignored',
      respond: vi.fn(),
    })
    gate({ ip: '1.2.3.4' }, res(), vi.fn())
    await vi.waitFor(() =>
      expect(limiter.consume).toHaveBeenCalledWith('1.2.3.4', 1, { method: 'ip' })
    )
  })

  it('answers an exceeded limit through respond with the retry time in seconds', async () => {
    const limiter = {
      consume: vi.fn().mockRejectedValue({ msBeforeNext: 12_345 }),
    }
    const respond = vi.fn(oauthRateLimited)
    const next = vi.fn()
    const r = res()
    rateLimitGate(limiter, { ipOnly: true, respond })({ ip: '1.2.3.4' }, r, next)
    await vi.waitFor(() => expect(respond).toHaveBeenCalled())
    expect(respond).toHaveBeenCalledWith(r, 13)
    expect(r.headers['Retry-After']).toBe('13')
    expect(next).not.toHaveBeenCalled()
  })

  it('passes a real error to next rather than treating it as a limit', async () => {
    const boom = new Error('redis down')
    const limiter = { consume: vi.fn().mockRejectedValue(boom) }
    const respond = vi.fn()
    const next = vi.fn()
    rateLimitGate(limiter, { ipOnly: true, respond })({ ip: '1.2.3.4' }, res(), next)
    await vi.waitFor(() => expect(next).toHaveBeenCalledWith(boom))
    expect(respond).not.toHaveBeenCalled()
  })

  it('lets the smoke test user through without consuming a point', async () => {
    const limiter = { consume: vi.fn().mockResolvedValue({}) }
    const next = vi.fn()
    const savedSmokeTest = settings.smokeTest
    settings.smokeTest = { userId: 'smoke-user' }
    try {
      rateLimitGate(limiter, {
        getUserId: req => req.mcpTokenId,
        respond: vi.fn(),
      })({ ip: '1.2.3.4', mcpTokenId: 'smoke-user' }, res(), next)
      await vi.waitFor(() => expect(next).toHaveBeenCalledWith())
      expect(limiter.consume).not.toHaveBeenCalled()
    } finally {
      settings.smokeTest = savedSmokeTest
    }
  })
})

describe('MCP and OAuth 429 responses', () => {
  it('mcpRateLimited sends the McpError envelope with Retry-After', () => {
    const r = res()
    mcpRateLimited(r, 7)
    expect(r.statusCode).toBe(429)
    expect(r.body.code).toBe('rate_limited')
    expect(r.headers['Retry-After']).toBe('7')
  })

  it('oauthRateLimited sends an RFC 6749 style error with Retry-After', () => {
    const r = res()
    oauthRateLimited(r, 7)
    expect(r.statusCode).toBe(429)
    expect(r.body.error).toBe('temporarily_unavailable')
    expect(r.body.error_description).toMatch(/7 seconds/)
    expect(r.headers['Retry-After']).toBe('7')
  })
})
