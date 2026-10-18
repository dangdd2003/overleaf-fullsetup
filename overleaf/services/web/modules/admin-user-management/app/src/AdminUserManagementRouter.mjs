import logger from '@overleaf/logger'
import AuthorizationMiddleware from '../../../../app/src/Features/Authorization/AuthorizationMiddleware.mjs'
import RateLimiterMiddleware from '../../../../app/src/Features/Security/RateLimiterMiddleware.mjs'
import { RateLimiter } from '../../../../app/src/infrastructure/RateLimiter.mjs'
import Features from '../../../../app/src/infrastructure/Features.mjs'
import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import AdminUserManagementController from './AdminUserManagementController.mjs'
import AdminUserSelfServiceEmailsController from './AdminUserSelfServiceEmailsController.mjs'

// Self-service secondary email code flow (per user, hard-coded)
const SECONDARY_EMAIL_SEND_RATE_LIMIT = { points: 5, duration: 10 * 60 }
const SECONDARY_EMAIL_CONFIRM_RATE_LIMIT = { points: 10, duration: 60 }

export default {
  apply(webRouter) {
    logger.debug({}, 'Init AdminUserManagement router')

    // Disabled: register nothing, so the instance behaves as upstream CE
    if (!Features.hasFeature('admin-user-management')) {
      logger.info({}, 'AdminUserManagement is disabled; no routes registered')
      return
    }

    const rateLimit = RateLimiterMiddleware.rateLimit(
      new RateLimiter('admin_user_mutations', {
        points: 30,
        duration: 60,
      })
    )
    const secondaryEmailSendRateLimit = RateLimiterMiddleware.rateLimit(
      new RateLimiter(
        'admin_user_secondary_email_send',
        SECONDARY_EMAIL_SEND_RATE_LIMIT
      )
    )
    const secondaryEmailConfirmRateLimit = RateLimiterMiddleware.rateLimit(
      new RateLimiter(
        'admin_user_secondary_email_confirm',
        SECONDARY_EMAIL_CONFIRM_RATE_LIMIT
      )
    )

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

    // Self-Service Secondary Emails for Community Edition
    webRouter.post(
      '/user/emails/secondary',
      secondaryEmailSendRateLimit,
      AuthenticationController.requireLogin(),
      AdminUserSelfServiceEmailsController.addSecondaryEmail
    )

    // Upstream only routes the GET pages for these paths (SaaS-gated); the
    // POST handlers are not registered in CE, so they are served here.
    webRouter.post(
      '/user/emails/confirm-secondary',
      secondaryEmailConfirmRateLimit,
      AuthenticationController.requireLogin(),
      AdminUserSelfServiceEmailsController.confirmSecondaryEmail
    )

    // Shares the send limiter: each code issued (send or resend) counts once
    webRouter.post(
      '/user/emails/resend-secondary-confirmation',
      secondaryEmailSendRateLimit,
      AuthenticationController.requireLogin(),
      AdminUserSelfServiceEmailsController.resendSecondaryEmailConfirmationCode
    )

    if (!Features.hasFeature('affiliations')) {
      webRouter.post(
        '/user/emails/default',
        rateLimit,
        AuthenticationController.requireLogin(),
        AdminUserSelfServiceEmailsController.setDefaultEmail
      )

      webRouter.post(
        '/user/emails/delete',
        rateLimit,
        AuthenticationController.requireLogin(),
        AdminUserSelfServiceEmailsController.deleteSecondaryEmail
      )
    }
  },
}
