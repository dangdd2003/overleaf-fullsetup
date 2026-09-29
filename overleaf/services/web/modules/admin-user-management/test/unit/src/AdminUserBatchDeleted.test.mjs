import { describe, it, expect, vi, beforeEach } from 'vitest'
import SessionManager from '../../../../../app/src/Features/Authentication/SessionManager.mjs'
import UserAuditLogHandler from '../../../../../app/src/Features/User/UserAuditLogHandler.mjs'
import { ObjectId } from '../../../../../app/src/infrastructure/mongodb.mjs'

vi.mock('@overleaf/settings', () => ({
  default: {
    siteUrl: 'https://overleaf.example.com',
  },
}))

vi.mock('@overleaf/o-error', () => ({
  default: class OError extends Error {},
}))

vi.mock('../../../../../app/src/Features/Errors/Errors.js', () => ({
  default: {
    NotFoundError: class NotFoundError extends Error {},
    ForbiddenError: class ForbiddenError extends Error {},
    BadRequestError: class BadRequestError extends Error {},
  },
  NotFoundError: class NotFoundError extends Error {},
  ForbiddenError: class ForbiddenError extends Error {},
  BadRequestError: class BadRequestError extends Error {},
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

vi.mock('../../../../../app/src/Features/Authentication/SessionManager.mjs', () => ({
  default: {
    getLoggedInUserId: vi.fn(),
  },
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

vi.mock('../../../../../app/src/models/DeletedUser.mjs', () => ({
  DeletedUser: {
    find: vi.fn(),
    findOne: vi.fn(),
    deleteMany: vi.fn(),
    deleteOne: vi.fn(),
  },
}))

vi.mock('../../../../../app/src/models/DeletedProject.mjs', () => ({
  DeletedProject: {
    find: vi.fn(),
  },
}))

vi.mock('../../../../../app/src/models/UserAuditLogEntry.mjs', () => ({
  UserAuditLogEntry: {
    find: vi.fn(),
    countDocuments: vi.fn(),
  },
}))

vi.mock('../../../../../app/src/Features/User/UserSessionsManager.mjs', () => ({
  default: {
    promises: {
      removeSessionsFromRedis: vi.fn(),
    },
    removeSessionsFromRedis: vi.fn(),
  },
}))

vi.mock('../../../../../app/src/Features/User/UserDeleter.mjs', () => ({
  default: {
    promises: {
      deleteUser: vi.fn(),
    },
  },
}))

vi.mock('../../../../../app/src/Features/User/UserGetter.mjs', () => ({
  default: {
    promises: {
      getUserByAnyEmail: vi.fn(),
      getUser: vi.fn(),
    },
    getUserByAnyEmail: vi.fn(),
    getUser: vi.fn(),
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
  },
}))

vi.mock('../../../../../app/src/Features/Security/OneTimeTokenHandler.mjs', () => ({
  default: {
    promises: {
      getNewToken: vi.fn(),
    },
  },
}))

vi.mock('../../../../../app/src/Features/Helpers/EmailHelper.mjs', () => ({
  default: {
    parseEmail: vi.fn(email => email),
  },
}))

vi.mock('../../../../../app/src/Features/Collaborators/OwnershipTransferHandler.mjs', () => ({
  default: {
    promises: {
      transferOwnership: vi.fn(),
      transferAllProjectsToUser: vi.fn(),
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

vi.mock('../../../app/src/AdminUserRestorer.mjs', () => ({
  restoreUserAndProjects: vi.fn(),
  purgeDeletedUser: vi.fn(),
}))

vi.mock('../../../app/src/AdminUserQuery.mjs', () => ({
  getActiveUsers: vi.fn(),
  getDeletedUsers: vi.fn(),
  getUserById: vi.fn(),
}))

vi.mock('../../../app/src/AdminUserGuards.mjs', () => ({
  ensureCanDeleteUser: vi.fn(),
  ensureCanModifyAdmin: vi.fn(),
}))

import AdminUserManagementController from '../../../app/src/AdminUserManagementController.mjs'
import {
  restoreUserAndProjects,
  purgeDeletedUser,
} from '../../../app/src/AdminUserRestorer.mjs'

describe('AdminUserBatchDeleted', () => {
  let req
  let res
  const callerId = '507f1f77bcf86cd799439099'
  const user1Id = '507f1f77bcf86cd799439011'
  const user2Id = '507f1f77bcf86cd799439022'
  const record1Id = '507f1f77bcf86cd799439033'
  const record2Id = '507f1f77bcf86cd799439044'

  beforeEach(() => {
    vi.clearAllMocks()
    req = {
      body: {},
      session: {
        user: { _id: callerId },
      },
      ip: '127.0.0.1',
    }
    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }
    SessionManager.getLoggedInUserId.mockReturnValue(callerId)
  })

  describe('batchRestoreUsers', () => {
    it('should reject missing or empty userIds payload', async () => {
      req.body = {}
      await AdminUserManagementController.batchRestoreUsers(req, res)
      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'invalid_user_ids' })
      )

      req.body = { userIds: [] }
      await AdminUserManagementController.batchRestoreUsers(req, res)
      expect(res.status).toHaveBeenCalledWith(400)
    })

    it('should restore multiple users and return aggregate restored count', async () => {
      req.body = {
        userIds: [user1Id, user2Id],
      }

      restoreUserAndProjects.mockImplementation(async userId => {
        if (userId === user1Id) return { user: { _id: user1Id }, restoredProjectCount: 3 }
        if (userId === user2Id) return { user: { _id: user2Id }, restoredProjectCount: 2 }
        return null
      })

      await AdminUserManagementController.batchRestoreUsers(req, res)

      expect(restoreUserAndProjects).toHaveBeenCalledTimes(2)
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        restoredCount: 2,
        restoredProjectsCount: 5,
        failed: [],
      })
    })
  })

  describe('batchPurgeDeletedUsers', () => {
    it('should reject missing or empty recordIds payload', async () => {
      req.body = { recordIds: [] }
      await AdminUserManagementController.batchPurgeDeletedUsers(req, res)
      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'invalid_record_ids' })
      )
    })

    it('should permanently purge selected deleted user records', async () => {
      req.body = {
        recordIds: [record1Id, record2Id],
      }

      purgeDeletedUser.mockResolvedValue({ success: true })

      await AdminUserManagementController.batchPurgeDeletedUsers(req, res)

      expect(purgeDeletedUser).toHaveBeenCalledTimes(2)
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        purgedCount: 2,
        failed: [],
      })
    })
  })
})
