import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  beforeAll,
  afterAll,
} from 'vitest'
import OAuth2KeyManager from '../../../app/src/OAuth2/OAuth2KeyManager.mjs'
import { OauthAccessToken } from '../../../../../app/src/models/OauthAccessToken.mjs'

let keyDir
beforeAll(() => {
  // Signing needs a writable key file; the default path is not present here.
  keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-auth-test-'))
  OAuth2KeyManager._setKeyPathForTests(path.join(keyDir, 'key.pem'))
  OAuth2KeyManager._clearCache()
})

afterAll(() => {
  OAuth2KeyManager._setKeyPathForTests(null)
  OAuth2KeyManager._clearCache()
  fs.rmSync(keyDir, { recursive: true, force: true })
})

const validateToken = vi.fn()
vi.mock(
  '../../../../../app/src/Features/PersonalAccessToken/PersonalAccessTokenManager.mjs',
  () => ({ default: { validateToken }, validateToken })
)
const { requireMcpAuth } = await import(
  '../../../app/src/McpAuthMiddleware.mjs'
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
  it('does not authenticate again when the request guard already did', async () => {
    const { req, res, next } = ctx({ authorization: 'Bearer olp_abcd' })
    req.mcpUserId = 'u1'
    await requireMcpAuth(req, res, next)
    expect(validateToken).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith()
    expect(req.mcpUserId).toBe('u1')
  })

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
      expect(req.mcpTokenPrefix).toBe('olp_')
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
      expect(req.mcpTokenPrefix).toBe('olp_')
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
      expect(req.mcpTokenPrefix).toBe(token.slice(0, 4))
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

  describe('OAuth grant checks for non-expiring access tokens', () => {
    const grantId = '65f0c0ffee0000000000abcd'

    beforeEach(() => {
      vi.restoreAllMocks()
    })

    it('401 for a JWT with no exp, even while its grant is active', async () => {
      const existsSpy = vi
        .spyOn(OauthAccessToken, 'exists')
        .mockResolvedValue({ _id: grantId })
      const token = await OAuth2KeyManager.signJwt({
        sub: 'user_grant_1',
        scope: 'mcp',
        iss: 'http://127.0.0.1:3000',
        aud: 'http://127.0.0.1:3000/mcp',
        grant_id: grantId,
      })
      const { req, res, next } = ctx({ authorization: `Bearer ${token}` })
      await requireMcpAuth(req, res, next)
      expect(next).not.toHaveBeenCalled()
      expect(res.statusCode).toBe(401)
      expect(existsSpy).not.toHaveBeenCalled()
    })

    it('logs at most a four-character prefix of a JWT, never the secret part', async () => {
      const token = await OAuth2KeyManager.signJwt({
        sub: 'user_jwt_123',
        scope: 'mcp',
        iss: 'http://127.0.0.1:3000',
        aud: 'http://127.0.0.1:3000/mcp',
        exp: Math.floor(Date.now() / 1000) + 3600,
      })
      const { req, res, next } = ctx({ authorization: `Bearer ${token}` })
      await requireMcpAuth(req, res, next)
      expect(req.mcpTokenPrefix).toHaveLength(4)
      expect(JSON.stringify(req)).not.toContain(token)
    })

    it('401 when the grant behind a JWT was revoked', async () => {
      vi.spyOn(OauthAccessToken, 'exists').mockResolvedValue(null)
      const token = await OAuth2KeyManager.signJwt({
        sub: 'user_grant_2',
        scope: 'mcp',
        iss: 'http://127.0.0.1:3000',
        aud: 'http://127.0.0.1:3000/mcp',
        grant_id: grantId,
      })
      const { req, res, next } = ctx({ authorization: `Bearer ${token}` })
      await requireMcpAuth(req, res, next)
      expect(res.statusCode).toBe(401)
      expect(res.body.code).toBe('unauthorized')
      expect(next).not.toHaveBeenCalled()
    })

    it('does not look up a grant for a token issued before grants existed', async () => {
      const existsSpy = vi.spyOn(OauthAccessToken, 'exists')
      const token = await OAuth2KeyManager.signJwt({
        sub: 'user_grant_3',
        scope: 'mcp',
        iss: 'http://127.0.0.1:3000',
        aud: 'http://127.0.0.1:3000/mcp',
        exp: Math.floor(Date.now() / 1000) + 3600,
      })
      const { req, res, next } = ctx({ authorization: `Bearer ${token}` })
      await requireMcpAuth(req, res, next)
      expect(next).toHaveBeenCalled()
      expect(existsSpy).not.toHaveBeenCalled()
    })
  })
})
