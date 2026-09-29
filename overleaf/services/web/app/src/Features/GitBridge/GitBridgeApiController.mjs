import GitBridgeSnapshotManager from './GitBridgeSnapshotManager.mjs'
import GitBridgeFileTokenManager from './GitBridgeFileTokenManager.mjs'
import PersonalAccessTokenManager from '../PersonalAccessToken/PersonalAccessTokenManager.mjs'
import AuthorizationManager from '../Authorization/AuthorizationManager.mjs'
import Errors from '../Errors/Errors.js'
import logger from '@overleaf/logger'

function extractToken(req) {
  const authHeader = req.headers?.authorization || ''
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim()
  }
  if (authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8')
    const [user, ...pass] = decoded.split(':')
    const password = pass.join(':')
    if (password) return password.trim()
    if (user && user !== 'git') return user.trim()
    return null
  }
  if (typeof req.query?.access_token === 'string') {
    return req.query.access_token.trim()
  }
  return null
}

async function resolveAuthUser(req) {
  if (req.user?._id) return req.user._id
  if (req.session?.user?._id) return req.session.user._id
  if (req.oauth_user?._id) return req.oauth_user._id

  const token = extractToken(req)
  if (token) {
    try {
      const tokenInfo = await PersonalAccessTokenManager.validateToken(token)
      if (tokenInfo?.userId) {
        // Record that the caller authenticated via a personal access token and
        // which scopes that token carries, so `requireGitBridgeAuth` can
        // enforce the `git_bridge` scope. Session / oauth callers never set
        // these and are therefore unaffected.
        req.gitBridgeViaPat = true
        req.gitBridgePatScopes = Array.isArray(tokenInfo.scopes)
          ? tokenInfo.scopes
          : []
        return tokenInfo.userId
      }
    } catch (err) {
      logger.warn({ err }, 'failed to validate git-bridge auth token')
    }
  }
  return null
}

async function requireGitBridgeAuth(req, res, next) {
  if (req.gitBridgeUserId) return next()
  const userId = await resolveAuthUser(req)
  if (!userId) {
    return res
      .status(401)
      .json({ code: 'unauthorized', message: 'Valid authentication required' })
  }
  // A personal access token must carry the `git_bridge` scope to use the
  // git-bridge API. An `mcp`-only token is rejected here rather than silently
  // granting full git-bridge access. Session / oauth callers skip this check.
  if (req.gitBridgeViaPat && !(req.gitBridgePatScopes || []).includes('git_bridge')) {
    return res.status(403).json({
      code: 'insufficient_scope',
      message: 'token is missing the required git_bridge scope',
    })
  }
  req.gitBridgeUserId = userId
  return next()
}

async function requireProjectRead(req, res, next) {
  const userId = req.gitBridgeUserId || (await resolveAuthUser(req))
  const { projectId } = req.params

  if (!userId) {
    return res
      .status(401)
      .json({ code: 'unauthorized', message: 'Valid authentication required' })
  }
  req.gitBridgeUserId = userId

  try {
    const canRead = await AuthorizationManager.promises.canUserReadProject(
      userId,
      projectId,
      null
    )
    if (!canRead) {
      logger.warn(
        { userId, projectId },
        'requireProjectRead: canUserReadProject returned false — denying access'
      )
      return res
        .status(403)
        .json({ code: 'forbidden', message: 'No read access to project' })
    }
    return next()
  } catch (err) {
    logger.error(
      { err, projectId, userId },
      'requireProjectRead: error in canUserReadProject'
    )
    if (
      err instanceof Errors.NotFoundError ||
      err.name === 'CastError' ||
      err.name === 'BSONError'
    ) {
      return res
        .status(404)
        .json({ code: 'invalidProject', message: 'Project not found' })
    }
    logger.error({ err, projectId, userId }, 'error checking read access')
    return res.status(500).json({ code: 'error', message: err.message })
  }
}

async function requireProjectWrite(req, res, next) {
  const userId = req.gitBridgeUserId || (await resolveAuthUser(req))
  const { projectId } = req.params

  if (!userId) {
    return res
      .status(401)
      .json({ code: 'unauthorized', message: 'Valid authentication required' })
  }

  req.gitBridgeUserId = userId

  try {
    const canWrite =
      await AuthorizationManager.promises.canUserWriteProjectContent(
        userId,
        projectId,
        null
      )
    if (!canWrite) {
      return res
        .status(403)
        .json({ code: 'forbidden', message: 'No write access to project' })
    }
    return next()
  } catch (err) {
    if (
      err instanceof Errors.NotFoundError ||
      err.name === 'CastError' ||
      err.name === 'BSONError'
    ) {
      return res
        .status(404)
        .json({ code: 'invalidProject', message: 'Project not found' })
    }
    logger.error({ err, projectId, userId }, 'error checking write access')
    return res.status(500).json({ code: 'error', message: err.message })
  }
}

/**
 * Auth for the git-bridge binary file endpoint.
 *
 * git-bridge fetches attachment URLs from the snapshot API with a plain
 * unauthenticated GET, so those URLs carry a signed token scoped to a single
 * project + file. A valid token grants access to that file only. Requests
 * without one fall back to the normal PAT/session checks, so the endpoint
 * still works for an authenticated user hitting it directly.
 */
async function requireFileAccess(req, res, next) {
  const { projectId, fileId } = req.params
  const token = req.query?.token

  if (
    typeof token === 'string' &&
    GitBridgeFileTokenManager.verifyFileToken(token, projectId, fileId)
  ) {
    return next()
  }

  try {
    await requireGitBridgeAuth(req, res, async err => {
      if (err) return next(err)
      try {
        await requireProjectRead(req, res, next)
      } catch (readErr) {
        next(readErr)
      }
    })
  } catch (err) {
    next(err)
  }
}

/**
 * FileStoreController.getFile reads req.params.Project_id / File_id, the names
 * used by the editor's own file route. Map this route's params onto those.
 */
function adaptFileParams(req, res, next) {
  req.params.Project_id = req.params.projectId
  req.params.File_id = req.params.fileId
  return next()
}

const GitBridgeApiController = {
  requireGitBridgeAuth,
  requireProjectRead,
  requireProjectWrite,
  requireFileAccess,
  adaptFileParams,

  async getDoc(req, res) {
    const { projectId } = req.params
    try {
      const doc = await GitBridgeSnapshotManager.getDoc(projectId)
      if (!doc) {
        return res
          .status(404)
          .json({ code: 'invalidProject', message: 'Project not found' })
      }
      return res.json(doc)
    } catch (err) {
      logger.error({ err, projectId }, 'error in GitBridgeApiController.getDoc')
      return res.status(500).json({ code: 'error', message: err.message })
    }
  },

  async getSavedVers(req, res) {
    const { projectId } = req.params
    try {
      const savedVers = await GitBridgeSnapshotManager.getSavedVers(projectId)
      return res.json(savedVers)
    } catch (err) {
      logger.error(
        { err, projectId },
        'error in GitBridgeApiController.getSavedVers'
      )
      return res.status(500).json({ code: 'error', message: err.message })
    }
  },

  async getSnapshot(req, res) {
    const { projectId, versionId } = req.params
    try {
      const snapshot = await GitBridgeSnapshotManager.getSnapshotForVersion(
        projectId,
        parseInt(versionId, 10)
      )
      if (!snapshot) {
        return res
          .status(404)
          .json({ code: 'invalidProject', message: 'Snapshot not found' })
      }
      return res.json(snapshot)
    } catch (err) {
      logger.error(
        { err, projectId, versionId },
        'error in GitBridgeApiController.getSnapshot'
      )
      return res.status(500).json({ code: 'error', message: err.message })
    }
  },

  async pushSnapshot(req, res) {
    const { projectId } = req.params
    const { latestVerId, files, postbackUrl } = req.body || {}
    const userId = req.gitBridgeUserId

    try {
      const validation = await GitBridgeSnapshotManager.validatePushVersion(
        projectId,
        latestVerId
      )

      if (!validation.valid) {
        if (validation.code === 'outOfDate') {
          return res.status(409).json({
            status: 409,
            code: 'outOfDate',
            message: 'Out of Date',
          })
        }
        return res.status(404).json({
          status: 404,
          code: validation.code || 'invalidProject',
          message: 'Invalid Project',
        })
      }

      // Immediately accept
      res.status(202).json({
        status: 202,
        code: 'accepted',
        message: 'Accepted',
      })

      // Asynchronously process push updates
      GitBridgeSnapshotManager.processPush(
        projectId,
        userId,
        files,
        postbackUrl
      ).catch(err => {
        logger.error(
          { err, projectId },
          'uncaught error processing push in background'
        )
      })
    } catch (err) {
      logger.error({ err, projectId }, 'error in pushSnapshot')
      return res.status(500).json({ code: 'error', message: err.message })
    }
  },
}

export default GitBridgeApiController
