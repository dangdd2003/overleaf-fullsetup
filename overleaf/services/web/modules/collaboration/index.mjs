import './app/src/ModuleSettings.mjs'
import Settings from '@overleaf/settings'
import CommentController from './app/src/CommentController.mjs'
import TrackChangesController from './app/src/TrackChangesController.mjs'
import NotificationPreferencesController from './app/src/NotificationPreferencesController.mjs'
import { handleCommentMessageSent } from './app/src/CommentNotificationHandler.mjs'
import AuthenticationController from '../../app/src/Features/Authentication/AuthenticationController.mjs'
import AuthorizationMiddleware from '../../app/src/Features/Authorization/AuthorizationMiddleware.mjs'
import PermissionsController from '../../app/src/Features/Authorization/PermissionsController.mjs'
import RateLimiterMiddleware from '../../app/src/Features/Security/RateLimiterMiddleware.mjs'
import { RateLimiter } from '../../app/src/infrastructure/RateLimiter.mjs'

function isEnabled() {
  return Boolean(Settings.enableCollaboration)
}

const commentRateLimiter = new RateLimiter('send-comment', {
  points: 15,
  duration: 60,
})

const readReviewData = [
  AuthorizationMiddleware.blockRestrictedUserFromProject,
  AuthorizationMiddleware.ensureUserCanReadProject,
]

const manageThread = [
  AuthorizationMiddleware.blockRestrictedUserFromProject,
  AuthorizationMiddleware.ensureUserCanDeleteOrResolveThread,
  PermissionsController.requirePermission('comment'),
]

const writeComment = [
  AuthorizationMiddleware.blockRestrictedUserFromProject,
  AuthorizationMiddleware.ensureUserCanWriteOrReviewProjectContent,
  PermissionsController.requirePermission('comment'),
]

/**
 * Upstream's collaboration features: comments, track changes, reviewers and
 * comment notifications (the Server Pro "track-changes" surface the upstream
 * review panel talks to). Gated by COLLABORATION_ENABLED.
 *
 * @type {import("../../../../types/web-module").WebModule}
 */
const CollaborationModule = {
  router: {
    apply(webRouter) {
      if (!isEnabled()) return

      // Comment threads
      webRouter.get(
        '/project/:project_id/threads',
        ...readReviewData,
        PermissionsController.requirePermission('chat'),
        CommentController.getThreads
      )
      webRouter.get(
        '/project/:project_id/thread/:thread_id',
        ...readReviewData,
        PermissionsController.requirePermission('chat'),
        CommentController.getThread
      )
      webRouter.post(
        '/project/:project_id/thread/:thread_id/messages',
        ...writeComment,
        RateLimiterMiddleware.rateLimit(commentRateLimiter),
        CommentController.sendComment
      )
      webRouter.post(
        '/project/:project_id/thread/:thread_id/messages/:message_id/edit',
        ...writeComment,
        CommentController.editCommentMessage
      )
      webRouter.delete(
        '/project/:project_id/thread/:thread_id/messages/:message_id',
        ...manageThread,
        CommentController.deleteCommentMessage
      )
      webRouter.delete(
        '/project/:project_id/thread/:thread_id/own-messages/:message_id',
        ...writeComment,
        CommentController.deleteOwnCommentMessage
      )

      // Thread state, with and without the comment's doc
      for (const prefix of [
        '/project/:project_id/thread/:thread_id',
        '/project/:project_id/doc/:doc_id/thread/:thread_id',
      ]) {
        webRouter.post(
          `${prefix}/resolve`,
          ...manageThread,
          CommentController.resolveThread
        )
        webRouter.post(
          `${prefix}/reopen`,
          ...manageThread,
          CommentController.reopenThread
        )
        webRouter.delete(
          prefix,
          ...manageThread,
          CommentController.deleteThread
        )
      }

      // Track changes
      webRouter.post(
        '/project/:project_id/track_changes',
        AuthorizationMiddleware.blockRestrictedUserFromProject,
        AuthorizationMiddleware.ensureUserCanWriteProjectContent,
        TrackChangesController.setTrackChangesState
      )
      webRouter.post(
        '/project/:project_id/doc/:doc_id/changes/accept',
        AuthenticationController.requireLogin(),
        AuthorizationMiddleware.blockRestrictedUserFromProject,
        AuthorizationMiddleware.ensureUserCanWriteProjectContent,
        TrackChangesController.acceptChanges
      )
      webRouter.get(
        '/project/:project_id/ranges',
        ...readReviewData,
        TrackChangesController.getAllRanges
      )
      webRouter.get(
        '/project/:project_id/changes/users',
        ...readReviewData,
        TrackChangesController.getAllChangesUsers
      )

      // Per-project notification preferences (File > Settings)
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

export default CollaborationModule
