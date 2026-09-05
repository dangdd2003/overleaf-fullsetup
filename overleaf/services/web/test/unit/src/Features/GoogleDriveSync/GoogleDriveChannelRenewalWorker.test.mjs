import { describe, it, beforeEach, afterEach, vi, expect } from 'vitest'

const modulePath =
  '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveChannelRenewalWorker.mjs'

describe('GoogleDriveChannelRenewalWorker', () => {
  let GoogleDriveChannelRenewalWorker

  const Settings = {
    googleDrive: {
      channelRenewIntervalSeconds: 3600,
      webhookUrl: 'https://example.com/webhook',
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
      find: vi.fn(),
    },
  }

  const GoogleDriveWatchManager = {
    ensureChannel: vi.fn(),
  }

  function mockCursor(docs) {
    return {
      async *[Symbol.asyncIterator]() {
        yield* docs
      },
    }
  }

  vi.doMock('@overleaf/settings', () => ({ default: Settings }))
  vi.doMock('@overleaf/logger', () => ({ default: logger }))
  vi.doMock('../../../../../app/src/infrastructure/Features.mjs', () => ({
    default: Features,
  }))
  vi.doMock('../../../../../app/src/infrastructure/mongodb.mjs', () => ({
    db,
  }))
  vi.doMock(
    '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveWatchManager.mjs',
    () => ({ default: GoogleDriveWatchManager, ...GoogleDriveWatchManager })
  )

  beforeEach(async () => {
    vi.clearAllMocks()
    Features.hasFeature.mockReturnValue(true)
    Settings.googleDrive.webhookUrl = 'https://example.com/webhook'
    Settings.googleDrive.channelRenewIntervalSeconds = 3600

    const mod = await import(modulePath)
    GoogleDriveChannelRenewalWorker = mod.default
    GoogleDriveChannelRenewalWorker.stop()
  })

  afterEach(() => {
    if (GoogleDriveChannelRenewalWorker) {
      GoogleDriveChannelRenewalWorker.stop()
    }
    vi.useRealTimers()
  })

  describe('renewAllChannels', () => {
    it('iterates all linked users and calls ensureChannel', async () => {
      const users = [{ user_id: 'u1' }, { user_id: 'u2' }]
      db.googleDriveUserCredentials.find.mockReturnValue(mockCursor(users))

      await GoogleDriveChannelRenewalWorker.renewAllChannels()

      expect(GoogleDriveWatchManager.ensureChannel).toHaveBeenCalledWith('u1')
      expect(GoogleDriveWatchManager.ensureChannel).toHaveBeenCalledWith('u2')
    })

    it('skips execution if feature disabled', async () => {
      Features.hasFeature.mockReturnValue(false)

      await GoogleDriveChannelRenewalWorker.renewAllChannels()

      expect(db.googleDriveUserCredentials.find).not.toHaveBeenCalled()
    })

    it('skips execution if no webhookUrl is configured', async () => {
      Settings.googleDrive.webhookUrl = ''

      await GoogleDriveChannelRenewalWorker.renewAllChannels()

      expect(db.googleDriveUserCredentials.find).not.toHaveBeenCalled()
    })

    it('continues past individual user renewal failures', async () => {
      const users = [{ user_id: 'u1' }, { user_id: 'u2' }]
      db.googleDriveUserCredentials.find.mockReturnValue(mockCursor(users))
      GoogleDriveWatchManager.ensureChannel
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce({ success: true })

      await GoogleDriveChannelRenewalWorker.renewAllChannels()

      expect(logger.error).toHaveBeenCalled()
      expect(GoogleDriveWatchManager.ensureChannel).toHaveBeenCalledWith('u2')
    })
  })

  describe('start & stop', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      db.googleDriveUserCredentials.find.mockReturnValue(mockCursor([]))
    })

    it('renews on startup and on interval once started', async () => {
      GoogleDriveChannelRenewalWorker.start()
      // Immediate run at start
      expect(db.googleDriveUserCredentials.find).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(3600 * 1000)
      expect(db.googleDriveUserCredentials.find).toHaveBeenCalledTimes(2)
    })

    it('stops renewals after stop is called', async () => {
      GoogleDriveChannelRenewalWorker.start()
      expect(db.googleDriveUserCredentials.find).toHaveBeenCalledTimes(1)

      GoogleDriveChannelRenewalWorker.stop()
      await vi.advanceTimersByTimeAsync(3600 * 1000)
      expect(db.googleDriveUserCredentials.find).toHaveBeenCalledTimes(1)
    })

    it('does not start timer if feature is disabled', async () => {
      Features.hasFeature.mockReturnValue(false)
      GoogleDriveChannelRenewalWorker.start()

      expect(db.googleDriveUserCredentials.find).not.toHaveBeenCalled()
    })

    it('does not start timer if webhookUrl is empty', async () => {
      Settings.googleDrive.webhookUrl = ''
      GoogleDriveChannelRenewalWorker.start()

      expect(db.googleDriveUserCredentials.find).not.toHaveBeenCalled()
    })

    it('does not create duplicate timers if start is called twice', async () => {
      GoogleDriveChannelRenewalWorker.start()
      GoogleDriveChannelRenewalWorker.start()

      expect(db.googleDriveUserCredentials.find).toHaveBeenCalledTimes(1)
    })
  })
})
