import SearchService from '../services/SearchService.mjs'
import { logError, incMetric } from '../observability/Log.mjs'

const RATE_LIMIT_POINTS = 60
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX_KEYS = 10_000

/**
 * Fixed-window, per-key request counter kept in process memory. Search is a
 * public, read-only endpoint, so a per-process budget is enough to stop a
 * single client from hammering Mongo.
 */
export class InMemoryRateLimiter {
  constructor({ points, windowMs, maxKeys = RATE_LIMIT_MAX_KEYS }) {
    this.points = points
    this.windowMs = windowMs
    this.maxKeys = maxKeys
    this._windows = new Map()
  }

  /**
   * @returns {{ allowed: boolean, retryAfterMs: number }}
   */
  consume(key, now = Date.now()) {
    let entry = this._windows.get(key)
    if (!entry || entry.resetAt <= now) {
      if (!entry && this._windows.size >= this.maxKeys) this._prune(now)
      entry = { count: 0, resetAt: now + this.windowMs }
      this._windows.set(key, entry)
    }
    entry.count += 1
    if (entry.count > this.points) {
      return { allowed: false, retryAfterMs: entry.resetAt - now }
    }
    return { allowed: true, retryAfterMs: 0 }
  }

  _prune(now) {
    for (const [key, entry] of this._windows) {
      if (entry.resetAt <= now) this._windows.delete(key)
    }
    // Still full of live windows: drop the oldest ones (insertion order).
    for (const key of this._windows.keys()) {
      if (this._windows.size < this.maxKeys) break
      this._windows.delete(key)
    }
  }

  reset() {
    this._windows.clear()
  }
}

export const rateLimiter = new InMemoryRateLimiter({
  points: RATE_LIMIT_POINTS,
  windowMs: RATE_LIMIT_WINDOW_MS,
})

function firstString(value) {
  if (Array.isArray(value)) return firstString(value[0])
  return typeof value === 'string' ? value : ''
}

/**
 * GET /gallery/api/search?q=<text>&page=<0-based>&hitsPerPage=<n>
 * Public JSON endpoint used by the gallery search widget.
 */
export async function search(req, res) {
  const limit = rateLimiter.consume(req.ip || 'unknown')
  if (!limit.allowed) {
    incMetric('search_rate_limited')
    res.set('Retry-After', String(Math.ceil(limit.retryAfterMs / 1000)))
    return res.status(429).json({ error: 'rate_limited' })
  }

  try {
    const result = await SearchService.search({
      q: firstString(req.query?.q),
      page: firstString(req.query?.page),
      hitsPerPage: firstString(req.query?.hitsPerPage),
    })
    incMetric('search_requests')
    res.set('Cache-Control', 'no-store')
    return res.json(result)
  } catch (err) {
    logError('search failed', err)
    incMetric('search_errors')
    return res.status(500).json({ error: 'search_failed' })
  }
}

export default {
  search,
  rateLimiter,
}
