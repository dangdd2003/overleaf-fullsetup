import { describe, it, beforeEach, vi, expect } from 'vitest'

const modulePath =
  '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveOAuthManager.mjs'

describe('GoogleDriveOAuthManager', function () {
  let GoogleDriveOAuthManager

  const userId = '60d5ecb8b392d40015b6d5a1'
  const sessionSecret = 'test-session-secret-at-least-32-chars-long-123456'
  const clientId = 'test-google-client-id.apps.googleusercontent.com'
  const clientSecret = 'test-google-client-secret-xyz'
  const redirectUri = 'https://overleaf.example.com/user/google-drive/callback'

  const Settings = {
    security: {
      sessionSecret,
    },
    googleDrive: {
      clientId,
      clientSecret,
      redirectUri,
      folderName: 'Overleaf',
    },
  }

  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }

  const db = {
    googleDriveUserCredentials: {
      findOne: vi.fn(),
      updateOne: vi.fn(),
      deleteOne: vi.fn(),
    },
  }

  const fetchUtils = {
    fetchJson: vi.fn(),
    fetchNothing: vi.fn(),
  }

  const GoogleDriveWatchManager = {
    ensureChannel: vi.fn(),
    stopChannel: vi.fn(),
  }

  class MockObjectId {
    constructor(id) {
      this.id = id
      this._bsontype = 'ObjectID'
    }
    toString() {
      return this.id.toString()
    }
    static isValid(id) {
      return typeof id === 'string' && id.length === 24
    }
  }

  vi.doMock('@overleaf/settings', () => ({ default: Settings }))
  vi.doMock('@overleaf/logger', () => ({ default: logger }))
  vi.doMock('@overleaf/fetch-utils', () => fetchUtils)
  vi.doMock('../../../../../app/src/infrastructure/mongodb.mjs', () => ({
    db,
    ObjectId: MockObjectId,
  }))
  vi.doMock(
    '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveWatchManager.mjs',
    () => ({
      default: GoogleDriveWatchManager,
      GoogleDriveWatchManager,
    })
  )

  beforeEach(async function () {
    Settings.security = {
      sessionSecret,
    }
    Settings.googleDrive = {
      clientId,
      clientSecret,
      redirectUri,
      folderName: 'Overleaf',
    }

    vi.clearAllMocks()
    db.googleDriveUserCredentials.findOne.mockReset()
    db.googleDriveUserCredentials.updateOne.mockReset()
    db.googleDriveUserCredentials.deleteOne.mockReset()
    fetchUtils.fetchJson.mockReset()
    fetchUtils.fetchNothing.mockReset()
    GoogleDriveWatchManager.ensureChannel.mockReset()
    GoogleDriveWatchManager.stopChannel.mockReset()
    GoogleDriveWatchManager.ensureChannel.mockResolvedValue({ success: true })
    GoogleDriveWatchManager.stopChannel.mockResolvedValue({ success: true })

    GoogleDriveOAuthManager = (await import(modulePath)).default
  })

  describe('Token Encryption & Decryption (AES-256-GCM)', function () {
    it('encrypts and decrypts token successfully with configured sessionSecret', function () {
      const plaintext = 'ya29.a0AfH6SMD_SampleGoogleAccessToken_123456789'
      const encrypted = GoogleDriveOAuthManager.encryptToken(plaintext)

      expect(encrypted).toBeDefined()
      expect(typeof encrypted).toBe('string')
      const parts = encrypted.split(':')
      expect(parts.length).toBe(3) // iv:authTag:ciphertext

      const decrypted = GoogleDriveOAuthManager.decryptToken(encrypted)
      expect(decrypted).toBe(plaintext)
    })

    it('generates different ciphertexts for the same plaintext due to random IV', function () {
      const plaintext = 'refresh_token_secret_value'
      const enc1 = GoogleDriveOAuthManager.encryptToken(plaintext)
      const enc2 = GoogleDriveOAuthManager.encryptToken(plaintext)

      expect(enc1).not.toBe(enc2)
      expect(GoogleDriveOAuthManager.decryptToken(enc1)).toBe(plaintext)
      expect(GoogleDriveOAuthManager.decryptToken(enc2)).toBe(plaintext)
    })

    it('supports custom secret passed explicitly', function () {
      const customSecret = 'another-custom-secret-key-987654321'
      const plaintext = 'custom-secret-token'
      const encrypted = GoogleDriveOAuthManager.encryptToken(
        plaintext,
        customSecret
      )
      const decrypted = GoogleDriveOAuthManager.decryptToken(
        encrypted,
        customSecret
      )
      expect(decrypted).toBe(plaintext)
    })

    it('throws error when decrypting with wrong secret', function () {
      const plaintext = 'super-secret-token'
      const encrypted = GoogleDriveOAuthManager.encryptToken(
        plaintext,
        'secret-one'
      )
      expect(() => {
        GoogleDriveOAuthManager.decryptToken(encrypted, 'secret-two')
      }).toThrow()
    })

    it('throws error on tampered ciphertext or auth tag', function () {
      const plaintext = 'valid-token'
      const encrypted = GoogleDriveOAuthManager.encryptToken(plaintext)
      const parts = encrypted.split(':')
      // Tamper ciphertext
      const tampered = `${parts[0]}:${parts[1]}:ff${parts[2].slice(2)}`
      expect(() => {
        GoogleDriveOAuthManager.decryptToken(tampered)
      }).toThrow()
    })

    it('throws error on malformed encrypted string format', function () {
      expect(() => {
        GoogleDriveOAuthManager.decryptToken('invalid-format-without-colons')
      }).toThrow()
    })

    it('returns null when encrypting or decrypting null/empty value', function () {
      expect(GoogleDriveOAuthManager.encryptToken(null)).toBeNull()
      expect(GoogleDriveOAuthManager.encryptToken('')).toBeNull()
      expect(GoogleDriveOAuthManager.decryptToken(null)).toBeNull()
      expect(GoogleDriveOAuthManager.decryptToken('')).toBeNull()
    })

    it('throws error if sessionSecret is missing from settings and no secret passed', function () {
      Settings.security = {}
      expect(() => {
        GoogleDriveOAuthManager.encryptToken('some-token')
      }).toThrow(/sessionSecret/)
    })
  })

  describe('OAuth State Generation & Validation', function () {
    it('creates a signed state that can be validated for the same userId', function () {
      const state = GoogleDriveOAuthManager.createOAuthState(userId)
      expect(typeof state).toBe('string')
      expect(state).toContain('.')

      const isValid = GoogleDriveOAuthManager.validateOAuthState(userId, state)
      expect(isValid).toBe(true)
    })

    it('fails validation if state userId does not match', function () {
      const state = GoogleDriveOAuthManager.createOAuthState(userId)
      const isValid = GoogleDriveOAuthManager.validateOAuthState(
        'different-user-id',
        state
      )
      expect(isValid).toBe(false)
    })

    it('fails validation if signature is tampered with', function () {
      const state = GoogleDriveOAuthManager.createOAuthState(userId)
      const parts = state.split('.')
      const tamperedState = `${parts[0]}.badsignature`
      const isValid = GoogleDriveOAuthManager.validateOAuthState(
        userId,
        tamperedState
      )
      expect(isValid).toBe(false)
    })

    it('fails validation if state is expired', function () {
      const state = GoogleDriveOAuthManager.createOAuthState(userId)
      // Validate with negative maxAge to simulate expiration
      const isValid = GoogleDriveOAuthManager.validateOAuthState(
        userId,
        state,
        -1000
      )
      expect(isValid).toBe(false)
    })

    it('fails validation when sessionSecret is missing', function () {
      const state = GoogleDriveOAuthManager.createOAuthState(userId)
      Settings.security = {}
      const isValid = GoogleDriveOAuthManager.validateOAuthState(userId, state)
      expect(isValid).toBe(false)
    })
  })

  describe('getAuthorizationUrl', function () {
    it('returns authorization URL and state with correct scopes and parameters', function () {
      const result = GoogleDriveOAuthManager.getAuthorizationUrl(userId)

      expect(result).toHaveProperty('url')
      expect(result).toHaveProperty('state')

      const parsedUrl = new URL(result.url)
      expect(parsedUrl.origin + parsedUrl.pathname).toBe(
        'https://accounts.google.com/o/oauth2/v2/auth'
      )
      expect(parsedUrl.searchParams.get('client_id')).toBe(clientId)
      expect(parsedUrl.searchParams.get('redirect_uri')).toBe(redirectUri)
      expect(parsedUrl.searchParams.get('response_type')).toBe('code')
      expect(parsedUrl.searchParams.get('access_type')).toBe('offline')
      expect(parsedUrl.searchParams.get('prompt')).toBe('consent')
      expect(parsedUrl.searchParams.get('state')).toBe(result.state)

      const scope = parsedUrl.searchParams.get('scope')
      expect(scope).toContain('https://www.googleapis.com/auth/drive')
      expect(scope).toContain('https://www.googleapis.com/auth/userinfo.email')
    })

    it('throws error if clientId is not configured', function () {
      Settings.googleDrive.clientId = ''
      expect(() => {
        GoogleDriveOAuthManager.getAuthorizationUrl(userId)
      }).toThrow(/clientId/)
    })
  })

  describe('handleOAuthCallback', function () {
    it('validates state, exchanges code for tokens, encrypts, and saves to DB', async function () {
      const state = GoogleDriveOAuthManager.createOAuthState(userId)
      const code = 'auth-code-12345'
      const mockAccessToken = 'mock-access-token-abc'
      const mockRefreshToken = 'mock-refresh-token-xyz'
      const googleEmail = 'author@example.com'
      const googleUserId = 'google-user-id-999'

      fetchUtils.fetchJson.mockImplementation(async (url, opts) => {
        if (url === 'https://oauth2.googleapis.com/token') {
          return {
            access_token: mockAccessToken,
            refresh_token: mockRefreshToken,
            expires_in: 3600,
            token_type: 'Bearer',
          }
        }
        if (url === 'https://www.googleapis.com/oauth2/v2/userinfo') {
          return {
            id: googleUserId,
            email: googleEmail,
            verified_email: true,
          }
        }
        throw new Error(`Unexpected url: ${url}`)
      })

      db.googleDriveUserCredentials.findOne.mockResolvedValue(null)
      db.googleDriveUserCredentials.updateOne.mockResolvedValue({
        acknowledged: true,
      })

      const result = await GoogleDriveOAuthManager.handleOAuthCallback(
        userId,
        code,
        state
      )

      expect(result).toEqual({
        googleEmail,
        googleUserId,
      })

      // Verify token exchange call
      expect(fetchUtils.fetchJson).toHaveBeenCalledTimes(2)
      const tokenCallArgs = fetchUtils.fetchJson.mock.calls[0]
      expect(tokenCallArgs[0]).toBe('https://oauth2.googleapis.com/token')
      expect(tokenCallArgs[1].method).toBe('POST')
      expect(tokenCallArgs[1].body).toContain(`code=${code}`)
      expect(tokenCallArgs[1].body).toContain('grant_type=authorization_code')

      // Verify user info call
      const userInfoCallArgs = fetchUtils.fetchJson.mock.calls[1]
      expect(userInfoCallArgs[0]).toBe(
        'https://www.googleapis.com/oauth2/v2/userinfo'
      )
      expect(userInfoCallArgs[1].headers.Authorization).toBe(
        `Bearer ${mockAccessToken}`
      )

      // Verify DB update
      expect(db.googleDriveUserCredentials.updateOne).toHaveBeenCalledTimes(1)
      const [query, update, opts] =
        db.googleDriveUserCredentials.updateOne.mock.calls[0]
      expect(query.user_id.toString()).toBe(userId)
      expect(opts.upsert).toBe(true)
      expect(update.$set.googleEmail).toBe(googleEmail)
      expect(update.$set.googleUserId).toBe(googleUserId)
      expect(update.$set.encryptedAccessToken).toBeDefined()
      expect(update.$set.encryptedRefreshToken).toBeDefined()

      // Verify encrypted tokens decrypt properly
      const decryptedAccess = GoogleDriveOAuthManager.decryptToken(
        update.$set.encryptedAccessToken
      )
      const decryptedRefresh = GoogleDriveOAuthManager.decryptToken(
        update.$set.encryptedRefreshToken
      )
      expect(decryptedAccess).toBe(mockAccessToken)
      expect(decryptedRefresh).toBe(mockRefreshToken)

      // Verify ensureChannel was called for push notifications
      expect(GoogleDriveWatchManager.ensureChannel).toHaveBeenCalledTimes(1)
      expect(GoogleDriveWatchManager.ensureChannel).toHaveBeenCalledWith(userId)
    })

    it('completes link successfully even if GoogleDriveWatchManager.ensureChannel fails (best-effort)', async function () {
      const state = GoogleDriveOAuthManager.createOAuthState(userId)
      const code = 'auth-code-chan-fail'
      const mockAccessToken = 'mock-access-token-abc'
      const mockRefreshToken = 'mock-refresh-token-xyz'
      const googleEmail = 'author@example.com'
      const googleUserId = 'google-user-id-999'

      fetchUtils.fetchJson.mockImplementation(async (url, opts) => {
        if (url === 'https://oauth2.googleapis.com/token') {
          return {
            access_token: mockAccessToken,
            refresh_token: mockRefreshToken,
            expires_in: 3600,
            token_type: 'Bearer',
          }
        }
        if (url === 'https://www.googleapis.com/oauth2/v2/userinfo') {
          return {
            id: googleUserId,
            email: googleEmail,
            verified_email: true,
          }
        }
        throw new Error(`Unexpected url: ${url}`)
      })

      db.googleDriveUserCredentials.findOne.mockResolvedValue(null)
      db.googleDriveUserCredentials.updateOne.mockResolvedValue({
        acknowledged: true,
      })
      GoogleDriveWatchManager.ensureChannel.mockRejectedValue(
        new Error('Drive watch error')
      )

      const result = await GoogleDriveOAuthManager.handleOAuthCallback(
        userId,
        code,
        state
      )

      expect(result).toEqual({
        googleEmail,
        googleUserId,
      })
      expect(GoogleDriveWatchManager.ensureChannel).toHaveBeenCalledWith(userId)
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ userId }),
        'failed to establish initial push notification channel during link'
      )
    })

    it('preserves existing refresh token if Google does not return a new refresh token', async function () {
      const state = GoogleDriveOAuthManager.createOAuthState(userId)
      const code = 'auth-code-no-refresh'
      const existingRefreshToken = 'existing-refresh-token-123'
      const encryptedExistingRefresh =
        GoogleDriveOAuthManager.encryptToken(existingRefreshToken)

      fetchUtils.fetchJson.mockImplementation(async (url, opts) => {
        if (url === 'https://oauth2.googleapis.com/token') {
          return {
            access_token: 'new-access-token',
            expires_in: 3600,
          }
        }
        if (url === 'https://www.googleapis.com/oauth2/v2/userinfo') {
          return {
            id: 'google-user-id-999',
            email: 'author@example.com',
          }
        }
        throw new Error(`Unexpected url: ${url}`)
      })

      db.googleDriveUserCredentials.findOne.mockResolvedValue({
        user_id: userId,
        encryptedRefreshToken: encryptedExistingRefresh,
      })
      db.googleDriveUserCredentials.updateOne.mockResolvedValue({
        acknowledged: true,
      })

      await GoogleDriveOAuthManager.handleOAuthCallback(userId, code, state)

      const update = db.googleDriveUserCredentials.updateOne.mock.calls[0][1]
      expect(update.$set.encryptedRefreshToken).toBe(encryptedExistingRefresh)
    })

    it('rejects with error if state is invalid', async function () {
      let error
      try {
        await GoogleDriveOAuthManager.handleOAuthCallback(
          userId,
          'code-123',
          'invalid-state'
        )
      } catch (err) {
        error = err
      }
      expect(error).toBeDefined()
      expect(error.message).toMatch(/state/i)
    })

    it('rejects with error if code is missing', async function () {
      const state = GoogleDriveOAuthManager.createOAuthState(userId)
      let error
      try {
        await GoogleDriveOAuthManager.handleOAuthCallback(userId, null, state)
      } catch (err) {
        error = err
      }
      expect(error).toBeDefined()
      expect(error.message).toMatch(/code/i)
    })
  })

  describe('getValidAccessToken', function () {
    it('returns decrypted access token directly if token is valid and not expiring soon', async function () {
      const validAccessToken = 'ya29.valid-access-token-123'
      const encryptedAccessToken =
        GoogleDriveOAuthManager.encryptToken(validAccessToken)
      const tokenExpiry = new Date(Date.now() + 30 * 60 * 1000) // 30 minutes in future

      db.googleDriveUserCredentials.findOne.mockResolvedValue({
        user_id: userId,
        encryptedAccessToken,
        tokenExpiry,
      })

      const token = await GoogleDriveOAuthManager.getValidAccessToken(userId)

      expect(token).toBe(validAccessToken)
      expect(fetchUtils.fetchJson).not.toHaveBeenCalled()
      expect(db.googleDriveUserCredentials.updateOne).not.toHaveBeenCalled()
    })

    it('refreshes token automatically when tokenExpiry is within 5 minutes', async function () {
      const oldAccessToken = 'ya29.old-access-token'
      const refreshToken = '1//refresh-token-xyz'
      const newAccessToken = 'ya29.new-refreshed-access-token-456'
      const encryptedAccessToken =
        GoogleDriveOAuthManager.encryptToken(oldAccessToken)
      const encryptedRefreshToken =
        GoogleDriveOAuthManager.encryptToken(refreshToken)
      const tokenExpiry = new Date(Date.now() + 2 * 60 * 1000) // 2 minutes (within 5 min buffer)

      db.googleDriveUserCredentials.findOne.mockResolvedValue({
        user_id: userId,
        encryptedAccessToken,
        encryptedRefreshToken,
        tokenExpiry,
      })

      fetchUtils.fetchJson.mockResolvedValue({
        access_token: newAccessToken,
        expires_in: 3600,
      })

      db.googleDriveUserCredentials.updateOne.mockResolvedValue({
        acknowledged: true,
      })

      const token = await GoogleDriveOAuthManager.getValidAccessToken(userId)

      expect(token).toBe(newAccessToken)
      expect(fetchUtils.fetchJson).toHaveBeenCalledTimes(1)

      const refreshArgs = fetchUtils.fetchJson.mock.calls[0]
      expect(refreshArgs[0]).toBe('https://oauth2.googleapis.com/token')
      expect(refreshArgs[1].body).toContain('grant_type=refresh_token')
      expect(refreshArgs[1].body).toContain(
        `refresh_token=${encodeURIComponent(refreshToken)}`
      )

      expect(db.googleDriveUserCredentials.updateOne).toHaveBeenCalledTimes(1)
      const update = db.googleDriveUserCredentials.updateOne.mock.calls[0][1]
      const decryptedNew = GoogleDriveOAuthManager.decryptToken(
        update.$set.encryptedAccessToken
      )
      expect(decryptedNew).toBe(newAccessToken)
    })

    it('refreshes token automatically when token is expired (past expiry)', async function () {
      const refreshToken = '1//refresh-token-xyz'
      const newAccessToken = 'ya29.fresh-token'
      const encryptedRefreshToken =
        GoogleDriveOAuthManager.encryptToken(refreshToken)
      const tokenExpiry = new Date(Date.now() - 10 * 60 * 1000) // 10 minutes in the past

      db.googleDriveUserCredentials.findOne.mockResolvedValue({
        user_id: userId,
        encryptedAccessToken: 'expired-enc-token',
        encryptedRefreshToken,
        tokenExpiry,
      })

      fetchUtils.fetchJson.mockResolvedValue({
        access_token: newAccessToken,
        expires_in: 3600,
      })
      db.googleDriveUserCredentials.updateOne.mockResolvedValue({
        acknowledged: true,
      })

      const token = await GoogleDriveOAuthManager.getValidAccessToken(userId)
      expect(token).toBe(newAccessToken)
    })

    it('throws error if user has no Google Drive credentials', async function () {
      db.googleDriveUserCredentials.findOne.mockResolvedValue(null)
      let error
      try {
        await GoogleDriveOAuthManager.getValidAccessToken(userId)
      } catch (err) {
        error = err
      }
      expect(error).toBeDefined()
      expect(error.message).toMatch(/not linked/i)
    })

    it('throws error if token is expired and no refresh token is present', async function () {
      db.googleDriveUserCredentials.findOne.mockResolvedValue({
        user_id: userId,
        encryptedAccessToken: 'token-without-refresh',
        tokenExpiry: new Date(Date.now() - 1000),
        encryptedRefreshToken: null,
      })

      let error
      try {
        await GoogleDriveOAuthManager.getValidAccessToken(userId)
      } catch (err) {
        error = err
      }
      expect(error).toBeDefined()
      expect(error.message).toMatch(/refresh token/i)
    })
  })

  describe('unlinkAccount', function () {
    it('revokes token and deletes credentials from database and stops watch channel', async function () {
      const accessToken = 'ya29.token-to-revoke'
      const encryptedAccessToken =
        GoogleDriveOAuthManager.encryptToken(accessToken)

      db.googleDriveUserCredentials.findOne.mockResolvedValue({
        user_id: userId,
        encryptedAccessToken,
      })
      fetchUtils.fetchNothing.mockResolvedValue({})
      db.googleDriveUserCredentials.deleteOne.mockResolvedValue({
        deletedCount: 1,
      })

      const result = await GoogleDriveOAuthManager.unlinkAccount(userId)

      expect(result).toEqual({ success: true })
      expect(fetchUtils.fetchNothing).toHaveBeenCalledTimes(1)
      const revokeUrl = fetchUtils.fetchNothing.mock.calls[0][0]
      expect(revokeUrl).toContain('https://oauth2.googleapis.com/revoke')
      expect(revokeUrl).toContain(`token=${encodeURIComponent(accessToken)}`)

      expect(GoogleDriveWatchManager.stopChannel).toHaveBeenCalledTimes(1)
      expect(GoogleDriveWatchManager.stopChannel).toHaveBeenCalledWith(userId)

      expect(db.googleDriveUserCredentials.deleteOne).toHaveBeenCalledTimes(1)
      const deleteQuery =
        db.googleDriveUserCredentials.deleteOne.mock.calls[0][0]
      expect(deleteQuery.user_id.toString()).toBe(userId)
    })

    it('completes unlink even if GoogleDriveWatchManager.stopChannel fails', async function () {
      const accessToken = 'ya29.token-to-revoke'
      const encryptedAccessToken =
        GoogleDriveOAuthManager.encryptToken(accessToken)

      db.googleDriveUserCredentials.findOne.mockResolvedValue({
        user_id: userId,
        encryptedAccessToken,
      })
      fetchUtils.fetchNothing.mockResolvedValue({})
      db.googleDriveUserCredentials.deleteOne.mockResolvedValue({
        deletedCount: 1,
      })
      GoogleDriveWatchManager.stopChannel.mockRejectedValue(
        new Error('Stop channel failure')
      )

      const result = await GoogleDriveOAuthManager.unlinkAccount(userId)

      expect(result).toEqual({ success: true })
      expect(GoogleDriveWatchManager.stopChannel).toHaveBeenCalledWith(userId)
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ userId }),
        'failed to stop push notification channel during unlink'
      )
      expect(db.googleDriveUserCredentials.deleteOne).toHaveBeenCalledTimes(1)
    })

    it('completes database deletion even if token revocation call fails', async function () {
      const accessToken = 'ya29.token-revoke-fail'
      const encryptedAccessToken =
        GoogleDriveOAuthManager.encryptToken(accessToken)

      db.googleDriveUserCredentials.findOne.mockResolvedValue({
        user_id: userId,
        encryptedAccessToken,
      })
      fetchUtils.fetchNothing.mockRejectedValue(
        new Error('Network error on revoke')
      )
      db.googleDriveUserCredentials.deleteOne.mockResolvedValue({
        deletedCount: 1,
      })

      const result = await GoogleDriveOAuthManager.unlinkAccount(userId)

      expect(result).toEqual({ success: true })
      expect(db.googleDriveUserCredentials.deleteOne).toHaveBeenCalledTimes(1)
    })

    it('succeeds gracefully if account was not linked', async function () {
      db.googleDriveUserCredentials.findOne.mockResolvedValue(null)
      db.googleDriveUserCredentials.deleteOne.mockResolvedValue({
        deletedCount: 0,
      })

      const result = await GoogleDriveOAuthManager.unlinkAccount(userId)

      expect(result).toEqual({ success: true })
      expect(fetchUtils.fetchNothing).not.toHaveBeenCalled()
      expect(db.googleDriveUserCredentials.deleteOne).toHaveBeenCalledTimes(1)
    })
  })

  describe('isLinked', function () {
    it('returns isLinked: true with email and linkedAt when user has credentials', async function () {
      const linkedAt = new Date('2026-08-30T10:00:00Z')
      db.googleDriveUserCredentials.findOne.mockResolvedValue({
        user_id: userId,
        googleEmail: 'user@example.com',
        googleUserId: 'google-uid-123',
        encryptedAccessToken: 'some-enc-token',
        linkedAt,
      })

      const status = await GoogleDriveOAuthManager.isLinked(userId)

      expect(status).toEqual({
        isLinked: true,
        googleEmail: 'user@example.com',
        googleUserId: 'google-uid-123',
        linkedAt,
      })
    })

    it('returns isLinked: false when user has no credentials in DB', async function () {
      db.googleDriveUserCredentials.findOne.mockResolvedValue(null)

      const status = await GoogleDriveOAuthManager.isLinked(userId)

      expect(status).toEqual({
        isLinked: false,
      })
    })

    it('returns isLinked: false when credentials exist but encryptedAccessToken is missing', async function () {
      db.googleDriveUserCredentials.findOne.mockResolvedValue({
        user_id: userId,
        encryptedAccessToken: null,
      })

      const status = await GoogleDriveOAuthManager.isLinked(userId)

      expect(status).toEqual({
        isLinked: false,
      })
    })

    it('works correctly when userId is passed as MockObjectId instance', async function () {
      const objId = new MockObjectId(userId)
      const linkedAt = new Date('2026-08-30T10:00:00Z')
      db.googleDriveUserCredentials.findOne.mockResolvedValue({
        user_id: objId,
        googleEmail: 'user@example.com',
        googleUserId: 'google-uid-123',
        encryptedAccessToken: 'some-enc-token',
        linkedAt,
      })

      const status = await GoogleDriveOAuthManager.isLinked(objId)

      expect(status).toEqual({
        isLinked: true,
        googleEmail: 'user@example.com',
        googleUserId: 'google-uid-123',
        linkedAt,
      })
    })
  })

  describe('Additional Edge Cases', function () {
    it('encrypts and decrypts complex unicode, JSON strings, and long tokens', function () {
      const complexString = JSON.stringify({
        sub: '1234567890',
        name: 'Đặng Đình Đô',
        special: '🔑 🔐 🛡️ 🚀 \n \t \r \\ " \' !@#$%^&*()_+',
        nested: { array: [1, 2, 3, 'hello'], bool: true },
      })
      const encrypted = GoogleDriveOAuthManager.encryptToken(complexString)
      const decrypted = GoogleDriveOAuthManager.decryptToken(encrypted)
      expect(decrypted).toBe(complexString)
    })

    it('updates encryptedRefreshToken if refresh_token endpoint returns a new refresh token during refresh', async function () {
      const oldRefreshToken = 'old-refresh-token'
      const newRefreshToken = 'new-refresh-token-from-google'
      const newAccessToken = 'new-access-token'
      const encryptedOldRefresh =
        GoogleDriveOAuthManager.encryptToken(oldRefreshToken)

      db.googleDriveUserCredentials.findOne.mockResolvedValue({
        user_id: userId,
        encryptedAccessToken: 'expired-access-token',
        encryptedRefreshToken: encryptedOldRefresh,
        tokenExpiry: new Date(Date.now() - 10000),
      })

      fetchUtils.fetchJson.mockResolvedValue({
        access_token: newAccessToken,
        refresh_token: newRefreshToken,
        expires_in: 7200,
      })
      db.googleDriveUserCredentials.updateOne.mockResolvedValue({
        acknowledged: true,
      })

      const token = await GoogleDriveOAuthManager.getValidAccessToken(userId)

      expect(token).toBe(newAccessToken)
      const update = db.googleDriveUserCredentials.updateOne.mock.calls[0][1]
      expect(update.$set.encryptedRefreshToken).toBeDefined()
      const decryptedNewRefresh = GoogleDriveOAuthManager.decryptToken(
        update.$set.encryptedRefreshToken
      )
      expect(decryptedNewRefresh).toBe(newRefreshToken)
    })

    it('unlinks account revoking refreshToken if accessToken is missing', async function () {
      const refreshToken = '1//refresh-token-alone'
      const encryptedRefreshToken =
        GoogleDriveOAuthManager.encryptToken(refreshToken)

      db.googleDriveUserCredentials.findOne.mockResolvedValue({
        user_id: userId,
        encryptedAccessToken: null,
        encryptedRefreshToken,
      })
      fetchUtils.fetchNothing.mockResolvedValue({})
      db.googleDriveUserCredentials.deleteOne.mockResolvedValue({
        deletedCount: 1,
      })

      const result = await GoogleDriveOAuthManager.unlinkAccount(userId)

      expect(result).toEqual({ success: true })
      expect(fetchUtils.fetchNothing).toHaveBeenCalledTimes(1)
      const revokeUrl = fetchUtils.fetchNothing.mock.calls[0][0]
      expect(revokeUrl).toContain(`token=${encodeURIComponent(refreshToken)}`)
      expect(db.googleDriveUserCredentials.deleteOne).toHaveBeenCalledTimes(1)
    })

    it('handles network error during token exchange in handleOAuthCallback', async function () {
      const state = GoogleDriveOAuthManager.createOAuthState(userId)
      const code = 'code-network-fail'

      fetchUtils.fetchJson.mockRejectedValue(
        new Error('Network error calling Google token endpoint')
      )

      let error
      try {
        await GoogleDriveOAuthManager.handleOAuthCallback(userId, code, state)
      } catch (err) {
        error = err
      }
      expect(error).toBeDefined()
      expect(error.message).toMatch(
        /Network error calling Google token endpoint/i
      )
    })
  })
})
