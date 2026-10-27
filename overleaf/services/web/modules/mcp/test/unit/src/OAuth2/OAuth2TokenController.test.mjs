import { describe, it, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import { expect } from 'chai'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import OAuth2TokenController from '../../../../app/src/OAuth2/OAuth2TokenController.mjs'
import OAuth2KeyManager from '../../../../app/src/OAuth2/OAuth2KeyManager.mjs'
import { OauthAuthorizationCode } from '../../../../../../app/src/models/OauthAuthorizationCode.mjs'
import { OauthAccessToken } from '../../../../../../app/src/models/OauthAccessToken.mjs'
import { db } from '../../../../../../app/src/infrastructure/mongodb.mjs'
import Settings from '@overleaf/settings'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

function sha256(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function createMockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    responseData: null,
    status(s) {
      this.statusCode = s
      return this
    },
    setHeader(k, v) {
      this.headers[k] = v
      return this
    },
    json(data) {
      this.responseData = data
      return this
    },
  }
  return res
}

describe('OAuth2TokenController', () => {
  let keyDir

  beforeAll(() => {
    // Signing needs a writable key file; the default path is not present here.
    keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth2-token-test-'))
    OAuth2KeyManager._setKeyPathForTests(path.join(keyDir, 'key.pem'))
  })

  afterAll(() => {
    OAuth2KeyManager._setKeyPathForTests(null)
    OAuth2KeyManager._clearCache()
    fs.rmSync(keyDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    vi.restoreAllMocks()
    OAuth2KeyManager._clearCache()
  })

  describe('verifyPkce (S256)', () => {
    it('validates PKCE S256 code verifier against code challenge in constant-time', () => {
      const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
      const expectedChallenge = crypto
        .createHash('sha256')
        .update(verifier)
        .digest('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')

      expect(OAuth2TokenController.verifyPkce(verifier, expectedChallenge)).to.be.true
      expect(OAuth2TokenController.verifyPkce('wrong_verifier', expectedChallenge)).to.be.false
      expect(OAuth2TokenController.verifyPkce('', expectedChallenge)).to.be.false
      expect(OAuth2TokenController.verifyPkce(verifier, '')).to.be.false
      expect(OAuth2TokenController.verifyPkce(null, expectedChallenge)).to.be.false
      expect(OAuth2TokenController.verifyPkce(verifier, null)).to.be.false
    })

    it('returns false for code_verifier shorter than 43 chars', () => {
      const shortVerifier = 'a'.repeat(42)
      const challenge = crypto
        .createHash('sha256')
        .update(shortVerifier)
        .digest('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')

      expect(OAuth2TokenController.verifyPkce(shortVerifier, challenge)).to.be.false
    })

    it('returns false for code_verifier longer than 128 chars', () => {
      const longVerifier = 'a'.repeat(129)
      const challenge = crypto
        .createHash('sha256')
        .update(longVerifier)
        .digest('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')

      expect(OAuth2TokenController.verifyPkce(longVerifier, challenge)).to.be.false
    })

    it('returns false for code_verifier with invalid characters', () => {
      const verifierWithSpaces = 'a'.repeat(42) + ' '
      const challenge1 = crypto
        .createHash('sha256')
        .update(verifierWithSpaces)
        .digest('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
      expect(OAuth2TokenController.verifyPkce(verifierWithSpaces, challenge1)).to.be.false

      const verifierWithAt = 'a'.repeat(42) + '@'
      const challenge2 = crypto
        .createHash('sha256')
        .update(verifierWithAt)
        .digest('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
      expect(OAuth2TokenController.verifyPkce(verifierWithAt, challenge2)).to.be.false

      const verifierWithExclamation = 'a'.repeat(42) + '!'
      const challenge3 = crypto
        .createHash('sha256')
        .update(verifierWithExclamation)
        .digest('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
      expect(OAuth2TokenController.verifyPkce(verifierWithExclamation, challenge3)).to.be.false
    })

    it('returns true for valid 43-128 char unreserved string matching challenge', () => {
      const validChars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~'
      const valid43 = validChars.slice(0, 43)
      const challenge43 = crypto
        .createHash('sha256')
        .update(valid43)
        .digest('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
      expect(OAuth2TokenController.verifyPkce(valid43, challenge43)).to.be.true

      const valid128 = (validChars + validChars).slice(0, 128)
      const challenge128 = crypto
        .createHash('sha256')
        .update(valid128)
        .digest('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
      expect(OAuth2TokenController.verifyPkce(valid128, challenge128)).to.be.true
    })
  })

  describe('grant_type validation', () => {
    it('rejects unsupported grant types', async () => {
      const req = {
        body: {
          grant_type: 'client_credentials',
        },
      }
      const res = createMockRes()

      await OAuth2TokenController.token(req, res)
      expect(res.statusCode).to.equal(400)
      expect(res.responseData).to.deep.equal({
        error: 'unsupported_grant_type',
        error_description: 'grant_type must be authorization_code or refresh_token',
      })
    })

    it('rejects missing grant_type', async () => {
      const req = { body: {} }
      const res = createMockRes()

      await OAuth2TokenController.token(req, res)
      expect(res.statusCode).to.equal(400)
      expect(res.responseData.error).to.equal('unsupported_grant_type')
    })
  })

  describe('grant_type: authorization_code', () => {
    const validVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    const validChallenge = crypto
      .createHash('sha256')
      .update(validVerifier)
      .digest('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')

    it('rejects request when code or code_verifier is missing', async () => {
      const req = {
        body: {
          grant_type: 'authorization_code',
          code: 'some_code',
        },
      }
      const res = createMockRes()

      await OAuth2TokenController.token(req, res)
      expect(res.statusCode).to.equal(400)
      expect(res.responseData).to.deep.equal({
        error: 'invalid_request',
        error_description: 'code and code_verifier are required',
      })

      const req2 = {
        body: {
          grant_type: 'authorization_code',
          code_verifier: 'some_verifier',
        },
      }
      const res2 = createMockRes()
      await OAuth2TokenController.token(req2, res2)
      expect(res2.statusCode).to.equal(400)
      expect(res2.responseData.error).to.equal('invalid_request')
    })

    it('rejects when authorization code is not found', async () => {
      vi.spyOn(OauthAuthorizationCode, 'findOneAndDelete').mockResolvedValue(null)

      const req = {
        body: {
          grant_type: 'authorization_code',
          code: 'nonexistent_code',
          code_verifier: validVerifier,
          client_id: 'claude',
          redirect_uri: 'http://localhost:54321/callback',
        },
      }
      const res = createMockRes()

      await OAuth2TokenController.token(req, res)
      expect(res.statusCode).to.equal(400)
      expect(res.responseData).to.deep.equal({
        error: 'invalid_grant',
        error_description: 'Authorization code is invalid or already used',
      })
    })

    it('deletes authorization code atomically via findOneAndDelete (single-use) to prevent replay attacks', async () => {
      const mockAuthRecord = {
        _id: 'auth_rec_123',
        authorizationCode: 'valid_code',
        codeChallenge: validChallenge,
        codeChallengeMethod: 'S256',
        client_id: 'claude',
        redirectUri: 'http://localhost:54321/callback',
        user_id: 'user_mock_123',
        scope: 'mcp',
        expiresAt: new Date(Date.now() + 60000),
      }

      let deletedQuery = null
      vi.spyOn(OauthAuthorizationCode, 'findOneAndDelete').mockImplementation(async query => {
        deletedQuery = query
        return mockAuthRecord
      })
      const deleteOneSpy = vi.spyOn(OauthAuthorizationCode, 'deleteOne')
      let createdTokenDoc = null
      vi.spyOn(OauthAccessToken, 'create').mockImplementation(async doc => {
        createdTokenDoc = doc
        return doc
      })

      const req = {
        body: {
          grant_type: 'authorization_code',
          code: 'valid_code',
          code_verifier: validVerifier,
          client_id: 'claude',
          redirect_uri: 'http://localhost:54321/callback',
        },
        get: () => 'localhost:3000',
      }
      const res = createMockRes()

      await OAuth2TokenController.token(req, res)
      // The stored value is the hash of the code, never the code itself.
      expect(deletedQuery).to.deep.equal({ authorizationCode: sha256('valid_code') })
      expect(deleteOneSpy.mock.calls.length).to.equal(0)
      expect(createdTokenDoc.client_id).to.equal('claude')
      expect(createdTokenDoc.audience).to.equal(`${Settings.siteUrl}/mcp`)
      expect(res.statusCode).to.equal(200)
    })

    it('rejects expired authorization code', async () => {
      const mockAuthRecord = {
        _id: 'auth_rec_expired',
        authorizationCode: 'expired_code',
        codeChallenge: validChallenge,
        client_id: 'claude',
        redirectUri: 'http://localhost:54321/callback',
        user_id: 'user_123',
        expiresAt: new Date(Date.now() - 10000), // Expired 10s ago
      }

      vi.spyOn(OauthAuthorizationCode, 'findOneAndDelete').mockResolvedValue(mockAuthRecord)

      const req = {
        body: {
          grant_type: 'authorization_code',
          code: 'expired_code',
          code_verifier: validVerifier,
          client_id: 'claude',
          redirect_uri: 'http://localhost:54321/callback',
        },
      }
      const res = createMockRes()

      await OAuth2TokenController.token(req, res)
      expect(res.statusCode).to.equal(400)
      expect(res.responseData).to.deep.equal({
        error: 'invalid_grant',
        error_description: 'Authorization code has expired',
      })
    })

    it('rejects client_id or redirect_uri mismatch', async () => {
      const mockAuthRecord = {
        _id: 'auth_rec_mismatch',
        authorizationCode: 'valid_code',
        codeChallenge: validChallenge,
        client_id: 'claude',
        redirectUri: 'http://localhost:54321/callback',
        user_id: 'user_123',
        expiresAt: new Date(Date.now() + 60000),
      }

      vi.spyOn(OauthAuthorizationCode, 'findOneAndDelete').mockResolvedValue(mockAuthRecord)

      // Wrong client_id
      const req1 = {
        body: {
          grant_type: 'authorization_code',
          code: 'valid_code',
          code_verifier: validVerifier,
          client_id: 'different_client',
          redirect_uri: 'http://localhost:54321/callback',
        },
      }
      const res1 = createMockRes()
      await OAuth2TokenController.token(req1, res1)
      expect(res1.statusCode).to.equal(400)
      expect(res1.responseData.error).to.equal('invalid_grant')
      expect(res1.responseData.error_description).to.include('mismatch')

      // Wrong redirect_uri
      const req2 = {
        body: {
          grant_type: 'authorization_code',
          code: 'valid_code',
          code_verifier: validVerifier,
          client_id: 'claude',
          redirect_uri: 'http://localhost:9999/other_callback',
        },
      }
      const res2 = createMockRes()
      await OAuth2TokenController.token(req2, res2)
      expect(res2.statusCode).to.equal(400)
      expect(res2.responseData.error).to.equal('invalid_grant')
      expect(res2.responseData.error_description).to.include('mismatch')
    })

    it('rejects invalid PKCE code_verifier', async () => {
      const mockAuthRecord = {
        _id: 'auth_rec_bad_pkce',
        authorizationCode: 'valid_code',
        codeChallenge: validChallenge,
        client_id: 'claude',
        redirectUri: 'http://localhost:54321/callback',
        user_id: 'user_123',
        expiresAt: new Date(Date.now() + 60000),
      }

      vi.spyOn(OauthAuthorizationCode, 'findOneAndDelete').mockResolvedValue(mockAuthRecord)

      const req = {
        body: {
          grant_type: 'authorization_code',
          code: 'valid_code',
          code_verifier: 'incorrect_verifier_value',
          client_id: 'claude',
          redirect_uri: 'http://localhost:54321/callback',
        },
      }
      const res = createMockRes()

      await OAuth2TokenController.token(req, res)
      expect(res.statusCode).to.equal(400)
      expect(res.responseData).to.deep.equal({
        error: 'invalid_grant',
        error_description: 'PKCE verification failed',
      })
    })

    it('rejects an authorization_code exchange that names a different resource', async () => {
      vi.spyOn(OauthAuthorizationCode, 'findOneAndDelete').mockResolvedValue({
        authorizationCode: 'valid_code',
        codeChallenge: validChallenge,
        client_id: 'claude',
        redirectUri: 'http://localhost:54321/callback',
        user_id: 'user_abc_789',
        scope: 'mcp',
        expiresAt: new Date(Date.now() + 60000),
      })
      const createSpy = vi.spyOn(OauthAccessToken, 'create')

      const req = {
        body: {
          grant_type: 'authorization_code',
          code: 'valid_code',
          code_verifier: validVerifier,
          client_id: 'claude',
          redirect_uri: 'http://localhost:54321/callback',
          resource: 'http://malicious-site.com/mcp',
        },
        get: h => (h === 'host' ? 'localhost:3000' : ''),
        protocol: 'http',
      }
      const res = createMockRes()

      await OAuth2TokenController.token(req, res)
      expect(res.statusCode).to.equal(400)
      expect(res.responseData.error).to.equal('invalid_target')
      expect(createSpy.mock.calls).to.have.length(0)
    })

    it('mints valid RS256 JWT access token and issues refresh token on success', async () => {
      const mockAuthRecord = {
        _id: 'auth_rec_success',
        authorizationCode: 'valid_code',
        codeChallenge: validChallenge,
        client_id: 'claude',
        redirectUri: 'http://localhost:54321/callback',
        user_id: 'user_abc_789',
        scope: 'mcp',
        resource: 'http://localhost:3050/mcp',
        expiresAt: new Date(Date.now() + 60000),
      }

      vi.spyOn(OauthAuthorizationCode, 'findOneAndDelete').mockResolvedValue(mockAuthRecord)

      let createdTokenDoc = null
      vi.spyOn(OauthAccessToken, 'create').mockImplementation(async doc => {
        createdTokenDoc = doc
        return doc
      })

      const req = {
        body: {
          grant_type: 'authorization_code',
          code: 'valid_code',
          code_verifier: validVerifier,
          client_id: 'claude',
          redirect_uri: 'http://localhost:54321/callback',
        },
        get: h => (h === 'host' ? 'localhost:3000' : ''),
        protocol: 'http',
      }
      const res = createMockRes()

      await OAuth2TokenController.token(req, res)
      expect(res.statusCode).to.equal(200)
      expect(res.responseData).to.have.property('access_token').that.is.a('string')
      expect(res.responseData.token_type).to.equal('Bearer')
      expect(res.responseData.expires_in).to.equal(60 * 60)
      expect(res.responseData).to.have.property('refresh_token').that.is.a('string').and.match(/^oar_[0-9a-f]{64}$/)
      expect(res.responseData.scope).to.equal('mcp')

      // Verify the minted JWT with OAuth2KeyManager
      const decodedPayload = await OAuth2KeyManager.verifyJwt(res.responseData.access_token)
      expect(decodedPayload.sub).to.equal('user_abc_789')
      expect(decodedPayload.aud).to.equal(`${Settings.siteUrl}/mcp`)
      expect(decodedPayload.client_id).to.equal('claude')
      expect(decodedPayload.scope).to.equal('mcp')
      expect(decodedPayload).to.have.property('jti').that.match(/^jwt_[0-9a-f]{32}$/)
      expect(decodedPayload.exp - decodedPayload.iat).to.equal(60 * 60)
      expect(decodedPayload.grant_id).to.equal(String(createdTokenDoc._id))

      // Verify token DB record: only the hash is persisted, never the raw token
      expect(createdTokenDoc).to.exist
      expect(createdTokenDoc.refreshToken).to.equal(
        sha256(res.responseData.refresh_token)
      )
      expect(createdTokenDoc.refreshToken).to.not.equal(
        res.responseData.refresh_token
      )
      expect(createdTokenDoc).to.not.have.property('expiresAt')
      expect(createdTokenDoc).to.not.have.property('accessTokenExpiresAt')
      expect(createdTokenDoc.refreshTokenExpiresAt.getTime()).to.be.above(
        Date.now() + 89 * DAY_MS
      )
      expect(createdTokenDoc.user_id).to.equal('user_abc_789')
      expect(createdTokenDoc.scope).to.equal('mcp')
    })
  })

  describe('grant_type: refresh_token', () => {
    it('rejects when refresh_token is missing', async () => {
      const req = {
        body: {
          grant_type: 'refresh_token',
        },
      }
      const res = createMockRes()

      await OAuth2TokenController.token(req, res)
      expect(res.statusCode).to.equal(400)
      expect(res.responseData).to.deep.equal({
        error: 'invalid_request',
        error_description: 'refresh_token is required',
      })
    })

    it('rejects invalid or unknown refresh token', async () => {
      vi.spyOn(OauthAccessToken, 'findOne').mockResolvedValue(null)
      vi.spyOn(db.oauthAccessTokens, 'findOne').mockResolvedValue(null)

      const req = {
        body: {
          grant_type: 'refresh_token',
          refresh_token: 'oar_nonexistent',
        },
      }
      const res = createMockRes()

      await OAuth2TokenController.token(req, res)
      expect(res.statusCode).to.equal(400)
      expect(res.responseData).to.deep.equal({
        error: 'invalid_grant',
        error_description: 'Invalid refresh token',
      })
    })

    it('rejects refresh_token when client_id does not match tokenRecord', async () => {
      const tokenRecord = {
        refreshToken: sha256('oar_valid'),
        client_id: 'claude-desktop',
        audience: 'http://localhost:3000/mcp',
        user_id: 'user123',
        scope: 'mcp',
        refreshTokenExpiresAt: new Date(Date.now() + 60000),
      }
      vi.spyOn(OauthAccessToken, 'findOne').mockResolvedValue(tokenRecord)

      const req = {
        body: {
          grant_type: 'refresh_token',
          refresh_token: 'oar_valid',
          client_id: 'chatgpt',
        },
      }
      const res = createMockRes()

      await OAuth2TokenController.token(req, res)
      expect(res.statusCode).to.equal(400)
      expect(res.responseData.error).to.equal('invalid_grant')
      expect(res.responseData.error_description).to.include('client_id mismatch')
    })

    it('rejects refresh_token when requested resource does not match audience', async () => {
      const tokenRecord = {
        refreshToken: sha256('oar_valid'),
        client_id: 'claude',
        audience: 'http://localhost:3000/mcp',
        user_id: 'user123',
        scope: 'mcp',
        refreshTokenExpiresAt: new Date(Date.now() + 60000),
      }
      vi.spyOn(OauthAccessToken, 'findOne').mockResolvedValue(tokenRecord)

      const req = {
        body: {
          grant_type: 'refresh_token',
          refresh_token: 'oar_valid',
          client_id: 'claude',
          resource: 'http://malicious-site.com/mcp',
        },
      }
      const res = createMockRes()

      await OAuth2TokenController.token(req, res)
      expect(res.statusCode).to.equal(400)
      expect(res.responseData.error).to.equal('invalid_target')
      expect(res.responseData.error_description).to.include('Requested resource does not match')
    })

    function refreshRequest(refreshToken = 'oar_old_token', extraBody = {}) {
      return {
        body: {
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: 'claude',
          resource: 'http://localhost:3050/mcp',
          ...extraBody,
        },
        get: () => 'localhost:3000',
        protocol: 'http',
      }
    }

    function baseGrant(overrides = {}) {
      return {
        _id: 'grant_rotation_1',
        refreshToken: sha256('oar_old_token'),
        refreshTokenExpiresAt: new Date(Date.now() + 60 * DAY_MS),
        createdAt: new Date(Date.now() - DAY_MS),
        user_id: 'user_rotation_123',
        client_id: 'claude',
        audience: 'http://localhost:3050/mcp',
        scope: 'mcp',
        ...overrides,
      }
    }

    // In-memory stand-in for the grant collection. Each update checks the
    // filter against the stored state, the way a Mongo findOneAndUpdate does,
    // so a test can run requests against it in any order or concurrently.
    function fakeGrantStore(initial) {
      const store = { ...initial }
      const matchesField = (key, value) => {
        if (key === '$or') return value.some(sub => matches(sub))
        if (key === 'supersededRefreshTokens.hash') {
          return (store.supersededRefreshTokens || []).some(
            t => t.hash === value
          )
        }
        if (value === null) return store[key] === undefined || store[key] === null
        return String(store[key]) === String(value)
      }
      const matches = filter =>
        !store.deleted &&
        Object.entries(filter).every(([key, value]) => matchesField(key, value))
      vi.spyOn(OauthAccessToken, 'findOne').mockImplementation(async filter =>
        matches(filter) ? { ...store } : null
      )
      vi.spyOn(db.oauthAccessTokens, 'findOne').mockImplementation(async filter =>
        matches(filter) ? { ...store } : null
      )
      vi.spyOn(db.oauthAccessTokens, 'findOneAndUpdate').mockImplementation(
        async (filter, update) => {
          if (!matches(filter)) return null
          Object.assign(store, update.$set)
          for (const [key, value] of Object.entries(update.$push || {})) {
            const items = value?.$each ?? [value]
            const list = [...(store[key] || []), ...items]
            store[key] = value?.$slice ? list.slice(value.$slice) : list
          }
          return { _id: store._id }
        }
      )
      vi.spyOn(OauthAccessToken, 'deleteOne').mockImplementation(async filter => {
        if (!matches(filter)) return { deletedCount: 0 }
        store.deleted = true
        return { deletedCount: 1 }
      })
      return store
    }

    it('rotates the refresh token: returns a new one and stores only its hash', async () => {
      const grant = baseGrant()
      vi.spyOn(OauthAccessToken, 'findOne').mockResolvedValue(grant)
      const findOneAndUpdate = vi
        .spyOn(db.oauthAccessTokens, 'findOneAndUpdate')
        .mockResolvedValue({ _id: grant._id })

      const res = createMockRes()
      await OAuth2TokenController.token(refreshRequest(), res)
      expect(res.statusCode).to.equal(200)
      expect(res.responseData.access_token).to.be.a('string')
      expect(res.responseData.token_type).to.equal('Bearer')
      expect(res.responseData.expires_in).to.equal(60 * 60)
      expect(res.responseData.refresh_token).to.match(/^oar_[0-9a-f]{64}$/)
      expect(res.responseData.refresh_token).to.not.equal('oar_old_token')

      // Update is conditioned on the current hash, so only one request can win
      const [filter, update] = findOneAndUpdate.mock.calls[0]
      expect(filter).to.deep.equal({
        _id: grant._id,
        refreshToken: sha256('oar_old_token'),
      })
      expect(update.$set.refreshToken).to.equal(
        sha256(res.responseData.refresh_token)
      )

      // The grant id is unchanged, so McpAuthMiddleware's grant check still matches
      const payload = await OAuth2KeyManager.verifyJwt(res.responseData.access_token)
      expect(payload.grant_id).to.equal(String(grant._id))
      expect(payload.sub).to.equal('user_rotation_123')
      expect(payload.aud).to.equal('http://localhost:3050/mcp')
    })

    it('does not rotate when the refresh token belongs to another client', async () => {
      vi.spyOn(OauthAccessToken, 'findOne').mockResolvedValue(
        baseGrant({ client_id: 'claude-desktop' })
      )
      const findOneAndUpdate = vi.spyOn(db.oauthAccessTokens, 'findOneAndUpdate')

      const res = createMockRes()
      await OAuth2TokenController.token(refreshRequest(), res)
      expect(res.statusCode).to.equal(400)
      expect(res.responseData.error).to.equal('invalid_grant')
      expect(res.responseData.error_description).to.include('client_id mismatch')
      expect(findOneAndUpdate.mock.calls).to.have.lengthOf(0)
    })

    it('does not rotate when the requested resource does not match the audience', async () => {
      vi.spyOn(OauthAccessToken, 'findOne').mockResolvedValue(baseGrant())
      const findOneAndUpdate = vi.spyOn(db.oauthAccessTokens, 'findOneAndUpdate')

      const res = createMockRes()
      await OAuth2TokenController.token(
        refreshRequest('oar_old_token', { resource: 'http://evil.example/mcp' }),
        res
      )
      expect(res.statusCode).to.equal(400)
      expect(res.responseData.error).to.equal('invalid_target')
      expect(findOneAndUpdate.mock.calls).to.have.lengthOf(0)
    })

    it('rejects a refresh token that is unknown', async () => {
      vi.spyOn(OauthAccessToken, 'findOne').mockResolvedValue(null)
      vi.spyOn(db.oauthAccessTokens, 'findOne').mockResolvedValue(null)
      const findOneAndUpdate = vi.spyOn(db.oauthAccessTokens, 'findOneAndUpdate')

      const res = createMockRes()
      await OAuth2TokenController.token(refreshRequest('oar_nonexistent'), res)
      expect(res.statusCode).to.equal(400)
      expect(res.responseData).to.deep.equal({
        error: 'invalid_grant',
        error_description: 'Invalid refresh token',
      })
      expect(findOneAndUpdate.mock.calls).to.have.lengthOf(0)
    })

    it('rejects an already rotated refresh token', async () => {
      vi.spyOn(OauthAccessToken, 'findOne').mockResolvedValue(baseGrant())
      vi.spyOn(db.oauthAccessTokens, 'findOne').mockResolvedValue(null)
      // Another request won the race and changed the stored hash first
      vi.spyOn(db.oauthAccessTokens, 'findOneAndUpdate').mockResolvedValue(null)

      const res = createMockRes()
      await OAuth2TokenController.token(refreshRequest(), res)
      expect(res.statusCode).to.equal(400)
      expect(res.responseData.error).to.equal('invalid_grant')
    })

    describe('refresh token reuse', () => {
      const HOUR = 60 * 60 * 1000

      it('keeps the hash and rotation time of the token it superseded', async () => {
        const store = fakeGrantStore(baseGrant({ refreshToken: sha256('oar_old_token') }))
        const before = Date.now()
        const res = createMockRes()
        await OAuth2TokenController.token(refreshRequest(), res)
        expect(res.statusCode).to.equal(200)
        expect(store.supersededRefreshTokens).to.have.lengthOf(1)
        expect(store.supersededRefreshTokens[0].hash).to.equal(sha256('oar_old_token'))
        expect(store.supersededRefreshTokens[0].rotatedAt.getTime()).to.be.within(
          before,
          Date.now()
        )
      })

      it('revokes the whole grant when a superseded refresh token is presented later', async () => {
        const store = fakeGrantStore(
          baseGrant({
            refreshToken: sha256('oar_current_token'),
            supersededRefreshTokens: [
              { hash: sha256('oar_old_token'), rotatedAt: new Date(Date.now() - HOUR) },
            ],
          })
        )
        const res = createMockRes()
        await OAuth2TokenController.token(refreshRequest('oar_old_token'), res)
        expect(res.statusCode).to.equal(400)
        expect(res.responseData.error).to.equal('invalid_grant')
        expect(res.responseData.error_description).to.match(/revoked/)
        expect(store.deleted).to.equal(true)
      })

      it('does not revoke the grant when the superseded token is reused inside the race window', async () => {
        const store = fakeGrantStore(
          baseGrant({
            refreshToken: sha256('oar_current_token'),
            supersededRefreshTokens: [
              { hash: sha256('oar_old_token'), rotatedAt: new Date(Date.now() - 1000) },
            ],
          })
        )
        const res = createMockRes()
        await OAuth2TokenController.token(refreshRequest('oar_old_token'), res)
        expect(res.statusCode).to.equal(400)
        expect(res.responseData.error).to.equal('invalid_grant')
        expect(res.responseData.error_description).to.not.match(/revoked/)
        expect(store.deleted).to.not.equal(true)
      })

      it('does not revoke when a superseded token from another client is presented', async () => {
        const store = fakeGrantStore(
          baseGrant({
            refreshToken: sha256('oar_current_token'),
            client_id: 'claude-desktop',
            supersededRefreshTokens: [
              { hash: sha256('oar_old_token'), rotatedAt: new Date(Date.now() - HOUR) },
            ],
          })
        )
        const res = createMockRes()
        await OAuth2TokenController.token(refreshRequest('oar_old_token'), res)
        expect(res.statusCode).to.equal(400)
        expect(res.responseData.error).to.equal('invalid_grant')
        expect(store.deleted).to.not.equal(true)
      })

      it('lets a legitimate concurrent refresh lose the race without revoking the grant', async () => {
        const store = fakeGrantStore(baseGrant({ refreshToken: sha256('oar_old_token') }))
        const resA = createMockRes()
        const resB = createMockRes()
        await Promise.all([
          OAuth2TokenController.token(refreshRequest(), resA),
          OAuth2TokenController.token(refreshRequest(), resB),
        ])
        const statuses = [resA.statusCode, resB.statusCode].sort()
        expect(statuses).to.deep.equal([200, 400])
        const loser = resA.statusCode === 400 ? resA : resB
        expect(loser.responseData.error).to.equal('invalid_grant')
        expect(store.deleted).to.not.equal(true)
        expect(store.refreshToken).to.not.equal(sha256('oar_old_token'))
      })
    })

    it('resets the 90-day idle window on rotation and records no access expiry', async () => {
      const grant = baseGrant()
      vi.spyOn(OauthAccessToken, 'findOne').mockResolvedValue(grant)
      const findOneAndUpdate = vi
        .spyOn(db.oauthAccessTokens, 'findOneAndUpdate')
        .mockResolvedValue({ _id: grant._id })

      const before = Date.now()
      const res = createMockRes()
      await OAuth2TokenController.token(refreshRequest(), res)
      expect(res.statusCode).to.equal(200)
      const { $set } = findOneAndUpdate.mock.calls[0][1]
      expect($set.refreshTokenExpiresAt.getTime()).to.be.within(
        before + 90 * DAY_MS,
        Date.now() + 90 * DAY_MS
      )
      expect($set).to.not.have.property('accessTokenExpiresAt')
      expect(findOneAndUpdate.mock.calls[0][1].$unset).to.deep.equal({
        accessTokenExpiresAt: '',
      })
      expect($set.expiresAt).to.be.null
    })

    it('refuses a refresh token unused for 90 days, and asks the user to authorize again', async () => {
      const grant = baseGrant({
        refreshTokenExpiresAt: new Date(Date.now() - 1000),
      })
      vi.spyOn(OauthAccessToken, 'findOne').mockResolvedValue(grant)
      const findOneAndUpdate = vi.spyOn(db.oauthAccessTokens, 'findOneAndUpdate')

      const res = createMockRes()
      await OAuth2TokenController.token(refreshRequest(), res)
      expect(res.statusCode).to.equal(400)
      expect(res.responseData.error).to.equal('invalid_grant')
      expect(res.responseData.error_description).to.match(/expired/)
      expect(findOneAndUpdate.mock.calls).to.have.lengthOf(0)
    })

    it('applies the idle window to a grant made before it was recorded, counting from creation', async () => {
      const grant = baseGrant({
        refreshTokenExpiresAt: undefined,
        createdAt: new Date(Date.now() - 91 * DAY_MS),
      })
      vi.spyOn(OauthAccessToken, 'findOne').mockResolvedValue(grant)
      const res = createMockRes()
      await OAuth2TokenController.token(refreshRequest(), res)
      expect(res.statusCode).to.equal(400)
      expect(res.responseData.error_description).to.match(/expired/)
    })

    it('issues only the requested narrower scope on refresh', async () => {
      const grant = baseGrant({ scope: 'mcp offline_access' })
      vi.spyOn(OauthAccessToken, 'findOne').mockResolvedValue(grant)
      vi.spyOn(db.oauthAccessTokens, 'findOneAndUpdate').mockResolvedValue({ _id: grant._id })

      const ok = createMockRes()
      await OAuth2TokenController.token(refreshRequest('oar_old_token', { scope: 'mcp' }), ok)
      expect(ok.statusCode).to.equal(200)
      expect(ok.responseData.scope).to.equal('mcp')
      const payload = await OAuth2KeyManager.verifyJwt(ok.responseData.access_token)
      expect(payload.scope).to.equal('mcp')

      const noScope = createMockRes()
      await OAuth2TokenController.token(refreshRequest(), noScope)
      expect(noScope.statusCode).to.equal(200)
      expect(noScope.responseData.scope).to.equal('mcp offline_access')

      const findOne = OauthAccessToken.findOne
      findOne.mockClear()
      const bad = createMockRes()
      await OAuth2TokenController.token(
        refreshRequest('oar_old_token', { scope: 'mcp admin' }),
        bad
      )
      expect(bad.statusCode).to.equal(400)
      expect(bad.responseData).to.deep.equal({
        error: 'invalid_scope',
        error_description: 'Supported scopes are mcp and optional offline_access',
      })
      expect(findOne.mock.calls).to.have.lengthOf(0)
    })

    it('does not treat an object-valued refresh_token as a query', async () => {
      const findOne = vi.spyOn(OauthAccessToken, 'findOne')
      const res = createMockRes()
      await OAuth2TokenController.token(
        refreshRequest({ $ne: 'x' }),
        res
      )
      expect(res.statusCode).to.equal(400)
      expect(res.responseData.error).to.equal('invalid_request')
      expect(findOne.mock.calls).to.have.lengthOf(0)
    })

    it('rejects a valid scope that exceeds the original grant', async () => {
      vi.spyOn(OauthAccessToken, 'findOne').mockResolvedValue(baseGrant())
      const rotate = vi.spyOn(db.oauthAccessTokens, 'findOneAndUpdate')
      const res = createMockRes()

      await OAuth2TokenController.token(
        refreshRequest('oar_old_token', { scope: 'mcp offline_access' }),
        res
      )

      expect(res.statusCode).to.equal(400)
      expect(res.responseData.error).to.equal('invalid_scope')
      expect(rotate.mock.calls).to.have.lengthOf(0)
    })
  })

  describe('access token validation', () => {
    it('rejects an access token whose exp has passed', async () => {
      const token = await OAuth2KeyManager.signJwt({
        sub: 'user_ttl_1',
        exp: Math.floor(Date.now() / 1000) - 5,
      })
      let err
      try {
        await OAuth2KeyManager.verifyJwt(token)
      } catch (e) {
        err = e
      }
      expect(err.message).to.match(/expired/i)
    })
  })
})
