import { vi, describe, it, expect, beforeEach } from 'vitest'

const { mockDb, mockSessionManager } = vi.hoisted(() => {
  const mockCollection = {
    findOne: vi.fn(),
    updateOne: vi.fn(),
  }
  const mockDb = {
    notificationsPreferences: mockCollection,
  }
  const mockSessionManager = {
    getLoggedInUserId: vi.fn(),
  }
  return { mockDb, mockSessionManager }
})

vi.mock('../../../../../app/src/infrastructure/mongodb.mjs', () => ({
  db: mockDb,
}))
vi.mock(
  '../../../../../app/src/Features/Authentication/SessionManager.mjs',
  () => ({ default: mockSessionManager })
)

const NotificationPreferencesController = (
  await import('../../../app/src/NotificationPreferencesController.mjs')
).default

function createMockReqRes(overrides = {}) {
  const req = {
    params: {},
    body: {},
    session: {},
    ...overrides.req,
  }
  const res = {
    json: vi.fn(),
    sendStatus: vi.fn(),
    status: vi.fn().mockReturnThis(),
    ...overrides.res,
  }
  return { req, res }
}

describe('NotificationPreferencesController', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getPreferences', () => {
    it('returns default preferences when no custom preferences stored', async () => {
      mockSessionManager.getLoggedInUserId.mockReturnValue('u1')
      mockDb.notificationsPreferences.findOne.mockResolvedValue(null)

      const { req, res } = createMockReqRes({
        req: { params: { project_id: 'p1' } },
      })

      await NotificationPreferencesController.getPreferences(req, res)

      expect(mockDb.notificationsPreferences.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: 'u1', project_id: 'p1' })
      )
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          commentOnOwnProject: true,
          commentOnInvitedProject: false,
          repliesOnAuthoredThread: true,
          repliesOnParticipatingThread: true,
          muteAllNotifications: false,
        })
      )
    })

    it('returns stored preferences merged with defaults', async () => {
      mockSessionManager.getLoggedInUserId.mockReturnValue('u1')
      mockDb.notificationsPreferences.findOne.mockResolvedValue({
        user_id: 'u1',
        project_id: 'p1',
        preferences: {
          commentOnOwnProject: false,
          muteAllNotifications: true,
        },
      })

      const { req, res } = createMockReqRes({
        req: { params: { project_id: 'p1' } },
      })

      await NotificationPreferencesController.getPreferences(req, res)

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          commentOnOwnProject: false,
          muteAllNotifications: true,
          repliesOnAuthoredThread: true,
        })
      )
    })
  })

  describe('updatePreferences', () => {
    it('persists preferences to db and returns 200', async () => {
      mockSessionManager.getLoggedInUserId.mockReturnValue('u1')
      mockDb.notificationsPreferences.updateOne.mockResolvedValue()

      const newPrefs = {
        commentOnOwnProject: false,
        repliesOnAuthoredThread: false,
      }

      const { req, res } = createMockReqRes({
        req: {
          params: { project_id: 'p1' },
          body: newPrefs,
        },
      })

      await NotificationPreferencesController.updatePreferences(req, res)

      expect(mockDb.notificationsPreferences.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: 'u1', project_id: 'p1' }),
        expect.objectContaining({
          $set: expect.objectContaining({
            preferences: expect.objectContaining(newPrefs),
          }),
        }),
        { upsert: true }
      )
      expect(res.sendStatus).toHaveBeenCalledWith(200)
    })
  })
})
