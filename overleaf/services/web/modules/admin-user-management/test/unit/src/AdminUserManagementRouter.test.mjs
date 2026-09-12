import { describe, it, expect, vi, beforeEach } from 'vitest'
import AdminUserManagementRouter from '../../../app/src/AdminUserManagementRouter.mjs'
import Features from '../../../../../app/src/infrastructure/Features.mjs'
import AuthenticationController from '../../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import AdminUserSelfServiceEmailsController from '../../../app/src/AdminUserSelfServiceEmailsController.mjs'

vi.mock('@overleaf/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../../../../../app/src/Features/Authorization/AuthorizationMiddleware.mjs', () => ({
  default: {
    ensureUserIsSiteAdmin: vi.fn((req, res, next) => next()),
  },
}))

vi.mock('../../../../../app/src/Features/Authentication/AuthenticationController.mjs', () => ({
  default: {
    requireLogin: vi.fn(() => (req, res, next) => next()),
  },
}))

vi.mock('../../../app/src/AdminUserSelfServiceEmailsController.mjs', () => ({
  default: {
    addSecondaryEmail: vi.fn(),
    setDefaultEmail: vi.fn(),
    deleteSecondaryEmail: vi.fn(),
  },
}))

vi.mock('../../../../../app/src/Features/Security/RateLimiterMiddleware.mjs', () => ({
  default: {
    rateLimit: vi.fn(() => (req, res, next) => next()),
  },
}))

vi.mock('../../../../../app/src/infrastructure/RateLimiter.mjs', () => {
  return {
    RateLimiter: function () {},
  }
})

vi.mock('../../../../../app/src/infrastructure/Features.mjs', () => ({
  default: {
    hasFeature: vi.fn(),
  },
}))

vi.mock('../../../app/src/AdminUserManagementController.mjs', () => ({
  default: {
    renderUserListPage: vi.fn(),
    renderUserDetailPage: vi.fn(),
    getActiveUsers: vi.fn(),
    getDeletedUsers: vi.fn(),
    getUser: vi.fn(),
    updateUserProfile: vi.fn(),
    updateAdminStatus: vi.fn(),
    generatePasswordResetLink: vi.fn(),
    deleteUser: vi.fn(),
    restoreUser: vi.fn(),
    purgeDeletedUser: vi.fn(),
    getUserSessions: vi.fn(),
    revokeUserSessions: vi.fn(),
    addEmail: vi.fn(),
    removeEmail: vi.fn(),
    setPrimaryEmail: vi.fn(),
    getUserProjects: vi.fn(),
    searchUsers: vi.fn(),
    transferProject: vi.fn(),
    transferAllProjects: vi.fn(),
    getUserAuditLogs: vi.fn(),
    bulkCreateUsers: vi.fn(),
    batchDeleteUsers: vi.fn(),
    batchRevokeUserSessions: vi.fn(),
    batchRestoreUsers: vi.fn(),
    batchPurgeDeletedUsers: vi.fn(),
  },
}))

describe('AdminUserManagementRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('redirects to /admin/register when feature is disabled', () => {
    Features.hasFeature.mockReturnValue(false)
    const mockWebRouter = {
      get: vi.fn(),
      post: vi.fn(),
    }

    AdminUserManagementRouter.apply(mockWebRouter)

    expect(mockWebRouter.get).toHaveBeenCalledWith(
      '/admin/users',
      expect.anything(),
      expect.anything()
    )
    expect(mockWebRouter.get).toHaveBeenCalledWith(
      '/admin/user',
      expect.anything(),
      expect.anything()
    )
    expect(mockWebRouter.post).not.toHaveBeenCalled()
  })

  it('registers all admin user management routes when feature is enabled', () => {
    Features.hasFeature.mockReturnValue(true)
    const mockWebRouter = {
      get: vi.fn(),
      post: vi.fn(),
    }

    AdminUserManagementRouter.apply(mockWebRouter)

    const getPaths = mockWebRouter.get.mock.calls.map(call => call[0])
    const postPaths = mockWebRouter.post.mock.calls.map(call => call[0])

    expect(getPaths).toContain('/admin/user')
    expect(getPaths).toContain('/admin/users')
    expect(getPaths).toContain('/admin/users/api/users')
    expect(getPaths).toContain('/admin/users/api/deleted-users')
    expect(getPaths).toContain('/admin/users/api/search-users')
    expect(getPaths).toContain('/admin/users/api/users/:userId')
    expect(getPaths).toContain('/admin/users/api/users/:userId/sessions')
    expect(getPaths).toContain('/admin/users/api/users/:userId/projects')
    expect(getPaths).toContain('/admin/users/api/users/:userId/audit-logs')
    expect(getPaths).toContain('/admin/users/:userId')

    expect(postPaths).toContain('/admin/users/api/users/bulk-create')
    expect(postPaths).toContain('/admin/users/api/users/:userId/sessions/revoke')
    expect(postPaths).toContain('/admin/users/api/users/:userId/profile')
    expect(postPaths).toContain('/admin/users/api/users/:userId/admin')
    expect(postPaths).toContain('/admin/users/api/users/:userId/password-reset-link')
    expect(postPaths).toContain('/admin/users/api/users/:userId/delete')
    expect(postPaths).toContain('/admin/users/api/users/batch-delete')
    expect(postPaths).toContain('/admin/users/api/users/batch-revoke-sessions')
    expect(postPaths).toContain('/admin/users/api/users/:userId/restore')
    expect(postPaths).toContain('/admin/users/api/users/batch-restore')
    expect(postPaths).toContain('/admin/users/api/deleted-users/:userId/purge')
    expect(postPaths).toContain('/admin/users/api/deleted-users/batch-purge')
    expect(postPaths).toContain('/admin/users/api/users/:userId/emails/add')
    expect(postPaths).toContain('/admin/users/api/users/:userId/emails/remove')
    expect(postPaths).toContain('/admin/users/api/users/:userId/emails/set-primary')
    expect(postPaths).toContain(
      '/admin/users/api/users/:userId/projects/:projectId/transfer'
    )
    expect(postPaths).toContain(
      '/admin/users/api/users/:userId/projects/transfer-all'
    )
  })

  it('registers self-service email routes with requireLogin when admin-user-management is enabled and affiliations is disabled', () => {
    Features.hasFeature.mockImplementation(feature => {
      if (feature === 'admin-user-management') return true
      if (feature === 'affiliations') return false
      return false
    })
    const mockWebRouter = {
      get: vi.fn(),
      post: vi.fn(),
    }

    AdminUserManagementRouter.apply(mockWebRouter)

    const postCalls = mockWebRouter.post.mock.calls
    const postPaths = postCalls.map(call => call[0])

    expect(postPaths).toContain('/user/emails/secondary')
    expect(postPaths).toContain('/user/emails/default')
    expect(postPaths).toContain('/user/emails/delete')

    expect(mockWebRouter.post).toHaveBeenCalledWith(
      '/user/emails/secondary',
      expect.anything(),
      expect.anything(),
      AdminUserSelfServiceEmailsController.addSecondaryEmail
    )
    expect(mockWebRouter.post).toHaveBeenCalledWith(
      '/user/emails/default',
      expect.anything(),
      expect.anything(),
      AdminUserSelfServiceEmailsController.setDefaultEmail
    )
    expect(mockWebRouter.post).toHaveBeenCalledWith(
      '/user/emails/delete',
      expect.anything(),
      expect.anything(),
      AdminUserSelfServiceEmailsController.deleteSecondaryEmail
    )
    expect(AuthenticationController.requireLogin).toHaveBeenCalled()
  })

  it('does not register default and delete email routes when affiliations is enabled', () => {
    Features.hasFeature.mockImplementation(feature => {
      if (feature === 'admin-user-management') return true
      if (feature === 'affiliations') return true
      return false
    })
    const mockWebRouter = {
      get: vi.fn(),
      post: vi.fn(),
    }

    AdminUserManagementRouter.apply(mockWebRouter)

    const postCalls = mockWebRouter.post.mock.calls
    const postPaths = postCalls.map(call => call[0])

    expect(postPaths).toContain('/user/emails/secondary')
    expect(postPaths).not.toContain('/user/emails/default')
    expect(postPaths).not.toContain('/user/emails/delete')
  })
})
