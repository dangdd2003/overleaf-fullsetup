import { describe, it, expect, vi, beforeEach } from 'vitest'
import OAuth2KeyManager from '../../../../../app/src/Features/OAuth2/OAuth2KeyManager.mjs'

const validateToken = vi.fn()
vi.mock(
  '../../../../../app/src/Features/PersonalAccessToken/PersonalAccessTokenManager.mjs',
  () => ({ default: { validateToken }, validateToken })
)
const { requireMcpAuth } = await import(
  '../../../../../app/src/Features/Mcp/McpAuthMiddleware.mjs'
)

function ctx(headers = {}) {
  const req = {
    method: 'GET',
    path: '/api/v0/mcp/projects',
    headers,
    get: name => headers[name.toLowerCase()],
  }
  const res = {
    statusCode: 0,
    body: null,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value
      return this
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
  const next = vi.fn()
  return { req, res, next }
}

beforeEach(() => {
  validateToken.mockReset()
})

describe('requireMcpAuth', () => {
  describe('PAT authentication (olp_...) backward-compatibility', () => {
    it('401 when no Authorization header and sets WWW-Authenticate header', async () => {
      const { req, res, next } = ctx()
      await requireMcpAuth(req, res, next)
      expect(res.statusCode).toBe(401)
      expect(res.body.code).toBe('unauthorized')
      expect(res.headers['WWW-Authenticate']).toBe('Bearer')
      expect(next).not.toHaveBeenCalled()
    })

    it('accepts lowercase "bearer <token>" headers', async () => {
      validateToken.mockResolvedValue({ userId: 'u1', email: 'e', scopes: ['mcp'] })
      const { req, res, next } = ctx({ authorization: 'bearer olp_good12345678' })
      await requireMcpAuth(req, res, next)
      expect(next).toHaveBeenCalled()
      expect(req.mcpUserId).toBe('u1')
      expect(req.mcpScopes).toEqual(['mcp'])
      expect(req.mcpTokenPrefix).toBe('olp_good')
    })

    it('sets WWW-Authenticate header with error and scope on 403 insufficient_scope', async () => {
      validateToken.mockResolvedValue({
        userId: 'u1',
        email: 'e',
        scopes: ['git_bridge'],
      })
      const { req, res, next } = ctx({ authorization: 'Bearer olp_x' })
      await requireMcpAuth(req, res, next)
      expect(res.statusCode).toBe(403)
      expect(res.body.code).toBe('insufficient_scope')
      expect(res.headers['WWW-Authenticate']).toBe(
        'Bearer error="insufficient_scope", scope="mcp"'
      )
      expect(next).not.toHaveBeenCalled()
    })

    it('401 when token is invalid', async () => {
      validateToken.mockResolvedValue(null)
      const { req, res, next } = ctx({ authorization: 'Bearer olp_bad' })
      await requireMcpAuth(req, res, next)
      expect(res.statusCode).toBe(401)
      expect(next).not.toHaveBeenCalled()
    })

    it('403 insufficient_scope when token lacks mcp scope', async () => {
      validateToken.mockResolvedValue({
        userId: 'u1',
        email: 'e',
        scopes: ['git_bridge'],
      })
      const { req, res, next } = ctx({ authorization: 'Bearer olp_x' })
      await requireMcpAuth(req, res, next)
      expect(res.statusCode).toBe(403)
      expect(res.body.code).toBe('insufficient_scope')
      expect(next).not.toHaveBeenCalled()
    })

    it('passes and sets req.mcpUserId when token has mcp scope', async () => {
      validateToken.mockResolvedValue({ userId: 'u1', email: 'e', scopes: ['mcp'] })
      const { req, res, next } = ctx({ authorization: 'Bearer olp_good12345678' })
      req.method = 'POST'
      await requireMcpAuth(req, res, next)
      expect(next).toHaveBeenCalled()
      expect(req.mcpUserId).toBe('u1')
      expect(req.mcpScopes).toEqual(['mcp'])
      expect(req.mcpTokenPrefix).toBe('olp_good')
    })

    it('ignores query-string and body tokens', async () => {
      const { req, res, next } = ctx()
      req.query = { token: 'olp_x' }
      req.body = { token: 'olp_y' }
      await requireMcpAuth(req, res, next)
      expect(res.statusCode).toBe(401)
      expect(validateToken).not.toHaveBeenCalled()
    })

    it('does not leak the token in the error body', async () => {
      validateToken.mockResolvedValue(null)
      const { req, res, next } = ctx({ authorization: 'Bearer olp_secretvalue' })
      await requireMcpAuth(req, res, next)
      expect(JSON.stringify(res.body)).not.toContain('olp_secretvalue')
      expect(next).not.toHaveBeenCalled()
    })

    it('401 when validateToken throws', async () => {
      validateToken.mockRejectedValue(new Error('db down'))
      const { req, res, next } = ctx({ authorization: 'Bearer olp_x' })
      await requireMcpAuth(req, res, next)
      expect(res.statusCode).toBe(401)
      expect(next).not.toHaveBeenCalled()
    })

    it('401 when Authorization header is not a Bearer token', async () => {
      const { req, res, next } = ctx({ authorization: 'Basic abc' })
      await requireMcpAuth(req, res, next)
      expect(res.statusCode).toBe(401)
      expect(validateToken).not.toHaveBeenCalled()
      expect(next).not.toHaveBeenCalled()
    })
  })

  describe('OAuth 2.1 RS256 JWT validation', () => {
    it('authenticates a valid RS256 JWT with mcp scope', async () => {
      const token = await OAuth2KeyManager.signJwt({
        sub: 'user_jwt_123',
        scope: 'mcp',
        iss: 'http://127.0.0.1:3000',
        aud: 'http://127.0.0.1:3000/mcp',
        exp: Math.floor(Date.now() / 1000) + 3600,
      })
      const { req, res, next } = ctx({ authorization: `Bearer ${token}` })
      await requireMcpAuth(req, res, next)
      expect(next).toHaveBeenCalled()
      expect(req.mcpUserId).toBe('user_jwt_123')
      expect(req.mcpScopes).toEqual(['mcp'])
      expect(req.mcpTokenPrefix).toBe(token.slice(0, 8))
      expect(validateToken).not.toHaveBeenCalled()
    })

    it('authenticates a valid RS256 JWT with multiple scopes including mcp', async () => {
      const token = await OAuth2KeyManager.signJwt({
        sub: 'user_jwt_456',
        scope: 'read write mcp profile',
        iss: 'http://127.0.0.1:3000',
        aud: 'http://127.0.0.1:3000/mcp',
        exp: Math.floor(Date.now() / 1000) + 3600,
      })
      const { req, res, next } = ctx({ authorization: `Bearer ${token}` })
      await requireMcpAuth(req, res, next)
      expect(next).toHaveBeenCalled()
      expect(req.mcpUserId).toBe('user_jwt_456')
      expect(req.mcpScopes).toEqual(['read', 'write', 'mcp', 'profile'])
    })

    it('403 insufficient_scope when JWT lacks mcp scope', async () => {
      const token = await OAuth2KeyManager.signJwt({
        sub: 'user_jwt_123',
        scope: 'read write',
        iss: 'http://127.0.0.1:3000',
        aud: 'http://127.0.0.1:3000/mcp',
        exp: Math.floor(Date.now() / 1000) + 3600,
      })
      const { req, res, next } = ctx({ authorization: `Bearer ${token}` })
      await requireMcpAuth(req, res, next)
      expect(res.statusCode).toBe(403)
      expect(res.body.code).toBe('insufficient_scope')
      expect(next).not.toHaveBeenCalled()
    })

    it('401 when JWT is expired', async () => {
      const token = await OAuth2KeyManager.signJwt({
        sub: 'user_jwt_123',
        scope: 'mcp',
        exp: Math.floor(Date.now() / 1000) - 100,
      })
      const { req, res, next } = ctx({ authorization: `Bearer ${token}` })
      await requireMcpAuth(req, res, next)
      expect(res.statusCode).toBe(401)
      expect(res.body.code).toBe('unauthorized')
      expect(next).not.toHaveBeenCalled()
    })

    it('401 when JWT signature is invalid', async () => {
      const token = await OAuth2KeyManager.signJwt({
        sub: 'user_jwt_123',
        scope: 'mcp',
        exp: Math.floor(Date.now() / 1000) + 3600,
      })
      const tampered = token.slice(0, -5) + 'xxxxx'
      const { req, res, next } = ctx({ authorization: `Bearer ${tampered}` })
      await requireMcpAuth(req, res, next)
      expect(res.statusCode).toBe(401)
      expect(res.body.code).toBe('unauthorized')
      expect(next).not.toHaveBeenCalled()
    })

    it('401 when JWT was minted for a different resource (aud mismatch)', async () => {
      const token = await OAuth2KeyManager.signJwt({
        sub: 'user_jwt_123',
        scope: 'mcp',
        iss: 'http://127.0.0.1:3000',
        aud: 'https://some-other-overleaf-instance.example/mcp',
        exp: Math.floor(Date.now() / 1000) + 3600,
      })
      const { req, res, next } = ctx({ authorization: `Bearer ${token}` })
      await requireMcpAuth(req, res, next)
      expect(res.statusCode).toBe(401)
      expect(res.body.code).toBe('unauthorized')
      expect(next).not.toHaveBeenCalled()
    })

    it('401 when JWT was minted by a different issuer', async () => {
      const token = await OAuth2KeyManager.signJwt({
        sub: 'user_jwt_123',
        scope: 'mcp',
        iss: 'https://some-other-overleaf-instance.example',
        aud: 'http://127.0.0.1:3000/mcp',
        exp: Math.floor(Date.now() / 1000) + 3600,
      })
      const { req, res, next } = ctx({ authorization: `Bearer ${token}` })
      await requireMcpAuth(req, res, next)
      expect(res.statusCode).toBe(401)
      expect(res.body.code).toBe('unauthorized')
      expect(next).not.toHaveBeenCalled()
    })
  })
})
