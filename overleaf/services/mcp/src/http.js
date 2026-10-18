import { Readable } from 'node:stream'
import express from 'express'
import logger from '@overleaf/logger'
import { createMcpExpressApp } from '@modelcontextprotocol/express'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { createMcpServerFactory, listToolMetadata } from './server.js'
import { OverleafApiError } from './errors.js'
import {
  PROTECTED_RESOURCE_WELL_KNOWN_PATH,
  getProtectedResourceMetadata,
  buildWwwAuthenticateHeader,
  createJwtVerifier,
  parseScopes,
} from './oauth.js'

const BEARER_PATTERN = /^Bearer\s+(\S+)$/i
/** Upper bound on distinct cached tokens, so the cache cannot grow without limit. */
const MAX_CACHED_TOKENS = 10000
/** Longest a proxied request to web may take, body included. */
const PROXY_TIMEOUT_MS = 30000
/** RFC 9110 §7.6.1 headers that apply to one connection and are never forwarded. */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
])

/**
 * Requests per client IP per window on the MCP endpoint, counted before the
 * body is parsed. Bounds how fast an unauthenticated client can make the
 * service read request bodies.
 */
const PRE_BODY_RATE_LIMIT = 600
const PRE_BODY_RATE_WINDOW_MS = 60 * 1000
/** Bounds the per-IP table so spoofed addresses cannot grow it without limit. */
const PRE_BODY_RATE_MAX_IPS = 10000
/** Longest bearer token accepted before any other check. Real tokens are far shorter. */
const MAX_BEARER_TOKEN_LENGTH = 8192

/**
 * Build the gate that runs on the MCP endpoint before the body is parsed.
 *
 * It rejects a request with no bearer token, or a token of an impossible shape,
 * and it counts requests per client IP. Only then is the (up to 70 MB) JSON
 * body read. Token validity is still checked later by the auth middleware.
 *
 * @param {object} config
 * @returns {import('express').RequestHandler}
 */
export function createPreBodyGate(config) {
  const windows = new Map()

  function countRequest(ip, now) {
    const current = windows.get(ip)
    if (!current || now - current.start >= PRE_BODY_RATE_WINDOW_MS) {
      if (!current && windows.size >= PRE_BODY_RATE_MAX_IPS) {
        // Drop the oldest window to make room; the table never grows past its bound.
        windows.delete(windows.keys().next().value)
      }
      windows.set(ip, { start: now, count: 1 })
      return 1
    }
    current.count += 1
    return current.count
  }

  return function preBodyGate(req, res, next) {
    const now = Date.now()
    if (countRequest(req.ip, now) > PRE_BODY_RATE_LIMIT) {
      res.setHeader('Retry-After', String(Math.ceil(PRE_BODY_RATE_WINDOW_MS / 1000)))
      res
        .status(429)
        .json({ code: 'rate_limited', message: 'rate limit exceeded' })
      return
    }

    const match = BEARER_PATTERN.exec(req.get('authorization') || '')
    if (!match || match[1].length > MAX_BEARER_TOKEN_LENGTH) {
      res.setHeader('WWW-Authenticate', buildWwwAuthenticateHeader(config))
      res
        .status(401)
        .json({ code: 'unauthorized', message: 'an Authorization: Bearer token is required' })
      return
    }
    next()
  }
}

/**
 * Blank out an access_token query parameter before a URL is logged. The
 * parameter is a credential, so only its name survives in logs.
 *
 * @param {string} url
 * @returns {string}
 */
export function redactUrl(url) {
  return String(url ?? '').replace(/([?&]access_token=)[^&#]*/gi, '$1[redacted]')
}

/** Unauthenticated endpoint the OAuth consent page reads to describe tools. */
export const TOOLS_METADATA_PATH = '/tools/metadata'

/**
 * Require and authenticate a bearer token on the Authorization header.
 *
 * Supports both:
 * 1. RS256 signed OAuth 2.1 JWTs: verified statelessly via JWKS with 0 network latency.
 * 2. Personal Access Tokens (`olp_...`): validated against the Overleaf web API.
 * Valid tokens are cached in memory for cacheTtlMs to avoid excessive upstream
 * validation round-trips during active sessions.
 *
 * @param {object} [client] OverleafClient instance
 * @param {object} [options]
 * @param {number} [options.cacheTtlMs=60000]
 * @param {object} [options.config]
 * @param {object} [options.jwtVerifier] Custom JWT verifier instance for testing
 * @returns {import('express').RequestHandler}
 */
export function createBearerAuthMiddleware(
  client,
  { cacheTtlMs = 60000, config, jwtVerifier } = {}
) {
  const tokenCache = new Map()
  let verifier = jwtVerifier

  // Expired entries are otherwise never removed. Sweep them once the cache
  // grows past the limit, then evict the oldest entries if still over it.
  function rememberToken(token, entry) {
    if (tokenCache.size >= MAX_CACHED_TOKENS) {
      const now = Date.now()
      for (const [key, value] of tokenCache) {
        if (value.expiresAt <= now) tokenCache.delete(key)
      }
      while (tokenCache.size >= MAX_CACHED_TOKENS) {
        tokenCache.delete(tokenCache.keys().next().value)
      }
    }
    tokenCache.set(token, entry)
  }

  return async function requireBearerToken(req, res, next) {
    const activeConfig =
      config || req.app?.locals?.config || { resourceUri: 'http://localhost:3050/mcp' }
    const match = BEARER_PATTERN.exec(req.get('authorization') || '')
    if (!match) {
      res.setHeader('WWW-Authenticate', buildWwwAuthenticateHeader(activeConfig))
      res
        .status(401)
        .json({ code: 'unauthorized', message: 'an Authorization: Bearer token is required' })
      return
    }

    const token = match[1]
    const now = Date.now()
    const cached = tokenCache.get(token)
    if (cached && cached.expiresAt > now) {
      req.auth = {
        token,
        userId: cached.userId,
        clientId: cached.clientId || 'overleaf-mcp',
        scopes: cached.scopes || ['mcp'],
      }
      return next()
    }

    // Check if token is a JWT (3 dot-separated segments)
    const isJwt = token.split('.').length === 3
    if (isJwt) {
      if (!verifier) {
        const jwksUrl = `${activeConfig.authServerUrl || 'http://localhost:3000'}/.well-known/jwks.json`
        verifier = createJwtVerifier({
          jwksUrl,
          resourceUri: activeConfig.resourceUri,
          issuer: activeConfig.authServerUrl,
          fetchImpl: client?.fetchImpl || globalThis.fetch,
        })
      }

      try {
        const payload = await verifier.verifyToken(token)
        const expMs = payload.exp ? payload.exp * 1000 : now + cacheTtlMs
        const expiresAt = Math.min(expMs, now + cacheTtlMs)
        const userId = payload.sub
        const clientId = payload.client_id || 'overleaf-mcp'
        const scopes = parseScopes(payload.scope)

        rememberToken(token, {
          expiresAt,
          userId,
          clientId,
          scopes,
        })

        req.auth = { token, userId, clientId, scopes }
        return next()
      } catch (err) {
        // The verifier's own message can name internal URLs or echo the
        // token's header back, so clients get fixed text
        if (err.code === 'insufficient_scope') {
          const message = 'the access token lacks the mcp scope'
          res.setHeader(
            'WWW-Authenticate',
            buildWwwAuthenticateHeader(activeConfig, 'insufficient_scope', message)
          )
          res.status(403).json({ code: 'insufficient_scope', message })
          return
        }
        if (err.code === 'JWKS_UNAVAILABLE' || err.name === 'TimeoutError') {
          logger.warn({ err }, 'could not load the signing keys to verify a token')
          res.setHeader('Retry-After', '30')
          res.status(503).json({
            code: 'temporarily_unavailable',
            message: 'token verification is temporarily unavailable',
          })
          return
        }
        const code = 'invalid_token'
        const message = 'the access token is invalid or expired'
        res.setHeader(
          'WWW-Authenticate',
          buildWwwAuthenticateHeader(activeConfig, code, message)
        )
        res.status(401).json({ code, message })
        return
      }
    }

    // Fall back to Personal Access Token (olp_...) validation via OverleafClient
    // Without a client an opaque token cannot be validated, so reject it.
    // Passing it through would let any string act as a credential.
    const activeClient = client || req.app?.locals?.client
    if (!activeClient) {
      res.setHeader(
        'WWW-Authenticate',
        buildWwwAuthenticateHeader(activeConfig, 'invalid_token', 'token could not be validated')
      )
      res.status(401).json({ code: 'unauthorized', message: 'valid authentication required' })
      return
    }

    try {
      // Validation only needs one row: an unbounded listing costs web a full
      // project scan for every token that is not yet cached.
      await activeClient.get(token, '/projects', { limit: 1 })
      rememberToken(token, { expiresAt: now + cacheTtlMs })
    } catch (err) {
      // Only errors the client raised deliberately reach the caller. Any other
      // error's text could name internal details, so it is replaced.
      const known = err instanceof OverleafApiError
      const status = (known && err.status) || 401
      const code = (known && err.code) || 'unauthorized'
      const message = (known && err.message) || 'valid authentication required'
      res.setHeader(
        'WWW-Authenticate',
        buildWwwAuthenticateHeader(activeConfig, code, message)
      )
      res.status(status).json({ code, message })
      return
    }

    req.auth = { token, clientId: 'overleaf-mcp', scopes: ['mcp'] }
    next()
  }
}

const defaultBearerAuthMiddleware = createBearerAuthMiddleware()

export function requireBearerToken(clientOrReq, optionsOrRes, next) {
  if (typeof next === 'function') {
    return defaultBearerAuthMiddleware(clientOrReq, optionsOrRes, next)
  }
  return createBearerAuthMiddleware(clientOrReq, optionsOrRes)
}

export function expandHosts(hosts) {
  const result = new Set()
  for (const h of hosts) {
    result.add(h)
    const candidates = [h]
    if (h.includes(':') && !h.startsWith('[') && h.split(':').length > 2) {
      candidates.push(`[${h}]`)
    }
    for (const c of candidates) {
      try {
        result.add(new URL(`http://${c}`).hostname)
        break
      } catch {
        // Ignore invalid URL formatting
      }
    }
  }
  return Array.from(result)
}

/**
 * Reduce config.allowedOrigins entries to the hostnames the SDK compares. The
 * SDK matches an Origin header by hostname, so `https://chat.example` must be
 * passed as `chat.example`, or no browser origin would ever match it.
 *
 * @param {string[]} origins
 * @returns {string[]}
 */
export function originHostnames(origins) {
  const result = new Set()
  for (const origin of origins) {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(origin) ? origin : `http://${origin}`
    try {
      result.add(new URL(withScheme).hostname)
    } catch {
      // Unparseable entries stay as written, so they match nothing.
      result.add(origin)
    }
  }
  return Array.from(result)
}

/**
 * Build the Express app that serves the MCP endpoint.
 *
 * createMcpExpressApp applies express.json() and DNS-rebinding protection
 * (Host/Origin validation). The allow-lists come from config: loopback, plus
 * the site hostname, because nginx forwards the public Host to this service.
 *
 * @param {{ config: object, client: object }} deps
 * @returns {{ app: import('express').Express, handler: object }}
 */
export function createHttpApp({ config, client }) {
  const handler = createMcpHandler(createMcpServerFactory({ client }))
  const allowedHosts = expandHosts(config.allowedHosts)
  // The SDK app parses JSON on every request before its own checks run, so
  // the gate below sits in front of it, on the MCP endpoint only.
  const sdkApp = createMcpExpressApp({
    host: config.host,
    // Uploads travel as base64 inside JSON, so the SDK's default 100kb cap
    // would refuse most files. Limit request body size to maxBodyMb.
    jsonLimit: `${config.maxBodyMb ?? 70}mb`,
    ...(allowedHosts.length ? { allowedHosts } : {}),
    ...(config.allowedOrigins.length
      ? { allowedOrigins: originHostnames(config.allowedOrigins) }
      : {}),
  })
  const app = express()
  // Exact path only, so an endpoint mounted at '/' does not gate every route.
  app.all(config.endpointPath, createPreBodyGate(config))
  app.use(sdkApp)
  app.locals.client = client
  app.locals.config = config

  // RFC 9728 §3.1 puts the metadata for resource `https://host/mcp` at
  // `/.well-known/oauth-protected-resource/mcp` — the suffix is inserted before
  // the resource path, not appended to it. ChatGPT and Gemini request that form
  // directly, so omitting it breaks their OAuth client resolution outright. The
  // bare and path-appended forms stay registered as aliases for clients that
  // reach us via the WWW-Authenticate challenge instead.
  const endpointPath = (config.endpointPath || '/').replace(/\/+$/, '')
  const protectedResourcePaths = [PROTECTED_RESOURCE_WELL_KNOWN_PATH]
  if (endpointPath) {
    protectedResourcePaths.push(
      `${PROTECTED_RESOURCE_WELL_KNOWN_PATH}${endpointPath}`,
      `${endpointPath}${PROTECTED_RESOURCE_WELL_KNOWN_PATH}`
    )
  }

  app.get(protectedResourcePaths, (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.json(getProtectedResourceMetadata(config))
  })

  // Tool descriptions are static per deployment and carry no user data, so the
  // OAuth consent page -- rendered before the visitor holds a token -- can
  // fetch this to show what it is granting access to.
  app.get(TOOLS_METADATA_PATH, (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.json({
      categories: listToolMetadata(),
    })
  })

  // Proxy OAuth 2.1 authorization server endpoints, OIDC, and user auth flows to Overleaf Web
  if (config.internalUrl) {
    const forwardRoutes = [
      '/.well-known/oauth-authorization-server',
      '/.well-known/openid-configuration',
      '/.well-known/jwks.json',
      '/oauth/*',
      '/user/mcp/*',
      '/auth/*',
      '/login*',
      '/register*',
      '/logout*',
      '/stylesheets/*',
      '/js/*',
      '/img/*',
      '/fonts/*',
    ]
    for (const route of forwardRoutes) {
      app.all(route, (req, res) => {
        void proxyToInternalUrl(req, res, config.internalUrl)
      })
    }
  }

  const node = toNodeHandler(handler)
  const authMiddleware = requireBearerToken(client, { config })
  app.all(config.endpointPath, authMiddleware, (req, res) => {
    void node(req, res, req.body)
  })
  return { app, handler }
}

/**
 * Keep a redirect target from naming the internal web address, which the
 * browser cannot reach. A Location on that origin becomes a path on this one;
 * any other target is passed through. Returns null when it is not a URL.
 *
 * @param {string} location
 * @param {URL} internalBase the upstream request URL
 * @returns {string|null}
 */
function relativeLocation(location, internalBase) {
  let target
  try {
    target = new URL(location, internalBase)
  } catch {
    return null
  }
  if (target.origin !== internalBase.origin) return location
  return `${target.pathname}${target.search}${target.hash}`
}

export async function proxyToInternalUrl(req, res, internalUrl) {
  try {
    // Only the path and query of the incoming request are forwarded. Resolving
    // the raw request target against internalUrl would let an absolute-form
    // target (GET http://other/js/x) or a '//host' path pick the destination.
    const incoming = new URL(req.originalUrl || req.url, 'http://localhost')
    const targetUrl = new URL(internalUrl)
    targetUrl.pathname = incoming.pathname
    targetUrl.search = incoming.search
    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) {
      // Hop-by-hop headers describe this connection, not the forwarded request.
      if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v)
      } else if (value !== undefined) {
        headers.set(key, value)
      }
    }

    let body = undefined
    let duplex
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (typeof req.body === 'object' && req.body !== null && Object.keys(req.body).length > 0) {
        body = JSON.stringify(req.body)
        headers.set('content-type', 'application/json')
      } else if (typeof req.body === 'string') {
        body = req.body
      } else if (!req._body && req.readable) {
        // express.json() left a non-JSON body (a form post such as /login)
        // unread, so the raw stream is forwarded as it arrives.
        body = Readable.toWeb(req)
        duplex = 'half'
      }
    }

    const upstreamRes = await fetch(targetUrl, {
      method: req.method,
      headers,
      body,
      duplex,
      redirect: 'manual',
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    })

    res.status(upstreamRes.status)
    for (const [key, value] of upstreamRes.headers.entries()) {
      // fetch has already decoded the body, so the upstream encoding no longer applies.
      const lower = key.toLowerCase()
      if (HOP_BY_HOP_HEADERS.has(lower) || lower === 'content-encoding') continue
      if (lower === 'location') {
        const location = relativeLocation(value, targetUrl)
        if (location !== null) res.setHeader(key, location)
        continue
      }
      res.setHeader(key, value)
    }

    if (typeof upstreamRes.headers.getSetCookie === 'function') {
      const setCookies = upstreamRes.headers.getSetCookie()
      if (setCookies?.length) {
        res.setHeader('set-cookie', setCookies)
      }
    }

    const buffer = Buffer.from(await upstreamRes.arrayBuffer())
    res.send(buffer)
  } catch (err) {
    logger.warn(
      { err, url: redactUrl(req.originalUrl || req.url) },
      'could not proxy the request to web'
    )
    res.status(502).json({
      error: 'bad_gateway',
      error_description: 'the Overleaf web service could not be reached',
    })
  }
}
