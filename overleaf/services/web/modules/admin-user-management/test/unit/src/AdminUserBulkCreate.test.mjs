import { describe, it, expect, vi, beforeEach } from 'vitest'
import SessionManager from '../../../../../app/src/Features/Authentication/SessionManager.mjs'
import UserGetter from '../../../../../app/src/Features/User/UserGetter.mjs'
import UserCreator from '../../../../../app/src/Features/User/UserCreator.mjs'
import AuthenticationManager from '../../../../../app/src/Features/Authentication/AuthenticationManager.mjs'
import OneTimeTokenHandler from '../../../../../app/src/Features/Security/OneTimeTokenHandler.mjs'
import UserAuditLogHandler from '../../../../../app/src/Features/User/UserAuditLogHandler.mjs'
import { User } from '../../../../../app/src/models/User.mjs'
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
    createNewUser: vi.fn(),
  },
}))

vi.mock('../../../../../app/src/Features/Authentication/AuthenticationManager.mjs', () => {
  const hashPassword = vi.fn()
  return {
    default: {
      hashPassword,
      promises: {
        hashPassword,
      },
    },
  }
})

vi.mock('../../../../../app/src/Features/Security/OneTimeTokenHandler.mjs', () => ({
  default: {
    promises: {
      getNewToken: vi.fn(),
    },
    getNewToken: vi.fn(),
  },
}))

vi.mock('../../../../../app/src/Features/User/UserAuditLogHandler.mjs', () => ({
  default: {
    promises: {
      addEntry: vi.fn(),
    },
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

describe('AdminUserBulkCreate Controller', () => {
  const adminCallerId = '507f1f77bcf86cd799439099'
  let req
  let res

  beforeEach(() => {
    vi.clearAllMocks()

    SessionManager.getLoggedInUserId.mockReturnValue(adminCallerId)

    req = {
      body: {},
      session: {},
      ip: '192.168.1.50',
    }

    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    }
  })

  describe('bulkCreateUsers', () => {
    it('returns 400 if users payload is not an array', async () => {
      req.body.users = 'not-an-array'

      await AdminUserManagementController.bulkCreateUsers(req, res)

      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith({ error: 'invalid_users_array' })
      expect(UserCreator.promises.createNewUser).not.toHaveBeenCalled()
    })

    it('returns 400 if users payload is an empty array', async () => {
      req.body.users = []

      await AdminUserManagementController.bulkCreateUsers(req, res)

      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith({ error: 'invalid_users_array' })
      expect(UserCreator.promises.createNewUser).not.toHaveBeenCalled()
    })

    it('creates user with explicit password, hashes password and marks passwordSet: true', async () => {
      const mockCreatedUser = {
        _id: new ObjectId('507f1f77bcf86cd799439001'),
        email: 'alice@example.com',
        first_name: 'Alice',
        last_name: 'Smith',
        isAdmin: true,
      }

      UserGetter.promises.getUserByAnyEmail.mockResolvedValue(null)
      UserCreator.promises.createNewUser.mockResolvedValue(mockCreatedUser)
      AuthenticationManager.hashPassword.mockResolvedValue('bcrypt-hashed-pass')
      User.updateOne.mockResolvedValue({ acknowledged: true })

      req.body.users = [
        {
          email: 'alice@example.com',
          first_name: 'Alice',
          last_name: 'Smith',
          password: 'SecurePassword123!',
          isAdmin: true,
        },
      ]

      await AdminUserManagementController.bulkCreateUsers(req, res)

      expect(UserGetter.promises.getUserByAnyEmail).toHaveBeenCalledWith(
        'alice@example.com'
      )
      expect(UserCreator.promises.createNewUser).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'alice@example.com',
          first_name: 'Alice',
          last_name: 'Smith',
          isAdmin: true,
          holdingAccount: false,
        }),
        {}
      )
      expect(AuthenticationManager.hashPassword).toHaveBeenCalledWith(
        'SecurePassword123!'
      )
      expect(User.updateOne).toHaveBeenCalledWith(
        { _id: mockCreatedUser._id },
        {
          $set: {
            hashedPassword: 'bcrypt-hashed-pass',
            holdingAccount: false,
            loginCount: 0,
          },
        }
      )
      expect(OneTimeTokenHandler.promises.getNewToken).not.toHaveBeenCalled()
      expect(UserAuditLogHandler.promises.addEntry).toHaveBeenCalledWith(
        mockCreatedUser._id,
        'admin-register',
        adminCallerId,
        '192.168.1.50',
        { isAdmin: true, passwordSet: true }
      )
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        summary: {
          total: 1,
          createdCount: 1,
          skippedCount: 0,
          failedCount: 0,
        },
        created: [
          {
            _id: '507f1f77bcf86cd799439001',
            email: 'alice@example.com',
            first_name: 'Alice',
            last_name: 'Smith',
            isAdmin: true,
            passwordSet: true,
            setupUrl: null,
          },
        ],
        skipped: [],
        failed: [],
      })
    })

    it('creates user without password, generates 7-day one-time token and setupUrl', async () => {
      const mockCreatedUser = {
        _id: new ObjectId('507f1f77bcf86cd799439002'),
        email: 'bob@example.com',
        first_name: 'Bob',
        last_name: 'Jones',
        isAdmin: false,
      }

      UserGetter.promises.getUserByAnyEmail.mockResolvedValue(null)
      UserCreator.promises.createNewUser.mockResolvedValue(mockCreatedUser)
      OneTimeTokenHandler.promises.getNewToken.mockResolvedValue('token-xyz-123')

      req.body.users = [
        {
          email: 'bob@example.com',
          first_name: 'Bob',
          last_name: 'Jones',
          password: '',
          isAdmin: false,
        },
      ]

      await AdminUserManagementController.bulkCreateUsers(req, res)

      expect(AuthenticationManager.hashPassword).not.toHaveBeenCalled()
      expect(OneTimeTokenHandler.promises.getNewToken).toHaveBeenCalledWith(
        'password',
        mockCreatedUser._id,
        { expiresIn: 7 * 24 * 60 * 60 }
      )
      expect(UserAuditLogHandler.promises.addEntry).toHaveBeenCalledWith(
        mockCreatedUser._id,
        'admin-register',
        adminCallerId,
        '192.168.1.50',
        { isAdmin: false, passwordSet: false }
      )
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        summary: {
          total: 1,
          createdCount: 1,
          skippedCount: 0,
          failedCount: 0,
        },
        created: [
          {
            _id: '507f1f77bcf86cd799439002',
            email: 'bob@example.com',
            first_name: 'Bob',
            last_name: 'Jones',
            isAdmin: false,
            passwordSet: false,
            setupUrl:
              'https://overleaf.example.com/user/password/set?token=token-xyz-123',
          },
        ],
        skipped: [],
        failed: [],
      })
    })

    it('handles duplicate emails by skipping row without throwing error', async () => {
      UserGetter.promises.getUserByAnyEmail.mockResolvedValue({
        _id: 'existing-user-id',
        email: 'existing@example.com',
      })

      req.body.users = [
        {
          email: 'existing@example.com',
          first_name: 'Existing',
          last_name: 'User',
          password: '',
          isAdmin: false,
        },
      ]

      await AdminUserManagementController.bulkCreateUsers(req, res)

      expect(UserCreator.promises.createNewUser).not.toHaveBeenCalled()
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        summary: {
          total: 1,
          createdCount: 0,
          skippedCount: 1,
          failedCount: 0,
        },
        created: [],
        skipped: [
          {
            email: 'existing@example.com',
            reason: 'email_already_exists',
          },
        ],
        failed: [],
      })
    })

    it('handles invalid email syntax by appending to failed without stopping batch', async () => {
      req.body.users = [
        {
          email: 'not-an-email',
          first_name: 'Bad',
          last_name: 'Email',
          password: 'Pass',
          isAdmin: false,
        },
      ]

      await AdminUserManagementController.bulkCreateUsers(req, res)

      expect(UserGetter.promises.getUserByAnyEmail).not.toHaveBeenCalled()
      expect(UserCreator.promises.createNewUser).not.toHaveBeenCalled()
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        summary: {
          total: 1,
          createdCount: 0,
          skippedCount: 0,
          failedCount: 1,
        },
        created: [],
        skipped: [],
        failed: [
          {
            email: 'not-an-email',
            reason: 'invalid_email',
          },
        ],
      })
    })

    it('processes mixed batch correctly (valid with pass, valid without pass, duplicate, invalid)', async () => {
      const userWithPass = {
        _id: new ObjectId('507f1f77bcf86cd799439010'),
        email: 'valid1@example.com',
        first_name: 'User1',
        last_name: 'One',
        isAdmin: true,
      }
      const userWithoutPass = {
        _id: new ObjectId('507f1f77bcf86cd799439020'),
        email: 'valid2@example.com',
        first_name: 'User2',
        last_name: 'Two',
        isAdmin: false,
      }

      UserGetter.promises.getUserByAnyEmail.mockImplementation(async email => {
        if (email === 'duplicate@example.com') {
          return { _id: 'dup-id', email }
        }
        return null
      })

      UserCreator.promises.createNewUser.mockImplementation(async details => {
        if (details.email === 'valid1@example.com') return userWithPass
        if (details.email === 'valid2@example.com') return userWithoutPass
      })

      AuthenticationManager.hashPassword.mockResolvedValue('hash123')
      OneTimeTokenHandler.promises.getNewToken.mockResolvedValue('tok456')
      User.updateOne.mockResolvedValue({ acknowledged: true })

      req.body.users = [
        {
          email: 'valid1@example.com',
          first_name: 'User1',
          last_name: 'One',
          password: 'SecretPassword!',
          isAdmin: true,
        },
        {
          email: 'invalid-email-entry',
          first_name: 'Bad',
          last_name: 'User',
          password: 'pwd',
        },
        {
          email: 'duplicate@example.com',
          first_name: 'Dup',
          last_name: 'User',
          password: '',
        },
        {
          email: 'valid2@example.com',
          first_name: 'User2',
          last_name: 'Two',
          password: '',
          isAdmin: false,
        },
      ]

      await AdminUserManagementController.bulkCreateUsers(req, res)

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        summary: {
          total: 4,
          createdCount: 2,
          skippedCount: 1,
          failedCount: 1,
        },
        created: [
          {
            _id: '507f1f77bcf86cd799439010',
            email: 'valid1@example.com',
            first_name: 'User1',
            last_name: 'One',
            isAdmin: true,
            passwordSet: true,
            setupUrl: null,
          },
          {
            _id: '507f1f77bcf86cd799439020',
            email: 'valid2@example.com',
            first_name: 'User2',
            last_name: 'Two',
            isAdmin: false,
            passwordSet: false,
            setupUrl:
              'https://overleaf.example.com/user/password/set?token=tok456',
          },
        ],
        skipped: [
          {
            email: 'duplicate@example.com',
            reason: 'email_already_exists',
          },
        ],
        failed: [
          {
            email: 'invalid-email-entry',
            reason: 'invalid_email',
          },
        ],
      })
    })

    it('returns 500 when an unexpected server error occurs', async () => {
      UserGetter.promises.getUserByAnyEmail.mockRejectedValue(
        new Error('Unexpected DB fatal error')
      )

      req.body.users = [
        {
          email: 'user@example.com',
          first_name: 'Test',
          last_name: 'User',
        },
      ]

      await AdminUserManagementController.bulkCreateUsers(req, res)

      expect(res.status).toHaveBeenCalledWith(500)
      expect(res.json).toHaveBeenCalledWith({
        error: 'failed_to_bulk_create_users',
      })
    })
  })
})
