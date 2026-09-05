import { describe, it, beforeEach, vi, expect } from 'vitest'

const modulePath =
  '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveWatchManager.mjs'

describe('GoogleDriveWatchManager', () => {
  let GoogleDriveWatchManager

  const userId = '60d5ecb8b392d40015b6d5a1'

  const Settings = {
    encryption: {
      userOAuthTokensSecret: 'default-secret-key-for-test-only',
    },
    googleDrive: {
      webhookUrl: 'https://overleaf.example.com/google-drive/webhook',
      webhookSecret: '',
    },
  }

  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }

  const Features = { hasFeature: vi.fn() }

  const db = {
    googleDriveUserCredentials: {
      findOne: vi.fn(),
      updateOne: vi.fn(),
    },
  }

  const GoogleDriveClient = {
    getStartPageToken: vi.fn(),
    watchChanges: vi.fn(),
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
  vi.doMock('../../../../../app/src/infrastructure/Features.mjs', () => ({
    default: Features,
  }))
  vi.doMock('../../../../../app/src/infrastructure/mongodb.mjs', () => ({
    db,
    ObjectId: MockObjectId,
  }))
  vi.doMock(
    '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveClient.mjs',
    () => ({ default: GoogleDriveClient, ...GoogleDriveClient })
  )

  beforeEach(async () => {
    vi.clearAllMocks()
    Features.hasFeature.mockReturnValue(true)
    Settings.googleDrive.webhookUrl =
      'https://overleaf.example.com/google-drive/webhook'
    Settings.googleDrive.webhookSecret = 'test-secret'

    const mod = await import(modulePath)
    GoogleDriveWatchManager = mod.default
  })

  describe('deriveChannelToken', () => {
    it('returns a deterministic HMAC token for a user', () => {
      const token1 = GoogleDriveWatchManager.deriveChannelToken(userId)
      const token2 = GoogleDriveWatchManager.deriveChannelToken(userId)
      expect(token1).toBe(token2)
      expect(typeof token1).toBe('string')
      expect(token1.length).toBeGreaterThan(16)
    })

    it('returns distinct tokens for different users', () => {
      const token1 = GoogleDriveWatchManager.deriveChannelToken(userId)
      const token2 = GoogleDriveWatchManager.deriveChannelToken(
        '60d5ecb8b392d40015b6d5a2'
      )
      expect(token1).not.toBe(token2)
    })
  })

  describe('ensureChannel', () => {
    it('skips channel creation if webhookUrl is empty', async () => {
      Settings.googleDrive.webhookUrl = ''
      const res = await GoogleDriveWatchManager.ensureChannel(userId)
      expect(res).toEqual({ skipped: 'no-webhook-url' })
      expect(GoogleDriveClient.watchChanges).not.toHaveBeenCalled()
    })

    it('skips channel creation if user credentials not found', async () => {
      db.googleDriveUserCredentials.findOne.mockResolvedValue(null)
      const res = await GoogleDriveWatchManager.ensureChannel(userId)
      expect(res).toEqual({ skipped: 'unlinked' })
    })

    it('reuses active channel if expiration is > 24 hours in the future', async () => {
      const futureDate = new Date(Date.now() + 48 * 60 * 60 * 1000)
      db.googleDriveUserCredentials.findOne.mockResolvedValue({
        user_id: userId,
        watchChannelId: 'existing-chan-id',
        watchExpiresAt: futureDate,
      })

      const res = await GoogleDriveWatchManager.ensureChannel(userId)
      expect(res).toEqual({ reused: true })
      expect(GoogleDriveClient.watchChanges).not.toHaveBeenCalled()
    })

    it('creates a new channel and persists credentials when no active channel exists', async () => {
      db.googleDriveUserCredentials.findOne.mockResolvedValue({
        user_id: userId,
        startPageToken: 'start-page-123',
      })
      GoogleDriveClient.watchChanges.mockResolvedValue({
        id: 'new-chan-id',
        resourceId: 'res-id-999',
        expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000),
      })

      const res = await GoogleDriveWatchManager.ensureChannel(userId)

      expect(GoogleDriveClient.watchChanges).toHaveBeenCalledWith(
        userId,
        'start-page-123',
        expect.objectContaining({
          type: 'web_hook',
          address: 'https://overleaf.example.com/google-drive/webhook',
          token: expect.any(String),
        })
      )
      expect(db.googleDriveUserCredentials.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: expect.anything() }),
        expect.objectContaining({
          $set: expect.objectContaining({
            watchResourceId: 'res-id-999',
            watchExpiresAt: expect.any(Date),
          }),
        })
      )
      expect(res.success).toBe(true)
    })

    it('stops old channel before creating a new one when replacing an expired channel', async () => {
      const pastDate = new Date(Date.now() - 1000)
      db.googleDriveUserCredentials.findOne.mockResolvedValue({
        user_id: userId,
        startPageToken: 'start-page-123',
        watchChannelId: 'old-chan-id',
        watchResourceId: 'old-res-id',
        watchExpiresAt: pastDate,
      })
      GoogleDriveClient.watchChanges.mockResolvedValue({
        id: 'new-chan-id',
        resourceId: 'new-res-id',
        expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000),
      })

      await GoogleDriveWatchManager.ensureChannel(userId)

      expect(GoogleDriveClient.stopChannel).toHaveBeenCalledWith(
        userId,
        'old-chan-id',
        'old-res-id'
      )
      expect(GoogleDriveClient.watchChanges).toHaveBeenCalled()
    })
  })

  describe('stopChannel', () => {
    it('stops active channel and clears watch fields from database', async () => {
      db.googleDriveUserCredentials.findOne.mockResolvedValue({
        user_id: userId,
        watchChannelId: 'chan-to-stop',
        watchResourceId: 'res-to-stop',
      })

      const res = await GoogleDriveWatchManager.stopChannel(userId)

      expect(GoogleDriveClient.stopChannel).toHaveBeenCalledWith(
        userId,
        'chan-to-stop',
        'res-to-stop'
      )
      expect(db.googleDriveUserCredentials.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: expect.anything() }),
        expect.objectContaining({
          $unset: {
            watchChannelId: '',
            watchResourceId: '',
            watchChannelToken: '',
            watchExpiresAt: '',
          },
        })
      )
      expect(res).toEqual({ success: true })
    })

    it('skips stop if no active channel exists', async () => {
      db.googleDriveUserCredentials.findOne.mockResolvedValue({
        user_id: userId,
      })

      const res = await GoogleDriveWatchManager.stopChannel(userId)

      expect(GoogleDriveClient.stopChannel).not.toHaveBeenCalled()
      expect(res).toEqual({ skipped: 'no-active-channel' })
    })
  })
})
