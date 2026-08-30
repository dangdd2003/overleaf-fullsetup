import logger from '@overleaf/logger'
import AuthorizationMiddleware from '../../../../app/src/Features/Authorization/AuthorizationMiddleware.mjs'
import RateLimiterMiddleware from '../../../../app/src/Features/Security/RateLimiterMiddleware.mjs'
import { RateLimiter } from '../../../../app/src/infrastructure/RateLimiter.mjs'
import Features from '../../../../app/src/infrastructure/Features.mjs'
import AdminUserManagementController from './AdminUserManagementController.mjs'

const rateLimiter = new RateLimiter('admin_user_mutations', {
  points: 30,
  duration: 60,
})

export default {
  apply(webRouter) {
    logger.debug({}, 'Init AdminUserManagement router')

    if (!Features.hasFeature('admin-user-management')) {
      logger.info(
        {},
        'AdminUserManagement is disabled; registering fallback redirect to /admin/register'
      )
      webRouter.get(
        '/admin/users',
        AuthorizationMiddleware.ensureUserIsSiteAdmin,
        (req, res) => res.redirect('/admin/register')
      )
      webRouter.get(
        '/admin/user',
        AuthorizationMiddleware.ensureUserIsSiteAdmin,
        (req, res) => res.redirect('/admin/register')
      )
      return
    }

    const rateLimit = RateLimiterMiddleware.rateLimit(rateLimiter)

    // Legacy redirect /admin/user -> /admin/users
    webRouter.get(
      '/admin/user',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      (req, res) => res.redirect('/admin/users')
    )

    // HTML Views
    webRouter.get(
      '/admin/users',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.renderUserListPage
    )

    // API endpoints
    webRouter.get(
      '/admin/users/api/users',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.getActiveUsers
    )

    webRouter.get(
      '/admin/users/api/deleted-users',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.getDeletedUsers
    )

    webRouter.get(
      '/admin/users/api/search-users',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.searchUsers
    )

    webRouter.get(
      '/admin/users/api/users/:userId',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.getUser
    )

    webRouter.get(
      '/admin/users/api/users/:userId/sessions',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.getUserSessions
    )

    webRouter.get(
      '/admin/users/api/users/:userId/projects',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.getUserProjects
    )

    webRouter.get(
      '/admin/users/api/users/:userId/audit-logs',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.getUserAuditLogs
    )

    webRouter.post(
      '/admin/users/api/users/bulk-create',
      rateLimit,
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.bulkCreateUsers
    )

    webRouter.post(
      '/admin/users/api/users/:userId/sessions/revoke',
      rateLimit,
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.revokeUserSessions
    )

    webRouter.post(
      '/admin/users/api/users/:userId/profile',
      rateLimit,
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.updateUserProfile
    )

    webRouter.post(
      '/admin/users/api/users/:userId/admin',
      rateLimit,
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.updateAdminStatus
    )

    webRouter.post(
      '/admin/users/api/users/:userId/password-reset-link',
      rateLimit,
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.generatePasswordResetLink
    )

    webRouter.post(
      '/admin/users/api/users/:userId/delete',
      rateLimit,
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.deleteUser
    )

    webRouter.post(
      '/admin/users/api/users/batch-delete',
      rateLimit,
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.batchDeleteUsers
    )

    webRouter.post(
      '/admin/users/api/users/batch-revoke-sessions',
      rateLimit,
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.batchRevokeUserSessions
    )

    webRouter.post(
      '/admin/users/api/users/:userId/restore',
      rateLimit,
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.restoreUser
    )

    webRouter.post(
      '/admin/users/api/users/batch-restore',
      rateLimit,
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.batchRestoreUsers
    )

    webRouter.post(
      '/admin/users/api/deleted-users/:userId/purge',
      rateLimit,
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.purgeDeletedUser
    )

    webRouter.post(
      '/admin/users/api/deleted-users/batch-purge',
      rateLimit,
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.batchPurgeDeletedUsers
    )

    webRouter.post(
      '/admin/users/api/users/:userId/emails/add',
      rateLimit,
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.addEmail
    )

    webRouter.post(
      '/admin/users/api/users/:userId/emails/remove',
      rateLimit,
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.removeEmail
    )

    webRouter.post(
      '/admin/users/api/users/:userId/emails/set-primary',
      rateLimit,
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.setPrimaryEmail
    )

    webRouter.post(
      '/admin/users/api/users/:userId/projects/:projectId/transfer',
      rateLimit,
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.transferProject
    )

    webRouter.post(
      '/admin/users/api/users/:userId/projects/transfer-all',
      rateLimit,
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.transferAllProjects
    )

    // User Detail View (must be after /admin/users/api/* routes)
    webRouter.get(
      '/admin/users/:userId',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.renderUserDetailPage
    )
  },
}
