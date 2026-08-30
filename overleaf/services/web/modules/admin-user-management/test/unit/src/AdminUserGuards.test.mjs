import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  ensureCanModifyAdmin,
  ensureCanDeleteUser,
  BadRequestError,
  ForbiddenError,
} from '../../../app/src/AdminUserGuards.mjs'
import { db } from '../../../../../app/src/infrastructure/mongodb.mjs'

vi.mock('../../../../../app/src/infrastructure/mongodb.mjs', () => ({
  db: {
    users: {
      countDocuments: vi.fn(),
    },
  },
}))

describe('AdminUserGuards', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('ensureCanModifyAdmin', () => {
    it('throws BadRequestError if an admin tries to remove their own admin status', async () => {
      await expect(
        ensureCanModifyAdmin('user-1', 'user-1', false)
      ).rejects.toThrow(BadRequestError)
      await expect(
        ensureCanModifyAdmin('user-1', 'user-1', false)
      ).rejects.toThrow('cannot_demote_self')
    })

    it('allows an admin to keep their own admin status', async () => {
      await expect(
        ensureCanModifyAdmin('user-1', 'user-1', true)
      ).resolves.not.toThrow()
    })

    it('throws ForbiddenError if demoting the last active administrator', async () => {
      db.users.countDocuments.mockResolvedValue(1)

      await expect(
        ensureCanModifyAdmin('admin-1', 'admin-2', false)
      ).rejects.toThrow(ForbiddenError)
      await expect(
        ensureCanModifyAdmin('admin-1', 'admin-2', false)
      ).rejects.toThrow('cannot_modify_last_admin')

      expect(db.users.countDocuments).toHaveBeenCalledWith({
        isAdmin: true,
        suspended: { $ne: true },
      })
    })

    it('allows demoting an administrator when multiple active admins exist', async () => {
      db.users.countDocuments.mockResolvedValue(2)

      await expect(
        ensureCanModifyAdmin('admin-1', 'admin-2', false)
      ).resolves.not.toThrow()
    })

    it('allows promoting any user to administrator without checking count', async () => {
      await expect(
        ensureCanModifyAdmin('admin-1', 'user-2', true)
      ).resolves.not.toThrow()
      expect(db.users.countDocuments).not.toHaveBeenCalled()
    })
  })

  describe('ensureCanDeleteUser', () => {
    it('throws BadRequestError if an admin tries to delete their own account', async () => {
      const selfUser = { _id: 'admin-1', isAdmin: true }
      await expect(
        ensureCanDeleteUser('admin-1', selfUser)
      ).rejects.toThrow(BadRequestError)
      await expect(
        ensureCanDeleteUser('admin-1', selfUser)
      ).rejects.toThrow('cannot_delete_self')
    })

    it('throws ForbiddenError if deleting the last active administrator', async () => {
      db.users.countDocuments.mockResolvedValue(1)
      const targetAdmin = { _id: 'admin-2', isAdmin: true }

      await expect(
        ensureCanDeleteUser('admin-1', targetAdmin)
      ).rejects.toThrow(ForbiddenError)
      await expect(
        ensureCanDeleteUser('admin-1', targetAdmin)
      ).rejects.toThrow('cannot_modify_last_admin')
    })

    it('allows deleting an administrator when multiple active admins exist', async () => {
      db.users.countDocuments.mockResolvedValue(2)
      const targetAdmin = { _id: 'admin-2', isAdmin: true }

      await expect(
        ensureCanDeleteUser('admin-1', targetAdmin)
      ).resolves.not.toThrow()
    })

    it('allows deleting a regular non-admin user without querying admin count', async () => {
      const regularUser = { _id: 'user-2', isAdmin: false }

      await expect(
        ensureCanDeleteUser('admin-1', regularUser)
      ).resolves.not.toThrow()
      expect(db.users.countDocuments).not.toHaveBeenCalled()
    })
  })
})
