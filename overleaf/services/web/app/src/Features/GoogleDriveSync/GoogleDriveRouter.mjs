import Features from '../../infrastructure/Features.mjs'
import AuthenticationController from '../Authentication/AuthenticationController.mjs'
import AuthorizationMiddleware from '../Authorization/AuthorizationMiddleware.mjs'
import GoogleDriveController from './GoogleDriveController.mjs'
import GoogleDriveWebhookController from './GoogleDriveWebhookController.mjs'

/**
 * Express router configuration for Google Drive Synchronization endpoints.
 */
const GoogleDriveRouter = {
  /**
   * Mounts Google Drive routes onto webRouter and publicApiRouter.
   *
   * @param {import('express').Router} webRouter
   * @param {import('express').Router} [publicApiRouter]
   */
  apply(webRouter, publicApiRouter) {
    if (!Features.hasFeature('google-drive-sync')) {
      return
    }

    // 1. Inbound Webhook (Google push notifications)
    if (publicApiRouter) {
      if (webRouter.csrf?.disableDefaultCsrfProtection) {
        webRouter.csrf.disableDefaultCsrfProtection(
          '/google-drive/webhook',
          'POST'
        )
      }
      publicApiRouter.post(
        '/google-drive/webhook',
        GoogleDriveWebhookController.handleWebhook
      )
    }

    // 2. User account linking
    webRouter.get(
      '/auth/google-drive/oauth',
      AuthenticationController.requireLogin(),
      GoogleDriveController.startOAuth
    )
    webRouter.get(
      '/oauth/google-drive/callback',
      AuthenticationController.requireLogin(),
      GoogleDriveController.oauthCallback
    )
    webRouter.get(
      '/auth/google-drive/callback',
      AuthenticationController.requireLogin(),
      GoogleDriveController.oauthCallback
    )
    webRouter.post(
      '/auth/google-drive/unlink',
      AuthenticationController.requireLogin(),
      GoogleDriveController.unlink
    )
    webRouter.get(
      '/auth/google-drive/status',
      AuthenticationController.requireLogin(),
      GoogleDriveController.getUserStatus
    )
    webRouter.post(
      '/auth/google-drive/scan-existing-projects',
      AuthenticationController.requireLogin(),
      GoogleDriveController.scanExistingProjects
    )

    // 2. Per-project synchronization
    webRouter.get(
      '/project/:Project_id/google-drive/status',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanReadProject,
      GoogleDriveController.getProjectStatus
    )
    webRouter.post(
      '/project/:Project_id/google-drive/sync',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      GoogleDriveController.syncProjectNow
    )
    webRouter.post(
      '/project/:Project_id/google-drive/conflicts/dismiss',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      GoogleDriveController.dismissConflicts
    )
  },
}

export default GoogleDriveRouter
export { GoogleDriveRouter }
