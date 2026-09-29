import { describe, it, expect, vi, beforeEach } from 'vitest'
import SessionManager from '../../../../../app/src/Features/Authentication/SessionManager.mjs'
import UserGetter from '../../../../../app/src/Features/User/UserGetter.mjs'
import UserUpdater from '../../../../../app/src/Features/User/UserUpdater.mjs'
import EmailHelper from '../../../../../app/src/Features/Helpers/EmailHelper.mjs'
import UserAuditLogHandler from '../../../../../app/src/Features/User/UserAuditLogHandler.mjs'
import { ObjectId } from '../../../../../app/src/infrastructure/mongodb.mjs'
import { getUserById } from '../../../app/src/AdminUserQuery.mjs'

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
        findOne: vi.fn(),
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

vi.mock('../../../../../app/src/Features/User/UserGetter.mjs', () => ({
  default: {
    promises: {
      getUser: vi.fn(),
      getUserByAnyEmail: vi.fn(),
      getUserByMainEmail: vi.fn(),
      ensureUniqueEmailAddress: vi.fn(),
    },
    getUser: vi.fn(),
    getUserByAnyEmail: vi.fn(),
    getUserByMainEmail: vi.fn(),
    ensureUniqueEmailAddress: vi.fn(),
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
    parseEmail: vi.fn(email => {
      if (
        typeof email !== 'string' ||
        !email.includes('@') ||
        email.includes(' ') ||
        email.startsWith('@') ||
        email.endsWith('@')
      ) {
        return null
      }
      return email.trim().toLowerCase()
    }),
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

describe('AdminUserEmails Controller', () => {
  const targetUserId = '507f1f77bcf86cd799439011'
  const adminCallerId = '507f1f77bcf86cd799439022'

  let req
  let res

  beforeEach(() => {
    vi.clearAllMocks()

    SessionManager.getLoggedInUserId.mockReturnValue(adminCallerId)

    req = {
      params: { userId: targetUserId },
      body: {},
      session: {},
      sessionID: 'test-session-id-123',
      ip: '192.168.1.100',
    }

    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    }
  })

  describe('addEmail', () => {
    it('returns 400 if userId is not a valid ObjectId', async () => {
      req.params.userId = 'invalid-id'
      req.body.email = 'valid@example.com'

      await AdminUserManagementController.addEmail(req, res)

      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith({ error: 'invalid_user_id' })
      expect(UserUpdater.promises.addEmailAddress).not.toHaveBeenCalled()
    })

    it('returns 400 if email syntax is invalid', async () => {
      req.body.email = 'invalid-email-syntax'

      await AdminUserManagementController.addEmail(req, res)

      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith({ error: 'invalid_email' })
      expect(UserUpdater.promises.addEmailAddress).not.toHaveBeenCalled()
    })

    it('returns 404 if target user is not found', async () => {
      req.body.email = 'new@example.com'
      getUserById.mockResolvedValue(null)

      await AdminUserManagementController.addEmail(req, res)

      expect(res.status).toHaveBeenCalledWith(404)
      expect(res.json).toHaveBeenCalledWith({ error: 'user_not_found' })
      expect(UserUpdater.promises.addEmailAddress).not.toHaveBeenCalled()
    })

    it('returns 409 email_already_registered if email is already registered to another account', async () => {
      req.body.email = 'duplicate@example.com'
      getUserById.mockResolvedValue({
        _id: targetUserId,
        email: 'primary@example.com',
      })
      UserGetter.promises.getUserByAnyEmail.mockResolvedValue({
        _id: '507f1f77bcf86cd799439099',
        email: 'duplicate@example.com',
      })

      await AdminUserManagementController.addEmail(req, res)

      expect(res.status).toHaveBeenCalledWith(409)
      expect(res.json).toHaveBeenCalledWith({
        error: 'email_already_registered',
      })
      expect(UserUpdater.promises.addEmailAddress).not.toHaveBeenCalled()
    })

    it('calls UserUpdater.promises.addEmailAddress(userId, email, { confirmed: true }) and returns { success: true, user }', async () => {
      const mockUpdatedUser = {
        _id: targetUserId,
        email: 'primary@example.com',
        emails: [
          { email: 'primary@example.com', confirmedAt: new Date() },
          { email: 'new@example.com', confirmedAt: new Date() },
        ],
      }
      req.body.email = 'new@example.com'
      getUserById
        .mockResolvedValueOnce({
          _id: targetUserId,
          email: 'primary@example.com',
        })
        .mockResolvedValueOnce(mockUpdatedUser)
      UserGetter.promises.getUserByAnyEmail.mockResolvedValue(null)
      UserUpdater.promises.addEmailAddress.mockResolvedValue()

      await AdminUserManagementController.addEmail(req, res)

      expect(UserUpdater.promises.addEmailAddress).toHaveBeenCalledWith(
        targetUserId,
        'new@example.com',
        { confirmed: true },
        expect.objectContaining({
          initiatorId: adminCallerId,
          ipAddress: '192.168.1.100',
        })
      )
      expect(UserAuditLogHandler.promises.addEntry).toHaveBeenCalledWith(
        expect.any(ObjectId),
        'admin-added-email',
        adminCallerId,
        '192.168.1.100',
        { email: 'new@example.com' }
      )
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        user: mockUpdatedUser,
      })
    })

    it('returns 500 when UserUpdater.promises.addEmailAddress fails', async () => {
      req.body.email = 'new@example.com'
      getUserById.mockResolvedValue({
        _id: targetUserId,
        email: 'primary@example.com',
      })
      UserGetter.promises.getUserByAnyEmail.mockResolvedValue(null)
      UserUpdater.promises.addEmailAddress.mockRejectedValue(
        new Error('Database write failure')
      )

      await AdminUserManagementController.addEmail(req, res)

      expect(res.status).toHaveBeenCalledWith(500)
      expect(res.json).toHaveBeenCalledWith({ error: 'failed_to_add_email' })
    })
  })

  describe('removeEmail', () => {
    it('returns 400 if userId is not a valid ObjectId', async () => {
      req.params.userId = 'invalid-id'
      req.body.email = 'secondary@example.com'

      await AdminUserManagementController.removeEmail(req, res)

      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith({ error: 'invalid_user_id' })
      expect(UserUpdater.promises.removeEmailAddress).not.toHaveBeenCalled()
    })

    it('returns 400 if email syntax is invalid', async () => {
      req.body.email = 'not-valid'

      await AdminUserManagementController.removeEmail(req, res)

      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith({ error: 'invalid_email' })
      expect(UserUpdater.promises.removeEmailAddress).not.toHaveBeenCalled()
    })

    it('returns 404 if target user is not found', async () => {
      req.body.email = 'secondary@example.com'
      getUserById.mockResolvedValue(null)

      await AdminUserManagementController.removeEmail(req, res)

      expect(res.status).toHaveBeenCalledWith(404)
      expect(res.json).toHaveBeenCalledWith({ error: 'user_not_found' })
      expect(UserUpdater.promises.removeEmailAddress).not.toHaveBeenCalled()
    })

    it('rejects removing the primary email (400 cannot_remove_primary_email)', async () => {
      req.body.email = 'primary@example.com'
      getUserById.mockResolvedValue({
        _id: targetUserId,
        email: 'primary@example.com',
        emails: [
          { email: 'primary@example.com' },
          { email: 'secondary@example.com' },
        ],
      })

      await AdminUserManagementController.removeEmail(req, res)

      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith({
        error: 'cannot_remove_primary_email',
      })
      expect(UserUpdater.promises.removeEmailAddress).not.toHaveBeenCalled()
    })

    it('calls UserUpdater.promises.removeEmailAddress(userId, email) and returns { success: true, user }', async () => {
      const mockUpdatedUser = {
        _id: targetUserId,
        email: 'primary@example.com',
        emails: [{ email: 'primary@example.com' }],
      }
      req.body.email = 'secondary@example.com'
      getUserById
        .mockResolvedValueOnce({
          _id: targetUserId,
          email: 'primary@example.com',
          emails: [
            { email: 'primary@example.com' },
            { email: 'secondary@example.com' },
          ],
        })
        .mockResolvedValueOnce(mockUpdatedUser)
      UserUpdater.promises.removeEmailAddress.mockResolvedValue()

      await AdminUserManagementController.removeEmail(req, res)

      expect(UserUpdater.promises.removeEmailAddress).toHaveBeenCalledWith(
        targetUserId,
        'secondary@example.com',
        expect.objectContaining({
          initiatorId: adminCallerId,
          ipAddress: '192.168.1.100',
        })
      )
      expect(UserAuditLogHandler.promises.addEntry).toHaveBeenCalledWith(
        expect.any(ObjectId),
        'admin-removed-email',
        adminCallerId,
        '192.168.1.100',
        { email: 'secondary@example.com' }
      )
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        user: mockUpdatedUser,
      })
    })

    it('returns 500 when UserUpdater.promises.removeEmailAddress fails', async () => {
      req.body.email = 'secondary@example.com'
      getUserById.mockResolvedValue({
        _id: targetUserId,
        email: 'primary@example.com',
        emails: [
          { email: 'primary@example.com' },
          { email: 'secondary@example.com' },
        ],
      })
      UserUpdater.promises.removeEmailAddress.mockRejectedValue(
        new Error('Failed to remove')
      )

      await AdminUserManagementController.removeEmail(req, res)

      expect(res.status).toHaveBeenCalledWith(500)
      expect(res.json).toHaveBeenCalledWith({
        error: 'failed_to_remove_email',
      })
    })
  })

  describe('setPrimaryEmail', () => {
    it('returns 400 if userId is not a valid ObjectId', async () => {
      req.params.userId = 'invalid-id'
      req.body.email = 'secondary@example.com'

      await AdminUserManagementController.setPrimaryEmail(req, res)

      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith({ error: 'invalid_user_id' })
      expect(UserUpdater.promises.setDefaultEmailAddress).not.toHaveBeenCalled()
    })

    it('returns 400 if email syntax is invalid', async () => {
      req.body.email = 'invalid-email'

      await AdminUserManagementController.setPrimaryEmail(req, res)

      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith({ error: 'invalid_email' })
      expect(UserUpdater.promises.setDefaultEmailAddress).not.toHaveBeenCalled()
    })

    it('returns 404 if target user is not found', async () => {
      req.body.email = 'secondary@example.com'
      getUserById.mockResolvedValue(null)

      await AdminUserManagementController.setPrimaryEmail(req, res)

      expect(res.status).toHaveBeenCalledWith(404)
      expect(res.json).toHaveBeenCalledWith({ error: 'user_not_found' })
      expect(UserUpdater.promises.setDefaultEmailAddress).not.toHaveBeenCalled()
    })

    it('calls UserUpdater.promises.setDefaultEmailAddress(userId, email) and returns { success: true, user }', async () => {
      const mockUpdatedUser = {
        _id: targetUserId,
        email: 'secondary@example.com',
        emails: [
          { email: 'primary@example.com' },
          { email: 'secondary@example.com' },
        ],
      }
      req.body.email = 'secondary@example.com'
      getUserById
        .mockResolvedValueOnce({
          _id: targetUserId,
          email: 'primary@example.com',
          emails: [
            { email: 'primary@example.com' },
            { email: 'secondary@example.com' },
          ],
        })
        .mockResolvedValueOnce(mockUpdatedUser)
      UserUpdater.promises.setDefaultEmailAddress.mockResolvedValue()

      await AdminUserManagementController.setPrimaryEmail(req, res)

      expect(UserUpdater.promises.setDefaultEmailAddress).toHaveBeenCalledWith(
        targetUserId,
        'secondary@example.com',
        true,
        expect.objectContaining({
          initiatorId: adminCallerId,
          ipAddress: '192.168.1.100',
        })
      )
      expect(UserAuditLogHandler.promises.addEntry).toHaveBeenCalledWith(
        expect.any(ObjectId),
        'admin-set-primary-email',
        adminCallerId,
        '192.168.1.100',
        { email: 'secondary@example.com' }
      )
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        user: mockUpdatedUser,
      })
    })

    it('returns 500 when UserUpdater.promises.setDefaultEmailAddress fails', async () => {
      req.body.email = 'secondary@example.com'
      getUserById.mockResolvedValue({
        _id: targetUserId,
        email: 'primary@example.com',
        emails: [
          { email: 'primary@example.com' },
          { email: 'secondary@example.com' },
        ],
      })
      UserUpdater.promises.setDefaultEmailAddress.mockRejectedValue(
        new Error('Failed to set default')
      )

      await AdminUserManagementController.setPrimaryEmail(req, res)

      expect(res.status).toHaveBeenCalledWith(500)
      expect(res.json).toHaveBeenCalledWith({
        error: 'failed_to_set_primary_email',
      })
    })
  })
})
