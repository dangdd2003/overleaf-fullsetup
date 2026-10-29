import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import SearchService from '../../../app/src/services/SearchService.mjs'
import SearchController, {
  InMemoryRateLimiter,
} from '../../../app/src/controllers/SearchController.mjs'

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) {
      res.statusCode = code
      return res
    },
    set(name, value) {
      res.headers[name] = value
      return res
    },
    json(body) {
      res.body = body
      return res
    },
  }
  return res
}

describe('A2 SearchController', function () {
  beforeEach(function () {
    SearchController.rateLimiter.reset()
  })

  afterEach(function () {
    vi.restoreAllMocks()
  })

  it('passes the query string through to the search service', async function () {
    const result = { hits: [], nbHits: 0, page: 1, nbPages: 0 }
    const spy = vi.spyOn(SearchService, 'search').mockResolvedValue(result)
    const res = makeRes()
    await SearchController.search(
      { ip: '10.0.0.1', query: { q: 'cv', page: '1', hitsPerPage: '10' } },
      res
    )
    expect(spy).toHaveBeenCalledWith({ q: 'cv', page: '1', hitsPerPage: '10' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe(result)
  })

  it('ignores non-string query values', async function () {
    const spy = vi.spyOn(SearchService, 'search').mockResolvedValue({})
    await SearchController.search(
      { ip: '10.0.0.1', query: { q: ['cv', 'thesis'], page: { $gt: 1 } } },
      makeRes()
    )
    expect(spy).toHaveBeenCalledWith({ q: 'cv', page: '', hitsPerPage: '' })
  })

  it('answers 500 JSON when the search fails', async function () {
    vi.spyOn(SearchService, 'search').mockRejectedValue(new Error('boom'))
    const res = makeRes()
    await SearchController.search({ ip: '10.0.0.1', query: { q: 'cv' } }, res)
    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ error: 'search_failed' })
  })

  it('rate limits each client IP separately', async function () {
    vi.spyOn(SearchService, 'search').mockResolvedValue({})
    for (let i = 0; i < 60; i++) {
      await SearchController.search({ ip: '10.0.0.1', query: {} }, makeRes())
    }
    const limited = makeRes()
    await SearchController.search({ ip: '10.0.0.1', query: {} }, limited)
    expect(limited.statusCode).toBe(429)
    expect(limited.body).toEqual({ error: 'rate_limited' })
    expect(Number(limited.headers['Retry-After'])).toBeGreaterThan(0)

    const other = makeRes()
    await SearchController.search({ ip: '10.0.0.2', query: {} }, other)
    expect(other.statusCode).toBe(200)
  })

  describe('InMemoryRateLimiter', function () {
    it('opens a new window once the previous one expires', function () {
      const limiter = new InMemoryRateLimiter({ points: 2, windowMs: 1000 })
      expect(limiter.consume('a', 0).allowed).toBe(true)
      expect(limiter.consume('a', 10).allowed).toBe(true)
      expect(limiter.consume('a', 20)).toEqual({
        allowed: false,
        retryAfterMs: 980,
      })
      expect(limiter.consume('a', 1000).allowed).toBe(true)
    })

    it('bounds the number of tracked keys', function () {
      const limiter = new InMemoryRateLimiter({
        points: 1,
        windowMs: 1000,
        maxKeys: 3,
      })
      for (const key of ['a', 'b', 'c', 'd', 'e']) limiter.consume(key, 0)
      expect(limiter._windows.size).toBeLessThanOrEqual(3)
      expect(limiter._windows.has('e')).toBe(true)
    })
  })
})
