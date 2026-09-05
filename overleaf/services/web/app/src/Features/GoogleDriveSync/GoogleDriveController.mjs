import logger from '@overleaf/logger'
import SessionManager from '../Authentication/SessionManager.mjs'
import GoogleDriveOAuthManager from './GoogleDriveOAuthManager.mjs'
import GoogleDriveSyncManager from './GoogleDriveSyncManager.mjs'
import { db, ObjectId } from '../../infrastructure/mongodb.mjs'

/**
 * Safely converts string / ObjectId to an ObjectId instance if valid.
 *
 * @param {string|ObjectId} id
 * @returns {ObjectId|string}
 */
function _toObjectId(id) {
  if (!id) return null
  if (typeof id === 'object' && id._bsontype === 'ObjectID') {
    return id
  }
  if (typeof id === 'string' && ObjectId?.isValid?.(id)) {
    try {
      return new ObjectId(id)
    } catch {
      return id
    }
  }
  return id
}

/**
 * Controller for Google Drive OAuth authorization, unlinking, status, and manual sync.
 *
 * Every route is mounted behind AuthenticationController.requireLogin(), so the
 * session user is always present, and behind a `:Project_id` param where a
 * project is involved.
 */
/**
 * Renders an HTML page that communicates OAuth completion to window.opener via
 * postMessage and closes the popup, falling back to a page navigation if opener is absent.
 *
 * @param {import('express').Response} res
 * @param {{ success: boolean, error?: string|null }} options
 */
function _renderOAuthCallbackResponse(res, { success, error = null }) {
  const targetUrl = error
    ? `/user/settings?error=${encodeURIComponent(error)}#project-sync`
    : '/user/settings#project-sync'
  const messageType = success
    ? 'google-drive:oauth-success'
    : 'google-drive:oauth-error'
  const payload = JSON.stringify({ type: messageType, error })

  const html = `<!DOCTYPE html>
<html>
<head><title>Google Drive Authentication</title></head>
<body>
<script>
  (function() {
    var payload = ${payload};
    if (window.opener && !window.opener.closed) {
      try {
        window.opener.postMessage(payload, window.location.origin);
      } catch (e) {}
      window.close();
      return;
    }
    window.location.href = ${JSON.stringify(targetUrl)};
  })();
</script>
<p>${success ? 'Authentication successful. You can close this window.' : 'Authentication failed.'}</p>
</body>
</html>`

  res.set('Content-Type', 'text/html; charset=utf-8')
  return res.send(html)
}

const GoogleDriveController = {
  /**
   * Initiates Google Drive OAuth flow by redirecting user to Google's consent screen.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   */
  async startOAuth(req, res) {
    const userId = SessionManager.getLoggedInUserId(req.session)
    if (!userId) {
      return res.redirect('/login')
    }

    if (req.session) {
      req.session.googleDriveOAuthPopup = req.query?.popup === 'true'
    }

    try {
      const authResult =
        await GoogleDriveOAuthManager.getAuthorizationUrl(userId)
      const url = typeof authResult === 'string' ? authResult : authResult?.url
      return res.redirect(url)
    } catch (err) {
      logger.error({ err, userId }, 'error starting google drive oauth flow')
      return res.redirect(
        '/user/settings?error=google_drive_oauth_failed#project-sync'
      )
    }
  },

  /**
   * Handles Google OAuth2 redirect callback with auth code and state.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   */
  async oauthCallback(req, res) {
    const { code, state, error } = req.query || {}
    const isPopup = Boolean(
      req.session?.googleDriveOAuthPopup || req.query?.popup === 'true'
    )
    if (req.session && req.session.googleDriveOAuthPopup !== undefined) {
      delete req.session.googleDriveOAuthPopup
    }

    if (error) {
      logger.warn({ error }, 'Google Drive OAuth error received in callback')
      if (isPopup) {
        return _renderOAuthCallbackResponse(res, {
          success: false,
          error: 'google_drive_oauth_denied',
        })
      }
      return res.redirect(
        '/user/settings?error=google_drive_oauth_denied#project-sync'
      )
    }

    if (!code || !state) {
      logger.warn('Google Drive OAuth callback missing code or state')
      if (isPopup) {
        return _renderOAuthCallbackResponse(res, {
          success: false,
          error: 'google_drive_oauth_invalid',
        })
      }
      return res.redirect(
        '/user/settings?error=google_drive_oauth_invalid#project-sync'
      )
    }

    const userId = SessionManager.getLoggedInUserId(req.session)
    if (!userId) {
      return res.redirect('/login')
    }

    try {
      await GoogleDriveOAuthManager.handleOAuthCallback(userId, code, state)

      // Pick up any projects that already exist in the user's Drive folder
      // from before this link - the ongoing poller only reacts to live
      // changes, so without this one-time scan pre-existing folders would
      // never be discovered. Best-effort: a scan failure shouldn't stop the
      // user from landing back on settings with their account now linked.
      try {
        await GoogleDriveSyncManager.reconcileExistingDriveProjects(userId)
      } catch (scanErr) {
        logger.warn(
          { err: scanErr, userId },
          'error scanning for pre-existing google drive projects after link'
        )
      }

      if (isPopup) {
        return _renderOAuthCallbackResponse(res, { success: true })
      }
      return res.redirect('/user/settings#project-sync')
    } catch (err) {
      logger.error(
        { err, userId },
        'error handling google drive oauth callback'
      )
      if (isPopup) {
        return _renderOAuthCallbackResponse(res, {
          success: false,
          error: 'google_drive_oauth_failed',
        })
      }
      return res.redirect(
        '/user/settings?error=google_drive_oauth_failed#project-sync'
      )
    }
  },

  /**
   * Unlinks Google Drive integration and revokes OAuth tokens for the authenticated user.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   */
  async unlink(req, res) {
    const userId = SessionManager.getLoggedInUserId(req.session)
    if (!userId) {
      return res.status(401).json({
        code: 'unauthorized',
        message: 'User not logged in',
      })
    }

    try {
      await GoogleDriveOAuthManager.unlinkAccount(userId)
      return res.json({ success: true })
    } catch (err) {
      logger.error({ err, userId }, 'error unlinking google drive account')
      return res.status(500).json({ code: 'error', message: err.message })
    }
  },

  /**
   * Retrieves Google Drive link status and profile for the authenticated user.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   */
  async getUserStatus(req, res) {
    const userId = SessionManager.getLoggedInUserId(req.session)

    try {
      const status = await GoogleDriveOAuthManager.isLinked(userId)
      return res.json(status)
    } catch (err) {
      logger.error({ err, userId }, 'error retrieving google drive user status')
      return res.status(500).json({ code: 'error', message: err.message })
    }
  },

  /**
   * Retrieves synchronization status and metadata for a specific project.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   */
  async getProjectStatus(req, res) {
    const projectId = req.params?.Project_id || req.params?.project_id
    if (!projectId) {
      return res.status(400).json({
        code: 'bad_request',
        message: 'Missing project id',
      })
    }
    const userId = SessionManager.getLoggedInUserId(req.session)

    try {
      const status = await GoogleDriveSyncManager.getProjectStatus(
        projectId,
        userId
      )
      return res.json(status)
    } catch (err) {
      logger.error(
        { err, projectId, userId },
        'error retrieving google drive project status'
      )
      return res.status(500).json({ code: 'error', message: err.message })
    }
  },

  /**
   * Triggers an immediate synchronization run for a specific project.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   */
  async syncProjectNow(req, res) {
    const projectId = req.params?.Project_id || req.params?.project_id
    if (!projectId) {
      return res.status(400).json({
        code: 'bad_request',
        message: 'Missing project id',
      })
    }
    const userId = SessionManager.getLoggedInUserId(req.session)

    try {
      const cooldown =
        await GoogleDriveSyncManager.enforceManualSyncCooldown(projectId)
      if (!cooldown.allowed) {
        return res.status(429).json({
          code: 'rate_limited',
          message: 'Please wait before syncing this project again',
          retryAfterSeconds: cooldown.retryAfterSeconds,
        })
      }

      const result = await GoogleDriveSyncManager.syncProject(projectId, userId)

      // A full reconcile subsumes every queued path, so the outbound worker
      // has nothing left to do for this project.
      await db.googleDriveProjectStates.updateOne(
        {
          projectId: ObjectId.isValid(projectId)
            ? new ObjectId(projectId)
            : projectId,
        },
        { $set: { pendingChanges: {} }, $unset: { outboundDirtyAt: '' } }
      )

      return res.json({ success: true, result })
    } catch (err) {
      logger.error(
        { err, projectId, userId },
        'error executing manual google drive project sync'
      )
      return res.status(500).json({ code: 'error', message: err.message })
    }
  },

  /**
   * Actively scans the user's root Google Drive folder for subfolders that
   * don't yet have a matching Overleaf project, and creates one for each -
   * picking up projects that existed in Drive before the account was
   * linked (or before this feature existed), which the ongoing poller's
   * live-events-only reconciliation never sees.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   */
  async scanExistingProjects(req, res) {
    const userId = SessionManager.getLoggedInUserId(req.session)

    try {
      const result =
        await GoogleDriveSyncManager.reconcileExistingDriveProjects(userId)
      return res.json({ success: true, ...result })
    } catch (err) {
      logger.error(
        { err, userId },
        'error scanning for existing google drive projects'
      )
      return res.status(500).json({ code: 'error', message: err.message })
    }
  },

  /**
   * Dismisses recorded sync conflicts for a project by clearing conflicts array.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   */
  async dismissConflicts(req, res) {
    const projectId = req.params?.Project_id || req.params?.project_id
    if (!projectId) {
      return res.status(400).json({
        code: 'bad_request',
        message: 'Missing project id',
      })
    }
    const userId = SessionManager.getLoggedInUserId(req.session)

    try {
      await db.googleDriveProjectStates.updateOne(
        { projectId: _toObjectId(projectId) },
        { $set: { conflicts: [] } }
      )
      const status = await GoogleDriveSyncManager.getProjectStatus(
        projectId,
        userId
      )
      return res.json({ success: true, ...status })
    } catch (err) {
      logger.error(
        { err, projectId },
        'error dismissing google drive conflicts'
      )
      return res.status(500).json({ code: 'error', message: err.message })
    }
  },
}

export default GoogleDriveController
export { GoogleDriveController }
