import { describe, it, expect, vi, beforeEach } from 'vitest'
import { db } from '../../../../../app/src/infrastructure/mongodb.mjs'
import SessionManager from '../../../../../app/src/Features/Authentication/SessionManager.mjs'
import UserSessionsManager from '../../../../../app/src/Features/User/UserSessionsManager.mjs'
import UserAuditLogHandler from '../../../../../app/src/Features/User/UserAuditLogHandler.mjs'
import { getUserById } from '../../../app/src/AdminUserQuery.mjs'

vi.mock('@overleaf/settings', () => ({
  default: { siteUrl: 'https://overleaf.example.com' },
}))

vi.mock('@overleaf/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
        findOne: vi.fn(),
        countDocuments: vi.fn(),
      },
    },
  }
})

vi.mock('../../../../../app/src/Features/Authentication/SessionManager.mjs', () => ({
  default: { getLoggedInUserId: vi.fn() },
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
  default: { promises: { deleteUser: vi.fn() } },
}))

vi.mock('../../../../../app/src/Features/User/UserAuditLogHandler.mjs', () => ({
  default: { promises: { addEntry: vi.fn() } },
}))

vi.mock('../../../../../app/src/Features/Security/OneTimeTokenHandler.mjs', () => ({
  default: { promises: { getNewToken: vi.fn() } },
}))

vi.mock('../../../../../app/src/Features/User/UserGetter.mjs', () => ({
  default: { promises: { getUser: vi.fn(), getUserByAnyEmail: vi.fn() } },
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

vi.mock('../../../../../app/src/Features/Helpers/EmailHelper.mjs', () => ({
  default: { parseEmail: vi.fn(email => email) },
}))

vi.mock('../../../../../app/src/Features/Collaborators/OwnershipTransferHandler.mjs', () => ({
  default: {
    promises: { transferOwnership: vi.fn(), transferAllProjectsToUser: vi.fn() },
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
  escapeRegExp: vi.fn(str => str),
}))

vi.mock('../../../../../app/src/models/Project.mjs', () => ({
  Project: { find: vi.fn(), countDocuments: vi.fn(), exists: vi.fn() },
}))

vi.mock('../../../../../app/src/models/User.mjs', () => ({
  User: { find: vi.fn(), updateOne: vi.fn() },
}))

vi.mock('../../../../../app/src/models/UserAuditLogEntry.mjs', () => ({
  UserAuditLogEntry: { find: vi.fn(), countDocuments: vi.fn() },
}))

vi.mock('../../../../../app/src/Features/User/UserCreator.mjs', () => ({
  default: { promises: { createNewUser: vi.fn() } },
}))

vi.mock('../../../../../app/src/Features/Authentication/AuthenticationManager.mjs', () => ({
  default: { hashPassword: vi.fn(), validatePassword: vi.fn() },
}))

import AdminUserManagementController from '../../../app/src/AdminUserManagementController.mjs'

describe('AdminUserManagementController', () => {
  const callerId = '507f1f77bcf86cd799439099'
  const targetUserId = '507f1f77bcf86cd799439011'

  let req
  let res
  let next

  beforeEach(() => {
    vi.clearAllMocks()
    SessionManager.getLoggedInUserId.mockReturnValue(callerId)
    req = {
      params: { userId: targetUserId },
      body: {},
      session: {},
      ip: '127.0.0.1',
    }
    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      render: vi.fn().mockReturnThis(),
    }
    next = vi.fn()
  })

  describe('renderUserDetailPage', () => {
    it('forwards unexpected errors to next(err)', async () => {
      const boom = new Error('db failure')
      getUserById.mockRejectedValue(boom)

      await AdminUserManagementController.renderUserDetailPage(req, res, next)

      expect(next).toHaveBeenCalledWith(boom)
      expect(res.render).not.toHaveBeenCalled()
    })
  })

  describe('updateUserProfile', () => {
    it('returns 404 user_not_found without writing an audit entry when matchedCount is 0', async () => {
      req.body = { first_name: 'Alice', last_name: 'Smith' }
      db.users.updateOne.mockResolvedValue({ matchedCount: 0 })

      await AdminUserManagementController.updateUserProfile(req, res)

      expect(res.status).toHaveBeenCalledWith(404)
      expect(res.json).toHaveBeenCalledWith({ error: 'user_not_found' })
      expect(UserAuditLogHandler.promises.addEntry).not.toHaveBeenCalled()
    })
  })

  describe('updateAdminStatus', () => {
    it('returns 404 user_not_found without revoking sessions or writing an audit entry when matchedCount is 0', async () => {
      req.body = { isAdmin: false }
      db.users.findOne.mockResolvedValue({ isAdmin: false, suspended: false })
      db.users.countDocuments.mockResolvedValue(2)
      db.users.updateOne.mockResolvedValue({ matchedCount: 0 })

      await AdminUserManagementController.updateAdminStatus(req, res)

      expect(res.status).toHaveBeenCalledWith(404)
      expect(res.json).toHaveBeenCalledWith({ error: 'user_not_found' })
      expect(
        UserSessionsManager.promises.removeSessionsFromRedis
      ).not.toHaveBeenCalled()
      expect(UserAuditLogHandler.promises.addEntry).not.toHaveBeenCalled()
    })
  })
})
