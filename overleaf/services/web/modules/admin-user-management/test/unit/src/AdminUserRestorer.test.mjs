import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  restoreUserAndProjects,
  purgeDeletedUser,
} from '../../../app/src/AdminUserRestorer.mjs'
import {
  NotFoundError,
  ConflictError,
} from '../../../app/src/AdminUserGuards.mjs'
import { db, ObjectId } from '../../../../../app/src/infrastructure/mongodb.mjs'
import UserGetter from '../../../../../app/src/Features/User/UserGetter.mjs'
import ProjectDeleter from '../../../../../app/src/Features/Project/ProjectDeleter.mjs'
import UserAuditLogHandler from '../../../../../app/src/Features/User/UserAuditLogHandler.mjs'
import { DeletedUser } from '../../../../../app/src/models/DeletedUser.mjs'
import { DeletedProject } from '../../../../../app/src/models/DeletedProject.mjs'
import { User } from '../../../../../app/src/models/User.mjs'

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
        insertOne: vi.fn(),
      },
    },
  }
})

vi.mock('../../../../../app/src/Features/User/UserGetter.mjs', () => ({
  default: {
    promises: {
      getUserByAnyEmail: vi.fn(),
    },
  },
}))

vi.mock('../../../../../app/src/Features/Project/ProjectDeleter.mjs', () => ({
  default: {
    promises: {
      undeleteProject: vi.fn(),
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

vi.mock('../../../../../app/src/models/DeletedUser.mjs', () => ({
  DeletedUser: {
    findOne: vi.fn(),
    deleteOne: vi.fn(),
  },
}))

vi.mock('../../../../../app/src/models/DeletedProject.mjs', () => ({
  DeletedProject: {
    find: vi.fn(),
    deleteMany: vi.fn(),
  },
}))

vi.mock('../../../../../app/src/models/User.mjs', () => {
  return {
    User: function (doc) {
      Object.assign(this, doc)
    },
  }
})

describe('AdminUserRestorer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('throws NotFoundError if deleted user is not found or has expired PII', async () => {
    DeletedUser.findOne.mockReturnValue({
      exec: vi.fn().mockResolvedValue(null),
    })

    const validId = '507f1f77bcf86cd799439011'
    await expect(
      restoreUserAndProjects(validId, 'admin-1', '127.0.0.1')
    ).rejects.toThrow(NotFoundError)
  })

  it('throws ConflictError if the primary email is already registered to an active user', async () => {
    const validId = '507f1f77bcf86cd799439011'
    DeletedUser.findOne.mockReturnValue({
      exec: vi.fn().mockResolvedValue({
        _id: 'del-doc-1',
        user: { email: 'alice@example.com', emails: [] },
      }),
    })
    UserGetter.promises.getUserByAnyEmail.mockResolvedValue({ _id: 'active-user-2' })

    await expect(
      restoreUserAndProjects(validId, 'admin-1', '127.0.0.1')
    ).rejects.toThrow(ConflictError)
  })

  it('restores user document and all soft-deleted projects', async () => {
    const validId = '507f1f77bcf86cd799439011'
    const mockDeletedUser = {
      _id: 'del-doc-1',
      user: {
        _id: validId,
        email: 'alice@example.com',
        first_name: 'Alice',
        hashedPassword: 'hashed-secret',
        emails: [{ email: 'alice.alt@example.com' }],
      },
    }

    DeletedUser.findOne.mockReturnValue({
      exec: vi.fn().mockResolvedValue(mockDeletedUser),
    })
    DeletedUser.deleteOne.mockReturnValue({
      exec: vi.fn().mockResolvedValue({ deletedCount: 1 }),
    })
    UserGetter.promises.getUserByAnyEmail.mockResolvedValue(null)

    const mockProjects = [
      { deleterData: { deletedProjectId: 'proj-1' } },
      { deleterData: { deletedProjectId: 'proj-2' } },
    ]
    DeletedProject.find.mockReturnValue({
      exec: vi.fn().mockResolvedValue(mockProjects),
    })
    ProjectDeleter.promises.undeleteProject.mockResolvedValue(true)
    UserAuditLogHandler.promises.addEntry.mockResolvedValue(true)

    const result = await restoreUserAndProjects(validId, 'admin-1', '127.0.0.1')

    expect(db.users.insertOne).toHaveBeenCalled()
    expect(DeletedUser.deleteOne).toHaveBeenCalledWith({ _id: 'del-doc-1' })
    expect(ProjectDeleter.promises.undeleteProject).toHaveBeenCalledWith('proj-1')
    expect(ProjectDeleter.promises.undeleteProject).toHaveBeenCalledWith('proj-2')
    expect(UserAuditLogHandler.promises.addEntry).toHaveBeenCalledWith(
      expect.anything(),
      'admin-restore-user',
      'admin-1',
      '127.0.0.1',
      { restoredProjectCount: 2 }
    )
    expect(result.restoredProjectCount).toBe(2)
  })

  describe('purgeDeletedUser', () => {
    it('throws NotFoundError if deleted user is not found', async () => {
      DeletedUser.findOne.mockReturnValue({
        exec: vi.fn().mockResolvedValue(null),
      })

      const validId = '507f1f77bcf86cd799439011'
      await expect(
        purgeDeletedUser(validId, 'admin-1', '127.0.0.1')
      ).rejects.toThrow(NotFoundError)
    })

    it('permanently deletes user and associated archived projects', async () => {
      const validId = '507f1f77bcf86cd799439011'
      const mockDeletedUser = {
        _id: 'del-doc-1',
        deleterData: {
          deletedUserId: validId,
        },
      }

      DeletedUser.findOne.mockReturnValue({
        exec: vi.fn().mockResolvedValue(mockDeletedUser),
      })
      DeletedProject.deleteMany.mockReturnValue({
        exec: vi.fn().mockResolvedValue({ deletedCount: 3 }),
      })
      DeletedUser.deleteOne.mockReturnValue({
        exec: vi.fn().mockResolvedValue({ deletedCount: 1 }),
      })

      const result = await purgeDeletedUser(validId, 'admin-1', '127.0.0.1')

      expect(DeletedProject.deleteMany).toHaveBeenCalled()
      expect(DeletedUser.deleteOne).toHaveBeenCalledWith({ _id: 'del-doc-1' })
      expect(result.success).toBe(true)
      expect(result.purgedUserId).toBe(validId)
    })
  })
})

