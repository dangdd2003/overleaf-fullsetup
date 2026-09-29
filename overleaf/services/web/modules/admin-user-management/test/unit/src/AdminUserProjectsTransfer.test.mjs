import { describe, it, expect, vi, beforeEach } from 'vitest'
import OwnershipTransferHandler from '../../../../../app/src/Features/Collaborators/OwnershipTransferHandler.mjs'
import SessionManager from '../../../../../app/src/Features/Authentication/SessionManager.mjs'
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

vi.mock('../../../../../app/src/Features/Collaborators/OwnershipTransferHandler.mjs', () => ({
  default: {
    promises: {
      transferOwnership: vi.fn(),
      transferAllProjectsToUser: vi.fn(),
    },
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

vi.mock('../../../../../app/src/Features/Helpers/EmailHelper.mjs', () => ({
  default: {
    parseEmail: vi.fn(email => email),
  },
}))

vi.mock('../../../app/src/AdminUserRestorer.mjs', () => ({
  restoreUserAndProjects: vi.fn(),
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

import AdminUserManagementController from '../../../app/src/AdminUserManagementController.mjs'

describe('AdminUserProjectsTransfer Controller', () => {
  const fromUserId = '507f1f77bcf86cd799439011'
  const toUserId = '507f1f77bcf86cd799439022'
  const projectId = '507f1f77bcf86cd799439033'
  const adminCallerId = '507f1f77bcf86cd799439044'

  let req
  let res

  beforeEach(() => {
    vi.clearAllMocks()

    SessionManager.getLoggedInUserId.mockReturnValue(adminCallerId)

    req = {
      params: {
        userId: fromUserId,
        projectId,
      },
      body: {
        newOwnerId: toUserId,
      },
      session: {},
      ip: '127.0.0.1',
    }

    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    }
  })

  describe('transferProject', () => {
    it('rejects self-transfer (400 cannot_transfer_to_self)', async () => {
      req.body.newOwnerId = fromUserId

      await AdminUserManagementController.transferProject(req, res)

      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith({ error: 'cannot_transfer_to_self' })
      expect(OwnershipTransferHandler.promises.transferOwnership).not.toHaveBeenCalled()
    })

    it('rejects invalid userId (400)', async () => {
      req.params.userId = 'invalid-user-id'

      await AdminUserManagementController.transferProject(req, res)

      expect(res.status).toHaveBeenCalledWith(400)
      expect(OwnershipTransferHandler.promises.transferOwnership).not.toHaveBeenCalled()
    })

    it('rejects invalid projectId (400)', async () => {
      req.params.projectId = 'invalid-proj-id'

      await AdminUserManagementController.transferProject(req, res)

      expect(res.status).toHaveBeenCalledWith(400)
      expect(OwnershipTransferHandler.promises.transferOwnership).not.toHaveBeenCalled()
    })

    it('rejects invalid destination user ID (400)', async () => {
      req.body.newOwnerId = 'invalid-new-owner-id'

      await AdminUserManagementController.transferProject(req, res)

      expect(res.status).toHaveBeenCalledWith(400)
      expect(OwnershipTransferHandler.promises.transferOwnership).not.toHaveBeenCalled()
    })

    it('returns 404 when destination user is not found', async () => {
      getUserById.mockResolvedValue(null)

      await AdminUserManagementController.transferProject(req, res)

      expect(res.status).toHaveBeenCalledWith(404)
      expect(res.json).toHaveBeenCalledWith({ error: 'user_not_found' })
      expect(OwnershipTransferHandler.promises.transferOwnership).not.toHaveBeenCalled()
    })

    it('calls OwnershipTransferHandler.promises.transferOwnership and returns { success: true, projectId, newOwnerId }', async () => {
      getUserById.mockResolvedValue({
        _id: toUserId,
        email: 'dest@example.com',
      })
      OwnershipTransferHandler.promises.transferOwnership.mockResolvedValue()

      await AdminUserManagementController.transferProject(req, res)

      expect(OwnershipTransferHandler.promises.transferOwnership).toHaveBeenCalledWith(
        projectId,
        toUserId,
        {
          fromUserId,
          allowTransferToNonCollaborators: true,
          ipAddress: '127.0.0.1',
        }
      )
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        projectId,
        newOwnerId: toUserId,
      })
    })

    it('supports toUserId in body as fallback for newOwnerId', async () => {
      req.body = { toUserId }
      getUserById.mockResolvedValue({
        _id: toUserId,
        email: 'dest@example.com',
      })
      OwnershipTransferHandler.promises.transferOwnership.mockResolvedValue()

      await AdminUserManagementController.transferProject(req, res)

      expect(OwnershipTransferHandler.promises.transferOwnership).toHaveBeenCalledWith(
        projectId,
        toUserId,
        {
          fromUserId,
          allowTransferToNonCollaborators: true,
          ipAddress: '127.0.0.1',
        }
      )
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        projectId,
        newOwnerId: toUserId,
      })
    })

    it('returns 500 when OwnershipTransferHandler.promises.transferOwnership throws an unexpected error', async () => {
      getUserById.mockResolvedValue({
        _id: toUserId,
        email: 'dest@example.com',
      })
      OwnershipTransferHandler.promises.transferOwnership.mockRejectedValue(
        new Error('Database transfer failure')
      )

      await AdminUserManagementController.transferProject(req, res)

      expect(res.status).toHaveBeenCalledWith(500)
      expect(res.json).toHaveBeenCalledWith({ error: 'failed_to_transfer_project' })
    })
  })

  describe('transferAllProjects', () => {
    beforeEach(() => {
      req.body = {
        toUserId,
      }
    })

    it('rejects self-transfer (400 cannot_transfer_to_self)', async () => {
      req.body.toUserId = fromUserId

      await AdminUserManagementController.transferAllProjects(req, res)

      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith({ error: 'cannot_transfer_to_self' })
      expect(OwnershipTransferHandler.promises.transferAllProjectsToUser).not.toHaveBeenCalled()
    })

    it('rejects invalid userId (400)', async () => {
      req.params.userId = 'invalid-id'

      await AdminUserManagementController.transferAllProjects(req, res)

      expect(res.status).toHaveBeenCalledWith(400)
      expect(OwnershipTransferHandler.promises.transferAllProjectsToUser).not.toHaveBeenCalled()
    })

    it('rejects invalid toUserId (400)', async () => {
      req.body.toUserId = 'invalid-to-id'

      await AdminUserManagementController.transferAllProjects(req, res)

      expect(res.status).toHaveBeenCalledWith(400)
      expect(OwnershipTransferHandler.promises.transferAllProjectsToUser).not.toHaveBeenCalled()
    })

    it('returns 404 when destination user is not found', async () => {
      getUserById.mockResolvedValue(null)

      await AdminUserManagementController.transferAllProjects(req, res)

      expect(res.status).toHaveBeenCalledWith(404)
      expect(res.json).toHaveBeenCalledWith({ error: 'user_not_found' })
      expect(OwnershipTransferHandler.promises.transferAllProjectsToUser).not.toHaveBeenCalled()
    })

    it('calls OwnershipTransferHandler.promises.transferAllProjectsToUser and returns { success: true, transferredCount, newTagName }', async () => {
      getUserById.mockResolvedValue({
        _id: toUserId,
        email: 'dest@example.com',
      })
      OwnershipTransferHandler.promises.transferAllProjectsToUser.mockResolvedValue({
        projectCount: 5,
        newTagName: 'transferred-from-src@example.com',
      })

      await AdminUserManagementController.transferAllProjects(req, res)

      expect(OwnershipTransferHandler.promises.transferAllProjectsToUser).toHaveBeenCalledWith({
        fromUserId,
        toUserId,
        ipAddress: '127.0.0.1',
      })
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        transferredCount: 5,
        newTagName: 'transferred-from-src@example.com',
      })
    })

    it('supports newOwnerId in body as fallback for toUserId', async () => {
      req.body = { newOwnerId: toUserId }
      getUserById.mockResolvedValue({
        _id: toUserId,
        email: 'dest@example.com',
      })
      OwnershipTransferHandler.promises.transferAllProjectsToUser.mockResolvedValue({
        projectCount: 3,
        newTagName: 'transferred-from-src@example.com',
      })

      await AdminUserManagementController.transferAllProjects(req, res)

      expect(OwnershipTransferHandler.promises.transferAllProjectsToUser).toHaveBeenCalledWith({
        fromUserId,
        toUserId,
        ipAddress: '127.0.0.1',
      })
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        transferredCount: 3,
        newTagName: 'transferred-from-src@example.com',
      })
    })

    it('returns 500 when OwnershipTransferHandler.promises.transferAllProjectsToUser throws an error', async () => {
      getUserById.mockResolvedValue({
        _id: toUserId,
        email: 'dest@example.com',
      })
      OwnershipTransferHandler.promises.transferAllProjectsToUser.mockRejectedValue(
        new Error('Bulk transfer failed')
      )

      await AdminUserManagementController.transferAllProjects(req, res)

      expect(res.status).toHaveBeenCalledWith(500)
      expect(res.json).toHaveBeenCalledWith({ error: 'failed_to_transfer_projects' })
    })
  })
})
