import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Project } from '../../../../../app/src/models/Project.mjs'
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

describe('AdminUserProjectsQuery Controller', () => {
  const validUserId = '507f1f77bcf86cd799439011'
  let req
  let res

  beforeEach(() => {
    vi.clearAllMocks()

    req = {
      params: { userId: validUserId },
      query: {},
      session: {},
      ip: '127.0.0.1',
    }

    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    }
  })

  describe('getUserProjects', () => {
    it('returns 400 if userId is not a valid ObjectId', async () => {
      req.params.userId = 'invalid-id'

      await AdminUserManagementController.getUserProjects(req, res)

      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith({ error: 'invalid_user_id' })
      expect(Project.find).not.toHaveBeenCalled()
    })

    it('returns paginated projects for user with defaults', async () => {
      const mockProjects = [
        {
          _id: { toString: () => 'proj1' },
          name: 'Quantum Draft',
          lastUpdated: new Date('2026-08-29T10:00:00Z'),
          collaberator_refs: ['user2', 'user3'],
          readOnly_refs: ['user4'],
          publicAccesLevel: 'tokenBased',
        },
      ]

      const mockLimit = vi.fn().mockResolvedValue(mockProjects)
      const mockSkip = vi.fn().mockReturnValue({ limit: mockLimit })
      const mockSort = vi.fn().mockReturnValue({ skip: mockSkip })
      Project.find.mockReturnValue({ sort: mockSort })
      Project.countDocuments.mockResolvedValue(1)

      req.query = { page: '1', limit: '10' }

      await AdminUserManagementController.getUserProjects(req, res)

      expect(Project.find).toHaveBeenCalledWith(
        {
          owner_ref: expect.any(ObjectId),
          archived: { $ne: true },
        },
        {
          name: 1,
          lastUpdated: 1,
          collaberator_refs: 1,
          readOnly_refs: 1,
          publicAccesLevel: 1,
        }
      )
      expect(mockSort).toHaveBeenCalledWith({ lastUpdated: -1 })
      expect(mockSkip).toHaveBeenCalledWith(0)
      expect(mockLimit).toHaveBeenCalledWith(10)
      expect(res.json).toHaveBeenCalledWith({
        projects: [
          {
            _id: 'proj1',
            name: 'Quantum Draft',
            lastUpdated: new Date('2026-08-29T10:00:00Z'),
            collaboratorCount: 3,
            accessLevel: 'tokenBased',
          },
        ],
        total: 1,
        page: 1,
        totalPages: 1,
      })
    })

    it('supports search query by escaping regex and matching project name', async () => {
      const mockLimit = vi.fn().mockResolvedValue([])
      const mockSkip = vi.fn().mockReturnValue({ limit: mockLimit })
      const mockSort = vi.fn().mockReturnValue({ skip: mockSkip })
      Project.find.mockReturnValue({ sort: mockSort })
      Project.countDocuments.mockResolvedValue(0)

      req.query = { search: 'quantum.*+?^${}()|[]\\' }

      await AdminUserManagementController.getUserProjects(req, res)

      const findQuery = Project.find.mock.calls[0][0]
      expect(findQuery.name).toBeInstanceOf(RegExp)
      expect(findQuery.name.source).toBe('quantum\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\')
      expect(findQuery.name.flags).toBe('i')
    })

    it('supports sort by name and asc order', async () => {
      const mockLimit = vi.fn().mockResolvedValue([])
      const mockSkip = vi.fn().mockReturnValue({ limit: mockLimit })
      const mockSort = vi.fn().mockReturnValue({ skip: mockSkip })
      Project.find.mockReturnValue({ sort: mockSort })
      Project.countDocuments.mockResolvedValue(0)

      req.query = { sort: 'name', order: 'asc', page: '2', limit: '5' }

      await AdminUserManagementController.getUserProjects(req, res)

      expect(mockSort).toHaveBeenCalledWith({ name: 1 })
      expect(mockSkip).toHaveBeenCalledWith(5)
      expect(mockLimit).toHaveBeenCalledWith(5)
      expect(res.json).toHaveBeenCalledWith({
        projects: [],
        total: 0,
        page: 2,
        totalPages: 1,
      })
    })

    it('handles fallback defaults for untitled projects and null lastUpdated', async () => {
      const mockProjects = [
        {
          _id: { toString: () => 'proj2' },
          name: '',
          lastUpdated: null,
          collaberator_refs: null,
          readOnly_refs: null,
          publicAccesLevel: null,
        },
      ]

      const mockLimit = vi.fn().mockResolvedValue(mockProjects)
      const mockSkip = vi.fn().mockReturnValue({ limit: mockLimit })
      const mockSort = vi.fn().mockReturnValue({ skip: mockSkip })
      Project.find.mockReturnValue({ sort: mockSort })
      Project.countDocuments.mockResolvedValue(1)

      await AdminUserManagementController.getUserProjects(req, res)

      expect(res.json).toHaveBeenCalledWith({
        projects: [
          {
            _id: 'proj2',
            name: 'Untitled Project',
            lastUpdated: null,
            collaboratorCount: 0,
            accessLevel: 'private',
          },
        ],
        total: 1,
        page: 1,
        totalPages: 1,
      })
    })

    it('returns 500 when Project.find fails', async () => {
      Project.find.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          skip: vi.fn().mockReturnValue({
            limit: vi.fn().mockRejectedValue(new Error('DB error')),
          }),
        }),
      })
      Project.countDocuments.mockResolvedValue(0)

      await AdminUserManagementController.getUserProjects(req, res)

      expect(res.status).toHaveBeenCalledWith(500)
      expect(res.json).toHaveBeenCalledWith({ error: 'failed_to_get_projects' })
    })
  })

  describe('searchUsers', () => {
    it('returns empty users array if query is empty or missing', async () => {
      req.query = { query: '   ' }

      await AdminUserManagementController.searchUsers(req, res)

      expect(res.json).toHaveBeenCalledWith({ users: [] })
      expect(User.find).not.toHaveBeenCalled()
    })

    it('searches users by email, first_name, and last_name ignoring holding accounts', async () => {
      const mockUsers = [
        {
          _id: 'user2',
          email: 'alex@example.com',
          first_name: 'Alex',
          last_name: 'Smith',
          isAdmin: false,
        },
      ]

      const mockLimit = vi.fn().mockResolvedValue(mockUsers)
      User.find.mockReturnValue({ limit: mockLimit })

      req.query = { query: 'alex' }

      await AdminUserManagementController.searchUsers(req, res)

      expect(User.find).toHaveBeenCalledWith(
        {
          $or: [
            { email: expect.any(RegExp) },
            { first_name: expect.any(RegExp) },
            { last_name: expect.any(RegExp) },
          ],
          holdingAccount: { $ne: true },
        },
        {
          _id: 1,
          email: 1,
          first_name: 1,
          last_name: 1,
          isAdmin: 1,
        }
      )
      expect(mockLimit).toHaveBeenCalledWith(5)
      expect(res.json).toHaveBeenCalledWith({ users: mockUsers })
    })

    it('returns 500 when User.find fails', async () => {
      User.find.mockReturnValue({
        limit: vi.fn().mockRejectedValue(new Error('DB search error')),
      })

      req.query = { query: 'alex' }

      await AdminUserManagementController.searchUsers(req, res)

      expect(res.status).toHaveBeenCalledWith(500)
      expect(res.json).toHaveBeenCalledWith({ error: 'failed_to_search_users' })
    })
  })
})
