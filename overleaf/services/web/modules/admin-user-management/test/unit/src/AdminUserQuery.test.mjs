import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  getActiveUsers,
  getDeletedUsers,
  getUserById,
  USER_ADMIN_LIST_PROJECTION,
  DELETED_USER_ADMIN_LIST_PROJECTION,
  USER_DETAIL_PROJECTION,
} from '../../../app/src/AdminUserQuery.mjs'
import { db, ObjectId } from '../../../../../app/src/infrastructure/mongodb.mjs'

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
      },
      deletedUsers: {
        find: vi.fn(),
        countDocuments: vi.fn(),
      },
    },
  }
})

describe('AdminUserQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Projections Whitelist', () => {
    it('does not include sensitive fields in USER_ADMIN_LIST_PROJECTION', () => {
      expect(USER_ADMIN_LIST_PROJECTION.hashedPassword).toBeUndefined()
      expect(USER_ADMIN_LIST_PROJECTION.twoFactorAuthentication).toBeUndefined()
      expect(USER_ADMIN_LIST_PROJECTION.refProviders).toBeUndefined()
      expect(USER_ADMIN_LIST_PROJECTION.auth_token).toBeUndefined()
      expect(USER_ADMIN_LIST_PROJECTION.email).toBe(1)
      expect(USER_ADMIN_LIST_PROJECTION.first_name).toBe(1)
      expect(USER_ADMIN_LIST_PROJECTION.last_name).toBe(1)
      expect(USER_ADMIN_LIST_PROJECTION.isAdmin).toBe(1)
    })

    it('does not include sensitive fields in DELETED_USER_ADMIN_LIST_PROJECTION', () => {
      expect(DELETED_USER_ADMIN_LIST_PROJECTION['user.hashedPassword']).toBeUndefined()
      expect(DELETED_USER_ADMIN_LIST_PROJECTION.deleterData).toBe(1)
      expect(DELETED_USER_ADMIN_LIST_PROJECTION['user.email']).toBe(1)
    })

    it('does not include sensitive fields in USER_DETAIL_PROJECTION', () => {
      expect(USER_DETAIL_PROJECTION.hashedPassword).toBeUndefined()
      expect(USER_DETAIL_PROJECTION.twoFactorAuthentication).toBeUndefined()
      expect(USER_DETAIL_PROJECTION.features).toBe(1)
    })
  })

  describe('getActiveUsers', () => {
    it('escapes regex search strings to avoid ReDoS and searches across fields', async () => {
      const mockToArray = vi.fn().mockResolvedValue([{ _id: '1', email: 'test@example.com' }])
      const mockLimit = vi.fn().mockReturnValue({ toArray: mockToArray })
      const mockSkip = vi.fn().mockReturnValue({ limit: mockLimit })
      const mockSort = vi.fn().mockReturnValue({ skip: mockSkip })
      db.users.find.mockReturnValue({ sort: mockSort })
      db.users.countDocuments.mockResolvedValue(1)

      const result = await getActiveUsers({
        search: 'test.*+?^${}()|[]\\',
        page: 1,
        limit: 20,
      })

      expect(db.users.find).toHaveBeenCalled()
      const query = db.users.find.mock.calls[0][0]
      expect(query.$or).toBeDefined()
      expect(query.$or.length).toBe(4) // email, first_name, last_name, emails.email
      expect(result.total).toBe(1)
      expect(result.totalPages).toBe(1)
      expect(result.page).toBe(1)
      expect(result.limit).toBe(20)
    })

    it('supports searching by valid MongoDB ObjectId', async () => {
      const validId = new ObjectId().toString()
      const mockToArray = vi.fn().mockResolvedValue([])
      const mockLimit = vi.fn().mockReturnValue({ toArray: mockToArray })
      const mockSkip = vi.fn().mockReturnValue({ limit: mockLimit })
      const mockSort = vi.fn().mockReturnValue({ skip: mockSkip })
      db.users.find.mockReturnValue({ sort: mockSort })
      db.users.countDocuments.mockResolvedValue(0)

      await getActiveUsers({ search: validId })

      const query = db.users.find.mock.calls[0][0]
      expect(query.$or.some(c => c._id && c._id.toString() === validId)).toBe(true)
    })

    it('clamps pagination parameters within safe ranges', async () => {
      const mockToArray = vi.fn().mockResolvedValue([])
      const mockLimit = vi.fn().mockReturnValue({ toArray: mockToArray })
      const mockSkip = vi.fn().mockReturnValue({ limit: mockLimit })
      const mockSort = vi.fn().mockReturnValue({ skip: mockSkip })
      db.users.find.mockReturnValue({ sort: mockSort })
      db.users.countDocuments.mockResolvedValue(100)

      const result = await getActiveUsers({ page: -5, limit: 500 })

      expect(result.page).toBe(1)
      expect(result.limit).toBe(100) // capped at 100
      expect(mockSkip).toHaveBeenCalledWith(0)
      expect(mockLimit).toHaveBeenCalledWith(100)
    })
  })

  describe('getDeletedUsers', () => {
    it('queries deletedUsers collection with deleterData.deletedAt sorting', async () => {
      const mockToArray = vi.fn().mockResolvedValue([{ _id: 'del-1', deleterData: { deletedAt: new Date() } }])
      const mockLimit = vi.fn().mockReturnValue({ toArray: mockToArray })
      const mockSkip = vi.fn().mockReturnValue({ limit: mockLimit })
      const mockSort = vi.fn().mockReturnValue({ skip: mockSkip })
      db.deletedUsers.find.mockReturnValue({ sort: mockSort })
      db.deletedUsers.countDocuments.mockResolvedValue(1)

      const result = await getDeletedUsers({ search: 'alice', page: 1, limit: 10 })

      expect(db.deletedUsers.find).toHaveBeenCalled()
      expect(mockSort).toHaveBeenCalledWith({ 'deleterData.deletedAt': -1, _id: -1 })
      expect(result.deletedUsers.length).toBe(1)
      expect(result.total).toBe(1)
    })
  })

  describe('getUserById', () => {
    it('returns null if userId is not a valid ObjectId', async () => {
      const result = await getUserById('invalid-id')
      expect(result).toBeNull()
      expect(db.users.findOne).not.toHaveBeenCalled()
    })

    it('finds user with USER_DETAIL_PROJECTION when id is valid', async () => {
      const validId = new ObjectId().toString()
      db.users.findOne.mockResolvedValue({ _id: validId, email: 'user@example.com' })

      const result = await getUserById(validId)
      expect(result).toEqual({ _id: validId, email: 'user@example.com', lastActive: null })
      expect(db.users.findOne).toHaveBeenCalledWith(
        { _id: new ObjectId(validId) },
        { projection: USER_DETAIL_PROJECTION }
      )
    })

    it('normalizes lastLoggedIn to lastActive when lastActive is not present', async () => {
      const validId = new ObjectId().toString()
      const loginDate = new Date('2026-08-29T10:00:00Z')
      db.users.findOne.mockResolvedValue({ _id: validId, email: 'user@example.com', lastLoggedIn: loginDate })

      const result = await getUserById(validId)
      expect(result.lastActive).toEqual(loginDate)
    })
  })
})
