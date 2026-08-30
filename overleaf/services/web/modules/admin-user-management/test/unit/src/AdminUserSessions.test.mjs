import { describe, it, expect, vi, beforeEach } from 'vitest'
import SessionManager from '../../../../../app/src/Features/Authentication/SessionManager.mjs'
import UserSessionsManager from '../../../../../app/src/Features/User/UserSessionsManager.mjs'
import UserAuditLogHandler from '../../../../../app/src/Features/User/UserAuditLogHandler.mjs'
import { ObjectId } from '../../../../../app/src/infrastructure/mongodb.mjs'

vi.mock('@overleaf/settings', () => ({
  default: {
    siteUrl: 'https://overleaf.example.com',
  },
}))

vi.mock('@overleaf/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../../../../../app/src/infrastructure/mongodb.mjs', () => {
  class MockObjectId {
    constructor(id) {
      this.id = id || '507f1f77bcf86cd799439011'
    }
    toString() {
      return this.id
    }
    static isValid(id) {
      return typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id)
    }
  }

  return {
    ObjectId: MockObjectId,
    db: {
      users: {
        updateOne: vi.fn(),
      },
    },
  }
})

vi.mock('../../../app/src/AdminUserRestorer.mjs', () => ({
  restoreUserAndProjects: vi.fn(),
}))

vi.mock('../../../../../app/src/Features/Collaborators/OwnershipTransferHandler.mjs', () => ({
  default: {
    promises: {
      transferOwnership: vi.fn(),
      transferAllProjectsToUser: vi.fn(),
    },
  },
}))

vi.mock('../../../app/src/AdminUserQuery.mjs', () => ({
  getActiveUsers: vi.fn(),
  getDeletedUsers: vi.fn(),
  getUserById: vi.fn(),
}))

vi.mock('../../../../../app/src/models/Project.mjs', () => ({
  Project: {
    find: vi.fn(),
    countDocuments: vi.fn(),
  },
}))

vi.mock('../../../../../app/src/models/User.mjs', () => ({
  User: function (doc) {
    Object.assign(this, doc)
  },
}))

vi.mock('../../../../../app/src/models/UserAuditLogEntry.mjs', () => ({
  UserAuditLogEntry: {
    find: vi.fn(),
    countDocuments: vi.fn(),
  },
}))

vi.mock('../../../../../app/src/Features/User/UserCreator.mjs', () => ({
  default: {
    promises: {
      createNewUser: vi.fn(),
    },
  },
}))

vi.mock('../../../../../app/src/Features/Authentication/AuthenticationManager.mjs', () => ({
  default: {
    hashPassword: vi.fn(),
  },
}))

vi.mock('../../../../../app/src/models/DeletedUser.mjs', () => ({
  DeletedUser: {
    findOne: vi.fn(),
    deleteOne: vi.fn(),
  },
}))

vi.mock('../../../../../app/src/models/DeletedProject.mjs', () => ({
  DeletedProject: {
    find: vi.fn(),
  },
}))

vi.mock('../../../../../app/src/Features/User/UserGetter.mjs', () => ({
  default: {
    promises: {
      getUser: vi.fn(),
      getUserByAnyEmail: vi.fn(),
    },
  },
}))

vi.mock('../../../../../app/src/Features/User/UserUpdater.mjs', () => ({
  default: {
    promises: {
      addEmailAddress: vi.fn(),
      removeEmailAddress: vi.fn(),
      setDefaultEmailAddress: vi.fn(),
    },
    addEmailAddress: vi.fn(),
    removeEmailAddress: vi.fn(),
    setDefaultEmailAddress: vi.fn(),
  },
}))

vi.mock('../../../../../app/src/Features/Helpers/EmailHelper.mjs', () => ({
  default: {
    parseEmail: vi.fn(email => email),
  },
}))

vi.mock('../../../../../app/src/Features/User/UserDeleter.mjs', () => ({
  default: {
    promises: {
      deleteUser: vi.fn(),
    },
  },
}))

vi.mock('../../../../../app/src/Features/Security/OneTimeTokenHandler.mjs', () => ({
  default: {
    promises: {
      getNewToken: vi.fn(),
    },
  },
}))

vi.mock('../../../../../app/src/Features/Authentication/SessionManager.mjs', () => ({
  default: {
    getLoggedInUserId: vi.fn(),
  },
}))

vi.mock('../../../../../app/src/Features/User/UserSessionsManager.mjs', () => {
  const getAllUserSessions = vi.fn()
  const removeSessionsFromRedis = vi.fn()
  return {
    default: {
      promises: {
        getAllUserSessions,
        removeSessionsFromRedis,
      },
      getAllUserSessions,
      removeSessionsFromRedis,
    },
  }
})

vi.mock('../../../../../app/src/Features/User/UserAuditLogHandler.mjs', () => ({
  default: {
    promises: {
      addEntry: vi.fn(),
    },
  },
}))

import AdminUserManagementController from '../../../app/src/AdminUserManagementController.mjs'

describe('AdminUserSessions Controller', () => {
  const targetUserId = '507f1f77bcf86cd799439011'
  const adminCallerId = '507f1f77bcf86cd799439022'

  let req
  let res

  beforeEach(() => {
    vi.clearAllMocks()

    req = {
      params: { userId: targetUserId },
      session: {},
      sessionID: 'test-session-id-123',
      ip: '192.168.1.100',
    }

    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    }
  })

  describe('getUserSessions', () => {
    it('returns 400 if userId is not a valid ObjectId', async () => {
      req.params.userId = 'invalid-id'

      await AdminUserManagementController.getUserSessions(req, res)

      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith({ error: 'invalid_user_id' })
      expect(UserSessionsManager.promises.getAllUserSessions).not.toHaveBeenCalled()
    })

    it('calls UserSessionsManager.getAllUserSessions with { _id: userId } and returns { sessions, count: 1 }', async () => {
      const mockSessions = [
        {
          ip_address: '192.168.1.50',
          session_created: '2026-08-29T09:30:00.000Z',
        },
      ]
      UserSessionsManager.promises.getAllUserSessions.mockResolvedValue(mockSessions)

      await AdminUserManagementController.getUserSessions(req, res)

      expect(UserSessionsManager.promises.getAllUserSessions).toHaveBeenCalledWith({
        _id: targetUserId,
      })
      expect(res.json).toHaveBeenCalledWith({
        sessions: mockSessions,
        count: 1,
      })
    })

    it('returns empty list and count 0 if user has no active sessions', async () => {
      UserSessionsManager.promises.getAllUserSessions.mockResolvedValue([])

      await AdminUserManagementController.getUserSessions(req, res)

      expect(UserSessionsManager.promises.getAllUserSessions).toHaveBeenCalledWith({
        _id: targetUserId,
      })
      expect(res.json).toHaveBeenCalledWith({
        sessions: [],
        count: 0,
      })
    })

    it('returns 500 when UserSessionsManager.getAllUserSessions fails', async () => {
      UserSessionsManager.promises.getAllUserSessions.mockRejectedValue(
        new Error('Redis connection error')
      )

      await AdminUserManagementController.getUserSessions(req, res)

      expect(res.status).toHaveBeenCalledWith(500)
      expect(res.json).toHaveBeenCalledWith({
        error: 'failed_to_fetch_sessions',
      })
    })
  })

  describe('revokeUserSessions', () => {
    it('returns 400 if userId is not a valid ObjectId', async () => {
      req.params.userId = 'invalid-id'

      await AdminUserManagementController.revokeUserSessions(req, res)

      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith({ error: 'invalid_user_id' })
      expect(
        UserSessionsManager.promises.removeSessionsFromRedis
      ).not.toHaveBeenCalled()
    })

    it('calls removeSessionsFromRedis without retainSessionID when revoking another user account', async () => {
      SessionManager.getLoggedInUserId.mockReturnValue(adminCallerId)
      UserSessionsManager.promises.removeSessionsFromRedis.mockResolvedValue(2)

      await AdminUserManagementController.revokeUserSessions(req, res)

      expect(
        UserSessionsManager.promises.removeSessionsFromRedis
      ).toHaveBeenCalledWith({ _id: targetUserId }, null)
      expect(UserAuditLogHandler.promises.addEntry).toHaveBeenCalledWith(
        expect.any(ObjectId),
        'admin-revoke-sessions',
        adminCallerId,
        '192.168.1.100',
        {
          retainedSelf: false,
          revokedCount: 2,
        }
      )
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        revokedCount: 2,
      })
    })

    it('passes retainSessionID: req.sessionID when caller is revoking their own account (callerUserId === userId)', async () => {
      SessionManager.getLoggedInUserId.mockReturnValue(targetUserId)
      UserSessionsManager.promises.removeSessionsFromRedis.mockResolvedValue(2)

      await AdminUserManagementController.revokeUserSessions(req, res)

      expect(
        UserSessionsManager.promises.removeSessionsFromRedis
      ).toHaveBeenCalledWith({ _id: targetUserId }, 'test-session-id-123')
      expect(UserAuditLogHandler.promises.addEntry).toHaveBeenCalledWith(
        expect.any(ObjectId),
        'admin-revoke-sessions',
        targetUserId,
        '192.168.1.100',
        {
          retainedSelf: true,
          revokedCount: 2,
        }
      )
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        revokedCount: 2,
      })
    })

    it('returns 500 when UserSessionsManager.removeSessionsFromRedis fails', async () => {
      SessionManager.getLoggedInUserId.mockReturnValue(adminCallerId)
      UserSessionsManager.promises.removeSessionsFromRedis.mockRejectedValue(
        new Error('Redis failure')
      )

      await AdminUserManagementController.revokeUserSessions(req, res)

      expect(res.status).toHaveBeenCalledWith(500)
      expect(res.json).toHaveBeenCalledWith({
        error: 'failed_to_revoke_sessions',
      })
    })
  })
})
