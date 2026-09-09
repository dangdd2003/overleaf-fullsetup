import './app/src/ModuleSettings.mjs'
import './app/src/CommentEmailTemplate.mjs'
import Settings from '@overleaf/settings'
import { handleCommentMessageSent } from './app/src/CommentNotificationHandler.mjs'
import CommentController from './app/src/CommentController.mjs'
import NotificationPreferencesController from './app/src/NotificationPreferencesController.mjs'
import AuthenticationController from '../../app/src/Features/Authentication/AuthenticationController.mjs'
import AuthorizationMiddleware from '../../app/src/Features/Authorization/AuthorizationMiddleware.mjs'
import PermissionsController from '../../app/src/Features/Authorization/PermissionsController.mjs'
import RateLimiterMiddleware from '../../app/src/Features/Security/RateLimiterMiddleware.mjs'
import { RateLimiter } from '../../app/src/infrastructure/RateLimiter.mjs'

function isEnabled() {
  return Boolean(Settings.enableCommentNotifications)
}

const commentRateLimiter = new RateLimiter('send-comment', {
  points: 15,
  duration: 60,
})

/** @type {import("../../../../types/web-module").WebModule} */
const CommentNotificationsModule = {
  router: {
    apply(webRouter) {
      if (!isEnabled()) return

      // Read thread lists and single threads
      webRouter.get(
        '/project/:project_id/threads',
        AuthorizationMiddleware.blockRestrictedUserFromProject,
        AuthorizationMiddleware.ensureUserCanReadProject,
        PermissionsController.requirePermission('chat'),
        CommentController.getThreads
      )
      webRouter.get(
        '/project/:project_id/thread/:thread_id',
        AuthorizationMiddleware.blockRestrictedUserFromProject,
        AuthorizationMiddleware.ensureUserCanReadProject,
        PermissionsController.requirePermission('chat'),
        CommentController.getThread
      )

      // Send comment message
      webRouter.post(
        '/project/:project_id/thread/:thread_id/messages',
        AuthorizationMiddleware.blockRestrictedUserFromProject,
        AuthorizationMiddleware.ensureUserCanWriteOrReviewProjectContent,
        PermissionsController.requirePermission('comment'),
        RateLimiterMiddleware.rateLimit(commentRateLimiter),
        CommentController.sendComment
      )

      // Resolve thread (supports both /thread/:thread_id/resolve and /doc/:doc_id/thread/:thread_id/resolve)
      webRouter.post(
        '/project/:project_id/thread/:thread_id/resolve',
        AuthorizationMiddleware.blockRestrictedUserFromProject,
        AuthorizationMiddleware.ensureUserCanDeleteOrResolveThread,
        PermissionsController.requirePermission('comment'),
        CommentController.resolveThread
      )
      webRouter.post(
        '/project/:project_id/doc/:doc_id/thread/:thread_id/resolve',
        AuthorizationMiddleware.blockRestrictedUserFromProject,
        AuthorizationMiddleware.ensureUserCanDeleteOrResolveThread,
        PermissionsController.requirePermission('comment'),
        CommentController.resolveThread
      )

      // Reopen thread (supports both /thread/:thread_id/reopen and /doc/:doc_id/thread/:thread_id/reopen)
      webRouter.post(
        '/project/:project_id/thread/:thread_id/reopen',
        AuthorizationMiddleware.blockRestrictedUserFromProject,
        AuthorizationMiddleware.ensureUserCanDeleteOrResolveThread,
        PermissionsController.requirePermission('comment'),
        CommentController.reopenThread
      )
      webRouter.post(
        '/project/:project_id/doc/:doc_id/thread/:thread_id/reopen',
        AuthorizationMiddleware.blockRestrictedUserFromProject,
        AuthorizationMiddleware.ensureUserCanDeleteOrResolveThread,
        PermissionsController.requirePermission('comment'),
        CommentController.reopenThread
      )

      // Delete thread (supports both /thread/:thread_id and /doc/:doc_id/thread/:thread_id)
      webRouter.delete(
        '/project/:project_id/thread/:thread_id',
        AuthorizationMiddleware.blockRestrictedUserFromProject,
        AuthorizationMiddleware.ensureUserCanDeleteOrResolveThread,
        PermissionsController.requirePermission('comment'),
        CommentController.deleteThread
      )
      webRouter.delete(
        '/project/:project_id/doc/:doc_id/thread/:thread_id',
        AuthorizationMiddleware.blockRestrictedUserFromProject,
        AuthorizationMiddleware.ensureUserCanDeleteOrResolveThread,
        PermissionsController.requirePermission('comment'),
        CommentController.deleteThread
      )

      // Edit comment message
      webRouter.post(
        '/project/:project_id/thread/:thread_id/messages/:message_id/edit',
        AuthorizationMiddleware.blockRestrictedUserFromProject,
        AuthorizationMiddleware.ensureUserCanWriteOrReviewProjectContent,
        PermissionsController.requirePermission('comment'),
        CommentController.editCommentMessage
      )

      // Delete comment message (admin/author)
      webRouter.delete(
        '/project/:project_id/thread/:thread_id/messages/:message_id',
        AuthorizationMiddleware.blockRestrictedUserFromProject,
        AuthorizationMiddleware.ensureUserCanDeleteOrResolveThread,
        PermissionsController.requirePermission('comment'),
        CommentController.deleteCommentMessage
      )

      // Delete own comment message
      webRouter.delete(
        '/project/:project_id/thread/:thread_id/own-messages/:message_id',
        AuthorizationMiddleware.blockRestrictedUserFromProject,
        AuthorizationMiddleware.ensureUserCanWriteOrReviewProjectContent,
        PermissionsController.requirePermission('comment'),
        CommentController.deleteOwnCommentMessage
      )

      // Project notification preferences (matches frontend use-project-notification-preferences.ts)
      webRouter.get(
        '/notifications/preferences/project/:project_id',
        AuthenticationController.requireLogin(),
        AuthorizationMiddleware.ensureUserCanReadProject,
        NotificationPreferencesController.getPreferences
      )
      webRouter.post(
        '/notifications/preferences/project/:project_id',
        AuthenticationController.requireLogin(),
        AuthorizationMiddleware.ensureUserCanReadProject,
        NotificationPreferencesController.updatePreferences
      )
    },
  },
  hooks: {
    promises: {
      async commentMessageSent(...args) {
        if (!isEnabled()) return
        return handleCommentMessageSent(...args)
      },
    },
  },
}

export default CommentNotificationsModule
