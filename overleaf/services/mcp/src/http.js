import { createMcpExpressApp } from '@modelcontextprotocol/express'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { createMcpServerFactory } from './server.js'
import {
  PROTECTED_RESOURCE_WELL_KNOWN_PATH,
  getProtectedResourceMetadata,
  buildWwwAuthenticateHeader,
  createJwtVerifier,
} from './oauth.js'

const BEARER_PATTERN = /^Bearer\s+(\S+)$/i

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
        const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ') : ['mcp']

        tokenCache.set(token, {
          expiresAt,
          userId,
          clientId,
          scopes,
        })

        req.auth = { token, userId, clientId, scopes }
        return next()
      } catch (err) {
        const code = 'invalid_token'
        const message = err.message || 'invalid JWT token'
        res.setHeader(
          'WWW-Authenticate',
          buildWwwAuthenticateHeader(activeConfig, code, message)
        )
        res.status(401).json({ code, message })
        return
      }
    }

    // Fall back to Personal Access Token (olp_...) validation via OverleafClient
    const activeClient = client || req.app?.locals?.client
    if (activeClient) {
      try {
        await activeClient.get(token, '/projects', { query: '' })
        tokenCache.set(token, { expiresAt: now + cacheTtlMs })
      } catch (err) {
        const status = err.status || 401
        const code = err.code || 'unauthorized'
        const message = err.message || 'valid authentication required'
        res.setHeader(
          'WWW-Authenticate',
          buildWwwAuthenticateHeader(activeConfig, code, message)
        )
        res.status(status).json({ code, message })
        return
      }
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
 * Build the Express app that serves the MCP endpoint.
 *
 * createMcpExpressApp applies express.json() and DNS-rebinding protection
 * (Host/Origin validation). On the default loopback bind those default to
 * localhost; binding wider requires the explicit allow-lists config validates.
 *
 * @param {{ config: object, client: object }} deps
 * @returns {{ app: import('express').Express, handler: object }}
 */
export function createHttpApp({ config, client }) {
  const handler = createMcpHandler(
    createMcpServerFactory({ client, maxUploadBytes: config.maxUploadBytes })
  )
  const allowedHosts = expandHosts(config.allowedHosts)
  const app = createMcpExpressApp({
    host: config.host,
    ...(allowedHosts.length ? { allowedHosts } : {}),
    ...(config.allowedOrigins.length ? { allowedOrigins: [...config.allowedOrigins] } : {}),
  })
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

export async function proxyToInternalUrl(req, res, internalUrl) {
  try {
    const targetUrl = new URL(req.originalUrl || req.url, internalUrl)
    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) {
      const lower = key.toLowerCase()
      if (lower === 'host' || lower === 'content-length') continue
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v)
      } else if (value !== undefined) {
        headers.set(key, value)
      }
    }

    let body = undefined
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (typeof req.body === 'object' && req.body !== null && Object.keys(req.body).length > 0) {
        body = JSON.stringify(req.body)
        headers.set('content-type', 'application/json')
      } else if (typeof req.body === 'string') {
        body = req.body
      }
    }

    const upstreamRes = await fetch(targetUrl, {
      method: req.method,
      headers,
      body,
      redirect: 'manual',
    })

    res.status(upstreamRes.status)
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (key.toLowerCase() === 'transfer-encoding') continue
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
    res.status(502).json({ error: 'bad_gateway', error_description: err.message })
  }
}
