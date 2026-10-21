import { RateLimiter } from '../../../../app/src/infrastructure/RateLimiter.mjs'
import RateLimiterMiddleware from '../../../../app/src/Features/Security/RateLimiterMiddleware.mjs'
import McpErrors from './McpErrors.mjs'

// Created on first use, so a deployment without MCP never constructs them.
// The names are unchanged so existing Redis counters carry over.
let limiters
export function getMcpRateLimiters() {
  limiters ??= {
    ip: new RateLimiter('mcp-ip', { points: 600, duration: 60 }),
    token: new RateLimiter('mcp-token', { points: 120, duration: 60 }),
  }
  return limiters
}

/** Whole seconds until the limiter lets the next request through. */
function retryAfterSeconds(rateLimiterRes) {
  const ms = rateLimiterRes?.msBeforeNext ?? 60 * 1000
  return Math.max(1, Math.ceil(ms / 1000))
}

/**
 * Express middleware that consumes one point from a limiter, using the upstream
 * RateLimiterMiddleware.rateLimit (key choice, smoke-test bypass, metrics label).
 * An exceeded limit is answered by `respond(res, retryAfterSeconds)` instead of
 * the plain-text 429, so each API can send its own error shape.
 */
export function rateLimitGate(rateLimiter, { ipOnly = false, getUserId, respond }) {
  return RateLimiterMiddleware.rateLimit(rateLimiter, {
    ipOnly,
    getUserId,
    onLimited: (res, rateLimiterRes) =>
      respond(res, retryAfterSeconds(rateLimiterRes)),
  })
}

/** The MCP 429: the McpError envelope with code rate_limited and Retry-After. */
export function mcpRateLimited(res, seconds) {
  res.setHeader?.('Retry-After', String(seconds))
  return McpErrors.send(
    res,
    McpErrors.CODES.RATE_LIMITED,
    undefined,
    { hint: `Wait ${seconds} seconds before retrying.` }
  )
}

/**
 * The OAuth2 429: RFC 6749 style `{error, error_description}` with Retry-After.
 * `temporarily_unavailable` is the closest registered code; the endpoints have
 * no rate-limit code of their own.
 */
export function oauthRateLimited(res, seconds) {
  res.setHeader?.('Retry-After', String(seconds))
  return res.status(429).json({
    error: 'temporarily_unavailable',
    error_description: `Too many requests; retry after ${seconds} seconds`,
  })
}
