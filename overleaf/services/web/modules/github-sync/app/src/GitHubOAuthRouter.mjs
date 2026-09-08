import passport from 'passport'
import logger from '@overleaf/logger'
import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import { User } from '../../../../app/src/models/User.mjs'
import UserAuditLogHandler from '../../../../app/src/Features/User/UserAuditLogHandler.mjs'
import GitHubSyncManager from './GitHubSyncManager.mjs'
import GitHubApiManager from './GitHubApiManager.mjs'
import GitHubCredentialsManager from './GitHubCredentialsManager.mjs'

function link(req, res, next) {
  passport.authenticate('github-sync')(req, res, next)
}

function callback(req, res, next) {
  passport.authenticate('github-sync', { session: false }, (err, ok) => {
    if (err || !ok) {
      logger.warn({ err }, 'github oauth callback failed')
      req.session.githubSyncError = true
    }
    return res.redirect('/user/settings')
  })(req, res, next)
}

async function status(req, res) {
  const creds = await GitHubCredentialsManager.promises.getCredentials(req.user._id)
  res.json({ linked: Boolean(creds), username: creds?.githubUsername || null })
}

async function repos(req, res) {
  try {
    const token = await GitHubCredentialsManager.promises.getAccessToken(req.user._id)
    const list = await GitHubApiManager.promises.listRepos(token)
    res.json({ repos: list })
  } catch (err) {
    res.status(err.status || 500).json({ code: err.code || 'error', message: err.message })
  }
}

async function orgs(req, res) {
  try {
    const token = await GitHubCredentialsManager.promises.getAccessToken(req.user._id)
    const list = await GitHubApiManager.promises.listOrgs(token)
    res.json({ orgs: list })
  } catch (err) {
    res.status(err.status || 500).json({ code: err.code || 'error', message: err.message })
  }
}

async function unlink(req, res) {
  const userId = req.user._id
  await UserAuditLogHandler.promises.addEntry(userId, 'unlink-github', userId, req.ip, {})
  await User.updateOne(
    { _id: userId },
    {
      $set: { 'features.github': false },
      $pull: { thirdPartyIdentifiers: { providerId: 'github' } },
    }
  )
  await GitHubSyncManager.promises.unlinkAllForUser(userId)
  res.json({ ok: true })
}

async function importProject(req, res) {
  const { repoOwner, repoName, branch, projectName } = req.body
  if (!repoOwner || !repoName) {
    return res.status(400).json({ code: 'invalidParameters', message: 'repoOwner and repoName are required' })
  }
  try {
    const result = await GitHubSyncManager.promises.importProject(req.user._id, {
      repoOwner,
      repoName,
      branch,
      projectName,
    })
    res.json(result)
  } catch (err) {
    res.status(err.status || 400).json({ code: err.code || 'error', message: err.message })
  }
}

const GitHubOAuthRouter = {
  apply(webRouter) {
    const requireLogin = AuthenticationController.requireLogin()

    // 1. User OAuth Initiation
    webRouter.get('/auth/github/oauth', requireLogin, link)
    webRouter.get('/auth/github/link', requireLogin, link)
    webRouter.get('/auth/github-sync/oauth', requireLogin, link)
    webRouter.get('/user/github/link', requireLogin, link)

    // 2. User Status
    webRouter.get('/auth/github/status', requireLogin, status)
    webRouter.get('/auth/github-sync/status', requireLogin, status)
    webRouter.get('/user/github/status', requireLogin, status)

    // 3. User Repos
    webRouter.get('/auth/github/repos', requireLogin, repos)
    webRouter.get('/auth/github-sync/repos', requireLogin, repos)
    webRouter.get('/user/github/repos', requireLogin, repos)

    // 4. User Orgs
    webRouter.get('/auth/github/orgs', requireLogin, orgs)
    webRouter.get('/auth/github-sync/orgs', requireLogin, orgs)
    webRouter.get('/user/github/orgs', requireLogin, orgs)

    // 5. User Unlink Account
    webRouter.post('/auth/github/unlink', requireLogin, unlink)
    webRouter.post('/auth/github-sync/unlink', requireLogin, unlink)
    webRouter.post('/user/github/unlink', requireLogin, unlink)

    // 6. User Project Import
    webRouter.post('/auth/github/import', requireLogin, importProject)
    webRouter.post('/auth/github-sync/import', requireLogin, importProject)
    webRouter.post('/user/github/import', requireLogin, importProject)
  },
  applyNonCsrfRouter(webRouter) {
    const requireLogin = AuthenticationController.requireLogin()
    webRouter.get('/auth/github/callback', requireLogin, callback)
    webRouter.get('/auth/github-sync/callback', requireLogin, callback)
    webRouter.get('/user/github/callback', requireLogin, callback)
  },
}

export default GitHubOAuthRouter
export { GitHubOAuthRouter }
