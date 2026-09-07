import crypto from 'node:crypto'
import logger from '@overleaf/logger'
import SessionManager from '../Authentication/SessionManager.mjs'
import GoogleDriveOAuthManager from './GoogleDriveOAuthManager.mjs'
import GoogleDriveSyncManager from './GoogleDriveSyncManager.mjs'
import { db, ObjectId } from '../../infrastructure/mongodb.mjs'
import { removeCSPHeaders } from '../../infrastructure/CSP.mjs'

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
 * Renders the landing page for the OAuth popup.
 *
 * The page hands the result to `window.opener` and closes itself while the
 * body is still parsing, so in the normal case nothing is ever painted. The
 * card in the body is the fallback for browsers that refuse to close the
 * window; a CSS delay holds it back so it never flashes on the way out.
 *
 * This response is sent with `res.send` rather than `res.render`, so it never
 * picks up the per-view CSP nonce. Without the explicit policy set here the
 * global `default-src 'none'` blocks the inline script and strands the popup
 * on a dead page.
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
  // Escaping "<" keeps the JSON from closing the surrounding script element
  const payload = JSON.stringify({ type: messageType, error }).replace(
    /</g,
    '\\u003C'
  )
  const nonce = crypto.randomBytes(16).toString('base64')

  const title = success
    ? 'Google Drive connected'
    : 'Google Drive not connected'
  const detail = success
    ? 'Your account is linked. You can close this window and carry on in Overleaf.'
    : 'We could not finish linking your account. Close this window and try again.'
  const icon = success
    ? '<path d="M20 6 9 17l-5-5"/>'
    : '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5"/><path d="M12 16.5h.01"/>'

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<script nonce="${nonce}">
  (function () {
    var payload = ${payload};
    var hasOpener = false;
    try {
      hasOpener = Boolean(window.opener) && !window.opener.closed;
      if (hasOpener) {
        window.opener.postMessage(payload, window.location.origin);
      }
    } catch (e) {}

    // Closing before the body paints means the user never sees this page
    window.close();

    document.addEventListener('DOMContentLoaded', function () {
      if (hasOpener) {
        document.documentElement.setAttribute('data-has-opener', 'true');
      }
      var closeButton = document.getElementById('close-window');
      if (closeButton) {
        closeButton.addEventListener('click', function () {
          window.close();
        });
      }
    });
  })();
</script>
<style nonce="${nonce}">
  :root {
    color-scheme: light dark;
    --bg: #f4f5f6;
    --surface: #fff;
    --border: #e4e8ee;
    --text: #2f3a4b;
    --muted: #6b7b8b;
    --accent: #138a07;
    --accent-soft: #e7f2e6;
    --danger: #b83a3a;
    --danger-soft: #fbeaea;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1b222c;
      --surface: #242c38;
      --border: #333d4b;
      --text: #e7ebf0;
      --muted: #a3b0c0;
      --accent: #4caf50;
      --accent-soft: #1f3521;
      --danger: #e77c7c;
      --danger-soft: #3a2226;
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: var(--bg);
    color: var(--text);
    font-family: system-ui, -apple-system, "Segoe UI", Lato, sans-serif;
    font-size: 15px;
    line-height: 1.5;
  }
  .card {
    width: 100%;
    max-width: 360px;
    padding: 28px 24px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
    text-align: center;
    opacity: 0;
    /* Held back so the card only appears if the window failed to close */
    animation: card-in 150ms ease-out 500ms forwards;
  }
  @keyframes card-in {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .card { animation-duration: 0s; }
  }
  .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: var(--accent-soft);
    color: var(--accent);
  }
  .is-error .icon {
    background: var(--danger-soft);
    color: var(--danger);
  }
  h1 {
    margin: 16px 0 4px;
    font-size: 18px;
    font-weight: 600;
  }
  p {
    margin: 0;
    color: var(--muted);
  }
  .actions {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    margin-top: 20px;
  }
  button {
    font: inherit;
    font-weight: 600;
    padding: 8px 20px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: var(--accent);
    color: #fff;
    cursor: pointer;
  }
  .is-error button {
    background: var(--surface);
    border-color: var(--border);
    color: var(--text);
  }
  button:hover { filter: brightness(0.94); }
  a {
    color: var(--muted);
    font-size: 13px;
  }
  html[data-has-opener="true"] .fallback-link { display: none; }
</style>
</head>
<body class="${success ? 'is-success' : 'is-error'}">
<main class="card" role="status" aria-live="polite">
  <span class="icon">
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg>
  </span>
  <h1>${title}</h1>
  <p>${detail}</p>
  <div class="actions">
    <button type="button" id="close-window">Close window</button>
    <a class="fallback-link" href="${targetUrl}">Back to account settings</a>
  </div>
</main>
</body>
</html>`

  removeCSPHeaders(res)
  res.set(
    'Content-Security-Policy',
    [
      `default-src 'none'`,
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      `base-uri 'none'`,
      `form-action 'none'`,
      `frame-ancestors 'none'`,
    ].join('; ')
  )
  res.set('Content-Type', 'text/html; charset=utf-8')
  return res.send(html)
}

/**
 * Controller for Google Drive OAuth authorization, unlinking, status, and manual sync.
 *
 * Every route is mounted behind AuthenticationController.requireLogin(), so the
 * session user is always present, and behind a `:Project_id` param where a
 * project is involved.
 */
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
