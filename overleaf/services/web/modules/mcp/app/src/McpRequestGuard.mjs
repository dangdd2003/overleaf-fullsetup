import express from 'express'
import Settings from '@overleaf/settings'
import McpErrors from './McpErrors.mjs'
import { requireMcpAuth } from './McpAuthMiddleware.mjs'
import { getMcpRateLimiters, mcpRateLimited, rateLimitGate } from './McpRateLimit.mjs'

const MCP_PATH = '/api/v0/mcp'
/** Base64 file uploads (up to 50 MB) travel as JSON, so they need more room. */
export const MCP_MAX_UPLOAD_BODY_BYTES = 70 * 1024 * 1024
const UPLOAD_ROUTE = /^\/projects\/[^/]+\/file\/?$/

let parsers
function jsonParsers() {
  parsers ??= {
    small: express.json({ limit: Settings.max_json_request_size }),
    upload: express.json({ limit: MCP_MAX_UPLOAD_BODY_BYTES }),
  }
  return parsers
}

/** The route below /api/v0/mcp, with any query string removed. */
function routeOf(req) {
  const full = (req.originalUrl || req.url || '').split('?')[0]
  return full.startsWith(MCP_PATH) ? full.slice(MCP_PATH.length) : full
}

function hasBody(req) {
  const length = req.headers['content-length']
  return (
    req.headers['transfer-encoding'] !== undefined ||
    (length !== undefined && length !== '0')
  )
}

function readBody(req, res, next, route) {
  if (!hasBody(req)) return next()
  if (!req.is('application/json')) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'request body must be JSON (Content-Type: application/json)'
    )
  }
  const isUpload = req.method === 'POST' && UPLOAD_ROUTE.test(route)
  const parser = isUpload ? jsonParsers().upload : jsonParsers().small
  return parser(req, res, err => {
    if (!err) return next()
    if (err.type === 'entity.too.large') {
      return McpErrors.send(
        res,
        McpErrors.CODES.PAYLOAD_TOO_LARGE,
        `request body is over the ${isUpload ? MCP_MAX_UPLOAD_BODY_BYTES : Settings.max_json_request_size}-byte limit for this route`
      )
    }
    if (err.type === 'entity.parse.failed') {
      return McpErrors.send(
        res,
        McpErrors.CODES.VALIDATION,
        'request body is not valid JSON'
      )
    }
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, 'invalid request body')
  })
}

/**
 * Runs before the app's body parsers for every /api/v0/mcp request, so a
 * request is rate-limited and authenticated before its body is read. The
 * upload route gets the large limit; every other route gets the default one.
 * Form and other non-JSON bodies are refused here, so the app-wide urlencoded
 * parser never sees them.
 */
export function mcpRequestGuard(req, res, next) {
  const limiters = getMcpRateLimiters()
  rateLimitGate(limiters.ip, {
    ipOnly: true,
    respond: mcpRateLimited,
  })(req, res, err => {
    if (err) return next(err)
    const route = routeOf(req)
    const publicRoute =
      req.method === 'GET' && /^\/openapi\.json\/?$/.test(route)
    const afterAuth = () => readBody(req, res, next, route)
    if (publicRoute) return afterAuth()
    return requireMcpAuth(req, res, afterAuth)
  })
}

/** Mount the guard on the MCP path, ahead of the app's body parsers. */
export function applyMcpRequestGuard(app) {
  app.use(MCP_PATH, mcpRequestGuard)
}

export default { mcpRequestGuard, applyMcpRequestGuard, MCP_MAX_UPLOAD_BODY_BYTES }
