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
import UserDeleter from '../../../../../app/src/Features/User/UserDeleter.mjs'
import UserGetter from '../../../../../app/src/Features/User/UserGetter.mjs'
import ProjectDeleter from '../../../../../app/src/Features/Project/ProjectDeleter.mjs'
import { UserAuditLogEntry } from '../../../../../app/src/models/UserAuditLogEntry.mjs'
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
      deletedUsers: { updateOne: vi.fn() },
      deletedProjects: { updateMany: vi.fn() },
      projects: { findOne: vi.fn() },
      users: {
        insertOne: vi.fn(),
        findOne: vi.fn(),
      },
    },
  }
})

vi.mock('../../../../../app/src/Features/User/UserDeleter.mjs', () => ({
  default: { promises: { expireDeletedUser: vi.fn() } },
}))

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
      expireDeletedProject: vi.fn(),
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

vi.mock('../../../../../app/src/models/UserAuditLogEntry.mjs', () => ({
  UserAuditLogEntry: { deleteMany: vi.fn() },
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
    deleteOne: vi.fn(),
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
    vi.resetAllMocks()
    db.users.findOne.mockResolvedValue(null)
    db.projects.findOne.mockResolvedValue(null)
    UserAuditLogEntry.deleteMany.mockReturnValue({
      exec: vi.fn().mockResolvedValue({}),
    })
    DeletedProject.find.mockReturnValue({ exec: vi.fn().mockResolvedValue([]) })
  })

  it('throws NotFoundError if deleted user is not found or has expired PII', async () => {
    DeletedUser.findOne.mockReturnValue({
      exec: vi.fn().mockResolvedValue(null),
    })

    const validId = '507f1f77bcf86cd799439011'
    await expect(
      restoreUserAndProjects(validId, 'admin-1', '127.0.0.1')
    ).to.be.rejectedWith(NotFoundError)
  })

  it('throws ConflictError if the primary email is already registered to an active user', async () => {
    const validId = '507f1f77bcf86cd799439011'
    DeletedUser.findOne.mockReturnValue({
      exec: vi.fn().mockResolvedValue({
        _id: 'del-doc-1',
        user: { email: 'alice@example.com', emails: [] },
      }),
    })
    UserGetter.promises.getUserByAnyEmail.mockResolvedValue({
      _id: 'active-user-2',
    })

    await expect(
      restoreUserAndProjects(validId, 'admin-1', '127.0.0.1')
    ).to.be.rejectedWith(ConflictError)
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
    expect(ProjectDeleter.promises.undeleteProject).toHaveBeenCalledWith(
      'proj-1'
    )
    expect(ProjectDeleter.promises.undeleteProject).toHaveBeenCalledWith(
      'proj-2'
    )
    expect(UserAuditLogHandler.promises.addEntry).toHaveBeenCalledWith(
      expect.anything(),
      'admin-restore-user',
      'admin-1',
      '127.0.0.1',
      { restoredProjectCount: 2, failedProjectIds: [] }
    )
    expect(result.restoredProjectCount).toBe(2)
  })

  it('retains failed project recovery and resumes without reinserting an active user', async () => {
    const userId = '507f1f77bcf86cd799439011'
    const archive = {
      _id: 'archive',
      user: { _id: userId, email: 'a@example.com', emails: [] },
    }
    DeletedUser.findOne.mockReturnValue({
      exec: vi.fn().mockResolvedValue(archive),
    })
    UserGetter.promises.getUserByAnyEmail.mockResolvedValue({ _id: userId })
    db.users.findOne.mockResolvedValue(archive.user)
    DeletedProject.find.mockReturnValue({
      exec: vi
        .fn()
        .mockResolvedValue([{ deleterData: { deletedProjectId: 'project' } }]),
    })
    ProjectDeleter.promises.undeleteProject.mockRejectedValueOnce(
      new Error('storage unavailable')
    )
    const partial = await restoreUserAndProjects(userId, 'admin', 'ip')
    expect(partial.failedProjectIds).toEqual(['project'])
    expect(db.users.insertOne).not.toHaveBeenCalled()
    expect(DeletedUser.deleteOne).not.toHaveBeenCalled()
    expect(db.deletedUsers.updateOne).toHaveBeenCalledWith(
      { _id: 'archive' },
      { $unset: { 'deleterData.deletedAt': '' } }
    )
    expect(db.deletedProjects.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        'deleterData.deletedReason': 'account-deletion',
      }),
      { $unset: { 'deleterData.deletedAt': '' } }
    )
    DeletedUser.deleteOne.mockReturnValue({
      exec: vi.fn().mockResolvedValue({}),
    })
    const retried = await restoreUserAndProjects(userId, 'admin', 'ip')
    expect(retried.failedProjectIds).toEqual([])
    expect(retried.restoredProjectCount).toBe(1)
    expect(DeletedUser.deleteOne).toHaveBeenCalledWith({ _id: 'archive' })
  })

  it('resumes project recovery after active account addresses changed and archived addresses were reused', async () => {
    const userId = '507f1f77bcf86cd799439011'
    const activeUser = {
      _id: userId,
      email: 'new@example.com',
      emails: [{ email: 'new@example.com' }],
    }
    db.users.findOne.mockResolvedValue(activeUser)
    DeletedUser.findOne.mockReturnValue({
      exec: vi.fn().mockResolvedValue({
        _id: 'archive',
        user: {
          _id: userId,
          email: 'old@example.com',
          emails: [{ email: 'old-secondary@example.com' }],
        },
      }),
    })
    UserGetter.promises.getUserByAnyEmail.mockResolvedValue({
      _id: 'another-user',
    })
    DeletedProject.find.mockReturnValue({
      exec: vi
        .fn()
        .mockResolvedValue([{ deleterData: { deletedProjectId: 'project' } }]),
    })
    DeletedUser.deleteOne.mockReturnValue({
      exec: vi.fn().mockResolvedValue({}),
    })
    const result = await restoreUserAndProjects(userId, 'admin', 'ip')
    expect(result.restoredUser).toBe(activeUser)
    expect(result.restoredProjectCount).toBe(1)
    expect(UserGetter.promises.getUserByAnyEmail).not.toHaveBeenCalled()
    expect(db.users.insertOne).not.toHaveBeenCalled()
    expect(activeUser.email).toBe('new@example.com')
  })

  it('still checks archived secondary email conflicts before reinserting an inactive account', async () => {
    const userId = '507f1f77bcf86cd799439011'
    DeletedUser.findOne.mockReturnValue({
      exec: vi.fn().mockResolvedValue({
        _id: 'archive',
        user: {
          _id: userId,
          email: 'primary@example.com',
          emails: [{ email: 'secondary@example.com' }],
        },
      }),
    })
    UserGetter.promises.getUserByAnyEmail.mockImplementation(async (email) =>
      email === 'secondary@example.com' ? { _id: 'another-user' } : null
    )
    await expect(
      restoreUserAndProjects(userId, 'admin', 'ip')
    ).to.be.rejectedWith(ConflictError)
    expect(db.users.insertOne).not.toHaveBeenCalled()
    expect(db.deletedUsers.updateOne).not.toHaveBeenCalled()
  })

  it('reconciles native insert success followed by failed archive deletion without reinserting the project', async () => {
    const userId = '507f1f77bcf86cd799439011'
    const projectId = '507f1f77bcf86cd799439012'
    const archive = {
      _id: 'project-archive',
      deleterData: {
        deletedProjectId: projectId,
        deletedProjectOwnerId: userId,
        deletedReason: 'account-deletion',
      },
      project: {
        _id: projectId,
        owner_ref: userId,
        name: 'Original',
        archived: [userId],
        deletedDocs: [{ _id: 'old-doc' }],
      },
    }
    db.users.findOne.mockResolvedValue({
      _id: userId,
      email: 'active@example.com',
    })
    DeletedUser.findOne.mockReturnValue({
      exec: vi.fn().mockResolvedValue({
        _id: 'user-archive',
        user: { _id: userId, email: 'old@example.com' },
      }),
    })
    DeletedProject.find.mockReturnValue({
      exec: vi.fn().mockResolvedValue([archive]),
    })
    let insertedProject = null
    db.projects.findOne.mockImplementation(async () => insertedProject)
    ProjectDeleter.promises.undeleteProject.mockImplementationOnce(async () => {
      // Match native order: normalization/backfill, insert, then tombstone delete.
      insertedProject = {
        _id: projectId,
        owner_ref: userId,
        name: 'Original (Restored)',
        deletedDocs: [],
      }
      throw new Error('archive storage unavailable')
    })
    const first = await restoreUserAndProjects(userId, 'admin', 'ip')
    expect(first.failedProjectIds).toEqual([projectId])
    expect(DeletedUser.deleteOne).not.toHaveBeenCalled()

    // Even failure of the reconciliation delete remains safely retryable.
    DeletedProject.deleteOne.mockReturnValueOnce({
      exec: vi.fn().mockRejectedValue(new Error('archive storage unavailable')),
    })
    const second = await restoreUserAndProjects(userId, 'admin', 'ip')
    expect(second.failedProjectIds).toEqual([projectId])
    expect(DeletedUser.deleteOne).not.toHaveBeenCalled()

    DeletedProject.deleteOne.mockReturnValueOnce({
      exec: vi.fn().mockResolvedValue({ deletedCount: 1 }),
    })
    DeletedUser.deleteOne.mockReturnValueOnce({
      exec: vi.fn().mockResolvedValue({ deletedCount: 1 }),
    })
    const third = await restoreUserAndProjects(userId, 'admin', 'ip')
    expect(third.failedProjectIds).toEqual([])
    expect(third.restoredProjectCount).toBe(1)
    expect(ProjectDeleter.promises.undeleteProject).toHaveBeenCalledTimes(1)
    expect(DeletedProject.deleteOne).toHaveBeenLastCalledWith({
      _id: 'project-archive',
      'deleterData.deletedProjectId': projectId,
      'deleterData.deletedProjectOwnerId': expect.any(ObjectId),
      'deleterData.deletedReason': 'account-deletion',
      'project._id': projectId,
    })
    expect(insertedProject.name).toBe('Original (Restored)')
    expect(DeletedUser.deleteOne).toHaveBeenCalledWith({ _id: 'user-archive' })
  })

  it.each([
    { owner_ref: 'different-owner' },
    { archived: ['owner'] },
    { deletedDocs: [{ _id: 'unprocessed-doc' }] },
  ])(
    'keeps a conflicting or incompletely normalized active project for manual recovery: %o',
    async (overrides) => {
      const userId = '507f1f77bcf86cd799439011'
      const projectId = '507f1f77bcf86cd799439012'
      db.users.findOne.mockResolvedValue({ _id: userId })
      DeletedUser.findOne.mockReturnValue({
        exec: vi
          .fn()
          .mockResolvedValue({ _id: 'user-archive', user: { _id: userId } }),
      })
      DeletedProject.find.mockReturnValue({
        exec: vi.fn().mockResolvedValue([
          {
            _id: 'project-archive',
            deleterData: {
              deletedProjectId: projectId,
              deletedProjectOwnerId: userId,
            },
            project: { _id: projectId, owner_ref: userId },
          },
        ]),
      })
      db.projects.findOne.mockResolvedValue({
        _id: projectId,
        owner_ref: userId,
        deletedDocs: [],
        ...overrides,
      })
      const result = await restoreUserAndProjects(userId, 'admin', 'ip')
      expect(result.failedProjectIds).toEqual([projectId])
      expect(DeletedProject.deleteOne).not.toHaveBeenCalled()
      expect(DeletedUser.deleteOne).not.toHaveBeenCalled()
      expect(ProjectDeleter.promises.undeleteProject).not.toHaveBeenCalled()
    }
  )

  describe('purgeDeletedUser', () => {
    it('throws NotFoundError if deleted user is not found', async () => {
      DeletedUser.findOne.mockReturnValue({
        exec: vi.fn().mockResolvedValue(null),
      })

      const validId = '507f1f77bcf86cd799439011'
      await expect(
        purgeDeletedUser(validId, 'admin-1', '127.0.0.1')
      ).to.be.rejectedWith(NotFoundError)
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
      DeletedProject.find.mockReturnValue({
        exec: vi
          .fn()
          .mockResolvedValue([
            { deleterData: { deletedProjectId: 'project' } },
          ]),
      })
      DeletedProject.deleteMany.mockReturnValue({
        exec: vi.fn().mockResolvedValue({ deletedCount: 3 }),
      })
      DeletedUser.deleteOne.mockReturnValue({
        exec: vi.fn().mockResolvedValue({ deletedCount: 1 }),
      })

      const result = await purgeDeletedUser(validId, 'admin-1', '127.0.0.1')

      expect(ProjectDeleter.promises.expireDeletedProject).toHaveBeenCalledWith(
        'project'
      )
      expect(
        ProjectDeleter.promises.expireDeletedProject.mock.invocationCallOrder[0]
      ).toBeLessThan(DeletedProject.deleteMany.mock.invocationCallOrder[0])
      expect(UserDeleter.promises.expireDeletedUser).toHaveBeenCalledWith(
        validId
      )
      expect(UserAuditLogEntry.deleteMany).toHaveBeenCalledWith({
        userId: validId,
      })
      expect(
        UserDeleter.promises.expireDeletedUser.mock.invocationCallOrder[0]
      ).toBeLessThan(UserAuditLogEntry.deleteMany.mock.invocationCallOrder[0])
      expect(
        UserAuditLogEntry.deleteMany.mock.invocationCallOrder[0]
      ).toBeLessThan(DeletedProject.deleteMany.mock.invocationCallOrder[0])
      expect(DeletedProject.deleteMany).toHaveBeenCalled()
      expect(DeletedUser.deleteOne).toHaveBeenCalledWith({ _id: 'del-doc-1' })
      expect(result.success).toBe(true)
      expect(result.purgedUserId).toBe(validId)
    })
    it('keeps tombstones if backing-store cleanup fails', async () => {
      const userId = '507f1f77bcf86cd799439011'
      DeletedUser.findOne.mockReturnValue({
        exec: vi.fn().mockResolvedValue({
          _id: 'archive',
          deleterData: { deletedUserId: userId },
        }),
      })
      DeletedProject.find.mockReturnValue({
        exec: vi
          .fn()
          .mockResolvedValue([
            { deleterData: { deletedProjectId: 'project' } },
          ]),
      })
      ProjectDeleter.promises.expireDeletedProject.mockRejectedValue(
        new Error('storage unavailable')
      )
      await expect(purgeDeletedUser(userId, 'admin', 'ip')).to.be.rejectedWith(
        'storage unavailable'
      )
      expect(DeletedUser.deleteOne).not.toHaveBeenCalled()
      expect(DeletedProject.deleteMany).not.toHaveBeenCalled()
    })

    it('keeps tombstones when audit cleanup fails so purge can be retried', async () => {
      const userId = '507f1f77bcf86cd799439011'
      DeletedUser.findOne.mockReturnValue({
        exec: vi.fn().mockResolvedValue({
          _id: 'archive',
          deleterData: { deletedUserId: userId },
        }),
      })
      UserAuditLogEntry.deleteMany.mockReturnValue({
        exec: vi.fn().mockRejectedValue(new Error('audit storage unavailable')),
      })
      await expect(purgeDeletedUser(userId, 'admin', 'ip')).to.be.rejectedWith(
        'audit storage unavailable'
      )
      expect(UserDeleter.promises.expireDeletedUser).toHaveBeenCalledWith(
        userId
      )
      expect(DeletedUser.deleteOne).not.toHaveBeenCalled()
      expect(DeletedProject.deleteMany).not.toHaveBeenCalled()
    })

    it('refuses to purge an account with an active recovery', async () => {
      const userId = '507f1f77bcf86cd799439011'
      DeletedUser.findOne.mockReturnValue({
        exec: vi.fn().mockResolvedValue({
          _id: 'archive',
          deleterData: { deletedUserId: userId },
        }),
      })
      db.users.findOne.mockResolvedValue({ _id: userId })
      await expect(purgeDeletedUser(userId, 'admin', 'ip')).to.be.rejectedWith(
        'cannot_purge_restored_user'
      )
      expect(
        ProjectDeleter.promises.expireDeletedProject
      ).not.toHaveBeenCalled()
    })
  })
})
