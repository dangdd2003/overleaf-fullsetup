import { describe, it, expect, vi, beforeEach } from 'vitest'
import { UserAuditLogEntry } from '../../../../../app/src/models/UserAuditLogEntry.mjs'
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
        find: vi.fn(),
        countDocuments: vi.fn(),
        findOne: vi.fn(),
        updateOne: vi.fn(),
      },
    },
  }
})

vi.mock('../../../../../app/src/Features/Authentication/SessionManager.mjs', () => ({
  default: {
    getLoggedInUserId: vi.fn(),
  },
}))

vi.mock('../../../../../app/src/Features/User/UserSessionsManager.mjs', () => ({
  default: {
    promises: {
      getAllUserSessions: vi.fn(),
      removeSessionsFromRedis: vi.fn(),
    },
  },
}))

vi.mock('../../../../../app/src/Features/User/UserDeleter.mjs', () => ({
  default: {
    promises: {
      deleteUser: vi.fn(),
    },
  },
}))

vi.mock('../../../../../app/src/Features/User/UserAuditLogHandler.mjs', () => ({
  default: {
    promises: {
      addEntry: vi.fn(),
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
    promises: {
      hashPassword: vi.fn(),
    },
  },
}))

vi.mock('../../../../../app/src/Features/Helpers/EmailHelper.mjs', () => ({
  default: {
    parseEmail: vi.fn(email => email),
  },
}))

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
  escapeRegExp: vi.fn(str => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
}))

vi.mock('../../../../../app/src/models/Project.mjs', () => ({
  Project: {
    find: vi.fn(),
    countDocuments: vi.fn(),
  },
}))

vi.mock('../../../../../app/src/models/User.mjs', () => ({
  User: {
    find: vi.fn(),
    updateOne: vi.fn(),
  },
}))

vi.mock('../../../../../app/src/models/UserAuditLogEntry.mjs', () => ({
  UserAuditLogEntry: {
    find: vi.fn(),
    countDocuments: vi.fn(),
  },
}))

import AdminUserManagementController from '../../../app/src/AdminUserManagementController.mjs'

describe('AdminUserAuditTrail Controller', () => {
  const targetUserId = '507f1f77bcf86cd799439011'
  let req
  let res

  beforeEach(() => {
    vi.clearAllMocks()

    req = {
      params: { userId: targetUserId },
      query: {},
      session: {},
      ip: '127.0.0.1',
    }

    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    }
  })

  describe('getUserAuditLogs', () => {
    it('returns 400 if userId is not a valid ObjectId', async () => {
      req.params.userId = 'invalid-id'

      await AdminUserManagementController.getUserAuditLogs(req, res)

      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith({ error: 'invalid_user_id' })
      expect(UserAuditLogEntry.find).not.toHaveBeenCalled()
    })

    it('returns paginated audit log entries with default pagination', async () => {
      const mockEntries = [
        {
          _id: 'entry1',
          userId: targetUserId,
          operation: 'admin-set-admin-status',
          initiatorId: 'admin1',
          ipAddress: '127.0.0.1',
          info: { isAdmin: true },
          createdAt: new Date('2026-08-29T10:00:00Z'),
        },
      ]

      const mockLimit = vi.fn().mockResolvedValue(mockEntries)
      const mockSkip = vi.fn().mockReturnValue({ limit: mockLimit })
      const mockSort = vi.fn().mockReturnValue({ skip: mockSkip })
      UserAuditLogEntry.find.mockReturnValue({ sort: mockSort })
      UserAuditLogEntry.countDocuments.mockResolvedValue(1)

      req.query = { page: '1', limit: '10' }

      await AdminUserManagementController.getUserAuditLogs(req, res)

      expect(UserAuditLogEntry.find).toHaveBeenCalledWith({
        userId: expect.any(ObjectId),
      })
      expect(mockSort).toHaveBeenCalledWith({ createdAt: -1 })
      expect(mockSkip).toHaveBeenCalledWith(0)
      expect(mockLimit).toHaveBeenCalledWith(10)
      expect(res.json).toHaveBeenCalledWith({
        auditLogs: mockEntries,
        total: 1,
        page: 1,
        totalPages: 1,
      })
    })

    it('handles custom pagination parameters and calculation of totalPages', async () => {
      const mockEntries = [
        {
          _id: 'entry2',
          userId: targetUserId,
          operation: 'admin-revoke-sessions',
          initiatorId: 'admin1',
          ipAddress: '127.0.0.1',
          info: { revokedCount: 2 },
          createdAt: new Date('2026-08-29T11:00:00Z'),
        },
      ]

      const mockLimit = vi.fn().mockResolvedValue(mockEntries)
      const mockSkip = vi.fn().mockReturnValue({ limit: mockLimit })
      const mockSort = vi.fn().mockReturnValue({ skip: mockSkip })
      UserAuditLogEntry.find.mockReturnValue({ sort: mockSort })
      UserAuditLogEntry.countDocuments.mockResolvedValue(25)

      req.query = { page: '3', limit: '10' }

      await AdminUserManagementController.getUserAuditLogs(req, res)

      expect(mockSort).toHaveBeenCalledWith({ createdAt: -1 })
      expect(mockSkip).toHaveBeenCalledWith(20)
      expect(mockLimit).toHaveBeenCalledWith(10)
      expect(res.json).toHaveBeenCalledWith({
        auditLogs: mockEntries,
        total: 25,
        page: 3,
        totalPages: 3,
      })
    })

    it('handles empty audit logs gracefully with totalPages: 1', async () => {
      const mockLimit = vi.fn().mockResolvedValue([])
      const mockSkip = vi.fn().mockReturnValue({ limit: mockLimit })
      const mockSort = vi.fn().mockReturnValue({ skip: mockSkip })
      UserAuditLogEntry.find.mockReturnValue({ sort: mockSort })
      UserAuditLogEntry.countDocuments.mockResolvedValue(0)

      await AdminUserManagementController.getUserAuditLogs(req, res)

      expect(res.json).toHaveBeenCalledWith({
        auditLogs: [],
        total: 0,
        page: 1,
        totalPages: 1,
      })
    })

    it('returns 500 when UserAuditLogEntry.find throws an error', async () => {
      UserAuditLogEntry.find.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          skip: vi.fn().mockReturnValue({
            limit: vi.fn().mockRejectedValue(new Error('Database error')),
          }),
        }),
      })
      UserAuditLogEntry.countDocuments.mockResolvedValue(0)

      await AdminUserManagementController.getUserAuditLogs(req, res)

      expect(res.status).toHaveBeenCalledWith(500)
      expect(res.json).toHaveBeenCalledWith({
        error: 'failed_to_get_audit_logs',
      })
    })

    it('returns 500 when UserAuditLogEntry.countDocuments throws an error', async () => {
      const mockLimit = vi.fn().mockResolvedValue([])
      const mockSkip = vi.fn().mockReturnValue({ limit: mockLimit })
      const mockSort = vi.fn().mockReturnValue({ skip: mockSkip })
      UserAuditLogEntry.find.mockReturnValue({ sort: mockSort })
      UserAuditLogEntry.countDocuments.mockRejectedValue(
        new Error('Count query error')
      )

      await AdminUserManagementController.getUserAuditLogs(req, res)

      expect(res.status).toHaveBeenCalledWith(500)
      expect(res.json).toHaveBeenCalledWith({
        error: 'failed_to_get_audit_logs',
      })
    })
  })
})
