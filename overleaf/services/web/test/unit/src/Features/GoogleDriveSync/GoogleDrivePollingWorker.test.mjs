import { describe, it, beforeEach, afterEach, vi, expect } from 'vitest'

const modulePath =
  '../../../../../app/src/Features/GoogleDriveSync/GoogleDrivePollingWorker.mjs'

describe('GoogleDrivePollingWorker', () => {
  let GoogleDrivePollingWorker

  const Settings = {
    enableGoogleDriveSync: true,
    googleDrive: {
      pollIntervalSeconds: 60,
      watchedUserPollRatio: 10,
    },
  }

  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }

  const Features = {
    hasFeature: vi.fn(),
  }

  const db = {
    googleDriveUserCredentials: {
      find: vi.fn(),
    },
  }

  const GoogleDriveSyncManager = {
    pollUserChanges: vi.fn(),
  }

  // db.googleDriveUserCredentials.find() returns a driver cursor, which the
  // worker consumes with `for await`.
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
    '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveSyncManager.mjs',
    () => ({
      default: GoogleDriveSyncManager,
      ...GoogleDriveSyncManager,
    })
  )

  beforeEach(async () => {
    vi.clearAllMocks()
    Settings.enableGoogleDriveSync = true
    Settings.googleDrive.watchedUserPollRatio = 10
    Features.hasFeature.mockReturnValue(true)

    const mod = await import(modulePath)
    GoogleDrivePollingWorker = mod.default || mod.GoogleDrivePollingWorker
    GoogleDrivePollingWorker.stop()
  })

  afterEach(() => {
    if (GoogleDrivePollingWorker) {
      GoogleDrivePollingWorker.stop()
    }
    vi.useRealTimers()
  })

  describe('start & stop', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      db.googleDriveUserCredentials.find.mockReturnValue(mockCursor([]))
    })

    it('polls on the configured interval once started', async () => {
      GoogleDrivePollingWorker.start()
      await vi.advanceTimersByTimeAsync(60 * 1000)

      expect(db.googleDriveUserCredentials.find).toHaveBeenCalledTimes(1)
    })

    it('stops polling after stop', async () => {
      GoogleDrivePollingWorker.start()
      GoogleDrivePollingWorker.stop()
      await vi.advanceTimersByTimeAsync(60 * 1000)

      expect(db.googleDriveUserCredentials.find).not.toHaveBeenCalled()
    })

    it('does not start timer if feature is disabled', async () => {
      Features.hasFeature.mockReturnValue(false)
      GoogleDrivePollingWorker.start()
      await vi.advanceTimersByTimeAsync(60 * 1000)

      expect(db.googleDriveUserCredentials.find).not.toHaveBeenCalled()
    })

    it('does not create duplicate timers if start is called twice', async () => {
      GoogleDrivePollingWorker.start()
      GoogleDrivePollingWorker.start()
      await vi.advanceTimersByTimeAsync(60 * 1000)

      expect(db.googleDriveUserCredentials.find).toHaveBeenCalledTimes(1)
    })
  })

  describe('pollAllUsers', () => {
    it('queries googleDriveUserCredentials and polls changes for unwatched users', async () => {
      db.googleDriveUserCredentials.find.mockReturnValue(
        mockCursor([{ user_id: 'user-1' }, { user_id: 'user-2' }])
      )
      GoogleDriveSyncManager.pollUserChanges.mockResolvedValue({})

      await GoogleDrivePollingWorker.pollAllUsers()

      expect(GoogleDriveSyncManager.pollUserChanges).toHaveBeenCalledWith(
        'user-1'
      )
      expect(GoogleDriveSyncManager.pollUserChanges).toHaveBeenCalledWith(
        'user-2'
      )
      expect(GoogleDriveSyncManager.pollUserChanges).toHaveBeenCalledTimes(2)
    })

    it('continues polling subsequent users when one user throws an error', async () => {
      db.googleDriveUserCredentials.find.mockReturnValue(
        mockCursor([{ user_id: 'user-fail' }, { user_id: 'user-success' }])
      )
      GoogleDriveSyncManager.pollUserChanges.mockImplementation(
        async userId => {
          if (userId === 'user-fail') {
            throw new Error('Rate limit exceeded')
          }
          return {}
        }
      )

      await GoogleDrivePollingWorker.pollAllUsers()

      expect(GoogleDriveSyncManager.pollUserChanges).toHaveBeenCalledWith(
        'user-fail'
      )
      expect(GoogleDriveSyncManager.pollUserChanges).toHaveBeenCalledWith(
        'user-success'
      )
    })

    it('skips watched users when cycle % pollRatio !== 0', async () => {
      Settings.googleDrive.watchedUserPollRatio = 5
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000)

      db.googleDriveUserCredentials.find.mockReturnValue(
        mockCursor([
          {
            user_id: 'watched-user',
            watchChannelId: 'chan-123',
            watchExpiresAt: futureDate,
          },
          {
            user_id: 'unwatched-user',
          },
        ])
      )
      GoogleDriveSyncManager.pollUserChanges.mockResolvedValue({})

      // Cycle 1: 1 % 5 !== 0, watched user skipped, unwatched user polled
      await GoogleDrivePollingWorker.pollAllUsers()

      expect(GoogleDriveSyncManager.pollUserChanges).not.toHaveBeenCalledWith(
        'watched-user'
      )
      expect(GoogleDriveSyncManager.pollUserChanges).toHaveBeenCalledWith(
        'unwatched-user'
      )
    })

    it('polls watched users when cycle % pollRatio === 0', async () => {
      Settings.googleDrive.watchedUserPollRatio = 2
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000)

      db.googleDriveUserCredentials.find.mockReturnValue(
        mockCursor([
          {
            user_id: 'watched-user',
            watchChannelId: 'chan-123',
            watchExpiresAt: futureDate,
          },
        ])
      )
      GoogleDriveSyncManager.pollUserChanges.mockResolvedValue({})

      // Cycle 1 (odd cycle, not divisible by 2): should skip
      await GoogleDrivePollingWorker.pollAllUsers()
      expect(GoogleDriveSyncManager.pollUserChanges).not.toHaveBeenCalled()

      // Cycle 2 (even cycle, divisible by 2): should poll
      await GoogleDrivePollingWorker.pollAllUsers()
      expect(GoogleDriveSyncManager.pollUserChanges).toHaveBeenCalledWith(
        'watched-user'
      )
    })

    it('polls users whose watch channels are expired', async () => {
      Settings.googleDrive.watchedUserPollRatio = 10
      const pastDate = new Date(Date.now() - 1000)

      db.googleDriveUserCredentials.find.mockReturnValue(
        mockCursor([
          {
            user_id: 'expired-watched-user',
            watchChannelId: 'chan-old',
            watchExpiresAt: pastDate,
          },
        ])
      )
      GoogleDriveSyncManager.pollUserChanges.mockResolvedValue({})

      // Even on cycle 1, expired channel is treated as unwatched
      await GoogleDrivePollingWorker.pollAllUsers()

      expect(GoogleDriveSyncManager.pollUserChanges).toHaveBeenCalledWith(
        'expired-watched-user'
      )
    })
  })
})
