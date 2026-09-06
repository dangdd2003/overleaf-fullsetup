import { describe, it, vi, beforeEach } from 'vitest'
import { expect } from 'chai'
import crypto from 'node:crypto'
import OAuth2TokenController from '../../../../../app/src/Features/OAuth2/OAuth2TokenController.mjs'
import OAuth2KeyManager from '../../../../../app/src/Features/OAuth2/OAuth2KeyManager.mjs'
import { OauthAuthorizationCode } from '../../../../../app/src/models/OauthAuthorizationCode.mjs'
import { OauthAccessToken } from '../../../../../app/src/models/OauthAccessToken.mjs'
import Settings from '@overleaf/settings'

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
  beforeEach(() => {
    vi.restoreAllMocks()
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
      expect(deletedQuery).to.deep.equal({ authorizationCode: 'valid_code' })
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
      expect(res.responseData.expires_in).to.equal(3600)
      expect(res.responseData).to.have.property('refresh_token').that.is.a('string').and.match(/^oar_[0-9a-f]{64}$/)
      expect(res.responseData.scope).to.equal('mcp')

      // Verify the minted JWT with OAuth2KeyManager
      const decodedPayload = await OAuth2KeyManager.verifyJwt(res.responseData.access_token)
      expect(decodedPayload.sub).to.equal('user_abc_789')
      expect(decodedPayload.aud).to.equal('http://localhost:3050/mcp')
      expect(decodedPayload.client_id).to.equal('claude')
      expect(decodedPayload.scope).to.equal('mcp')
      expect(decodedPayload).to.have.property('jti').that.match(/^jwt_[0-9a-f]{32}$/)

      // Verify token DB record: only the hash is persisted, never the raw token
      expect(createdTokenDoc).to.exist
      expect(createdTokenDoc.refreshToken).to.equal(
        sha256(res.responseData.refresh_token)
      )
      expect(createdTokenDoc.refreshToken).to.not.equal(
        res.responseData.refresh_token
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

    it('rejects expired refresh token', async () => {
      const mockTokenDoc = {
        refreshToken: sha256('oar_expired'),
        refreshTokenExpiresAt: new Date(Date.now() - 5000),
        user_id: 'user_123',
        scope: 'mcp',
      }
      vi.spyOn(OauthAccessToken, 'findOne').mockResolvedValue(mockTokenDoc)

      const req = {
        body: {
          grant_type: 'refresh_token',
          refresh_token: 'oar_expired',
        },
      }
      const res = createMockRes()

      await OAuth2TokenController.token(req, res)
      expect(res.statusCode).to.equal(400)
      expect(res.responseData).to.deep.equal({
        error: 'invalid_grant',
        error_description: 'Refresh token has expired',
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

    it('performs token rotation: mints new RS256 JWT, rotates refresh token, and updates DB', async () => {
      let saved = false
      const mockTokenDoc = {
        refreshToken: sha256('oar_old_token'),
        refreshTokenExpiresAt: new Date(Date.now() + 86400000),
        user_id: 'user_rotation_123',
        client_id: 'claude',
        audience: 'http://localhost:3050/mcp',
        scope: 'mcp',
        save: async () => {
          saved = true
        },
      }
      vi.spyOn(OauthAccessToken, 'findOne').mockResolvedValue(mockTokenDoc)

      const req = {
        body: {
          grant_type: 'refresh_token',
          refresh_token: 'oar_old_token',
          client_id: 'claude',
          resource: 'http://localhost:3050/mcp',
        },
        get: () => 'localhost:3000',
        protocol: 'http',
      }
      const res = createMockRes()

      await OAuth2TokenController.token(req, res)
      expect(res.statusCode).to.equal(200)
      expect(res.responseData).to.have.property('access_token').that.is.a('string')
      expect(res.responseData).to.have.property('refresh_token').that.is.a('string').and.not.equal('oar_old_token')
      expect(res.responseData.expires_in).to.equal(3600)
      expect(res.responseData.token_type).to.equal('Bearer')

      // Verify new token
      const decodedPayload = await OAuth2KeyManager.verifyJwt(res.responseData.access_token)
      expect(decodedPayload.sub).to.equal('user_rotation_123')
      expect(decodedPayload.aud).to.equal('http://localhost:3050/mcp')
      expect(decodedPayload.client_id).to.equal('claude')

      // Verify token document was rotated and saved: hash only, never the raw value
      expect(saved).to.be.true
      expect(mockTokenDoc.refreshToken).to.equal(
        sha256(res.responseData.refresh_token)
      )
    })
  })
})
