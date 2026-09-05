import { describe, it, beforeEach, vi, expect } from 'vitest'

const modulePath =
  '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveWebhookController.mjs'

describe('GoogleDriveWebhookController', () => {
  let GoogleDriveWebhookController

  const userId = '60d5ecb8b392d40015b6d5a1'

  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }

  const db = {
    googleDriveUserCredentials: {
      findOne: vi.fn(),
    },
  }

  const GoogleDriveSyncManager = {
    pollUserChanges: vi.fn(),
  }

  vi.doMock('@overleaf/logger', () => ({ default: logger }))
  vi.doMock('../../../../../app/src/infrastructure/mongodb.mjs', () => ({
    db,
  }))
  vi.doMock(
    '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveSyncManager.mjs',
    () => ({ default: GoogleDriveSyncManager, ...GoogleDriveSyncManager })
  )

  let req, res

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.useRealTimers()

    req = {
      headers: {
        'x-goog-channel-id': 'chan-123',
        'x-goog-channel-token': 'valid-token-secret-123',
        'x-goog-resource-state': 'change',
      },
    }

    res = {
      sendStatus: vi.fn().mockReturnThis(),
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    }

    const mod = await import(modulePath)
    GoogleDriveWebhookController = mod.default
  })

  it('responds 200 and ignores if channel id is missing', async () => {
    req.headers['x-goog-channel-id'] = undefined

    await GoogleDriveWebhookController.handleWebhook(req, res)

    expect(res.sendStatus).toHaveBeenCalledWith(200)
    expect(GoogleDriveSyncManager.pollUserChanges).not.toHaveBeenCalled()
  })

  it('responds 200 and drops if credentials not found for channel id', async () => {
    db.googleDriveUserCredentials.findOne.mockResolvedValue(null)

    await GoogleDriveWebhookController.handleWebhook(req, res)

    expect(res.sendStatus).toHaveBeenCalledWith(200)
    expect(GoogleDriveSyncManager.pollUserChanges).not.toHaveBeenCalled()
  })

  it('responds 200 and drops if token signature mismatch', async () => {
    db.googleDriveUserCredentials.findOne.mockResolvedValue({
      user_id: userId,
      watchChannelToken: 'different-token',
    })

    await GoogleDriveWebhookController.handleWebhook(req, res)

    expect(res.sendStatus).toHaveBeenCalledWith(200)
    expect(logger.warn).toHaveBeenCalled()
    expect(GoogleDriveSyncManager.pollUserChanges).not.toHaveBeenCalled()
  })

  it('responds 200 immediately on sync handshake ping without polling', async () => {
    req.headers['x-goog-resource-state'] = 'sync'
    db.googleDriveUserCredentials.findOne.mockResolvedValue({
      user_id: userId,
      watchChannelToken: 'valid-token-secret-123',
    })

    await GoogleDriveWebhookController.handleWebhook(req, res)

    expect(res.sendStatus).toHaveBeenCalledWith(200)
    expect(GoogleDriveSyncManager.pollUserChanges).not.toHaveBeenCalled()
  })

  it('responds 200 immediately and schedules debounced poll on valid change event', async () => {
    db.googleDriveUserCredentials.findOne.mockResolvedValue({
      user_id: userId,
      watchChannelToken: 'valid-token-secret-123',
    })

    await GoogleDriveWebhookController.handleWebhook(req, res)

    expect(res.sendStatus).toHaveBeenCalledWith(200)
    // Fast response before poll finishes
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(GoogleDriveSyncManager.pollUserChanges).toHaveBeenCalledWith(userId)
  })
})
