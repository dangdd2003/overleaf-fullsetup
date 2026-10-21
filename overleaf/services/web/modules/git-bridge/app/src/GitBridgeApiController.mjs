import GitBridgeSnapshotManager from './GitBridgeSnapshotManager.mjs'
import GitBridgeFileTokenManager from './GitBridgeFileTokenManager.mjs'
import PersonalAccessTokenManager from '../../../../app/src/Features/PersonalAccessToken/PersonalAccessTokenManager.mjs'
import AuthorizationManager from '../../../../app/src/Features/Authorization/AuthorizationManager.mjs'
import Errors from '../../../../app/src/Features/Errors/Errors.js'
import HistoryManager from '../../../../app/src/Features/History/HistoryManager.mjs'
import crypto from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import logger from '@overleaf/logger'

// Generic 500 body. The error stays server-side, under the id the client gets.
function internalError(res, err) {
  const errorId = crypto.randomUUID()
  logger.error({ err, errorId }, 'internal error')
  return res
    .status(500)
    .json({ code: 'error', message: 'internal error', errorId })
}

// A Host header that names a host (and optional port), nothing else. Anything
// with a path, userinfo or query never becomes part of a URL this service builds.
const HOST_PATTERN = /^(\[[0-9a-f:.]+\]|[a-z0-9-]+(\.[a-z0-9-]+)*)(:\d{1,5})?$/i

/**
 * The web address git-bridge reached this request at. git-bridge calls the API
 * at its configured base URL, so the scheme and Host of that call name an
 * address git-bridge can use again. Snapshot file URLs are built on it.
 * Returns null when the scheme or Host cannot be used as an origin.
 *
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function requestOrigin(req) {
  const protocol = req.protocol
  const host = req.headers?.host
  if (protocol !== 'http' && protocol !== 'https') return null
  if (typeof host !== 'string' || !HOST_PATTERN.test(host)) return null
  try {
    return new URL(`${protocol}://${host}`).origin
  } catch {
    return null
  }
}

/**
 * Replaces the value of `name` in req.url and req.originalUrl with [REDACTED].
 */
function redactUrlParam(req, name) {
  const pattern = new RegExp(`([?&]${name}=)[^&]+`, 'g')
  if (typeof req.url === 'string' && req.url.includes(`${name}=`)) {
    req.url = req.url.replace(pattern, '$1[REDACTED]')
  }
  if (
    typeof req.originalUrl === 'string' &&
    req.originalUrl.includes(`${name}=`)
  ) {
    req.originalUrl = req.originalUrl.replace(pattern, '$1[REDACTED]')
  }
}

export function extractToken(req) {
  let queryToken = null
  if (typeof req?.query?.access_token === 'string') {
    const token = req.query.access_token.trim()
    req.query.access_token = token ? `${token.slice(0, 4)}...` : ''
    redactUrlParam(req, 'access_token')
    if (token) {
      queryToken = token
    }
  }

  let headerToken = null
  const authHeader = req?.headers?.authorization || ''
  if (authHeader.startsWith('Bearer ')) {
    headerToken = authHeader.slice(7).trim() || null
  } else if (authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8')
    const [user, ...pass] = decoded.split(':')
    const password = pass.join(':')
    if (password) {
      headerToken = password.trim() || null
    } else if (user && user !== 'git') {
      headerToken = user.trim() || null
    }
  }

  return headerToken || queryToken || null
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
    return internalError(res, err)
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
    return internalError(res, err)
  }
}

/**
 * The file URL's `token` is a credential for one file. The file route logs its
 * query string and URL (FileStoreController.getFile and the access log), so
 * replace the value before anything is logged. Same approach as extractToken.
 */
function redactFileToken(req) {
  if (req.query && typeof req.query === 'object' && 'token' in req.query) {
    req.query.token = '[REDACTED]'
  }
  redactUrlParam(req, 'token')
}

/** Falls back to the PAT / session check and then the project read check. */
async function requireAuthenticatedRead(req, res, next) {
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
  redactFileToken(req)

  if (
    typeof token === 'string' &&
    GitBridgeFileTokenManager.verifyFileToken(token, projectId, fileId)
  ) {
    return next()
  }

  return requireAuthenticatedRead(req, res, next)
}

/**
 * Auth for the git-bridge blob endpoint: the same rules as requireFileAccess,
 * but the signed token covers a content hash within the project.
 */
async function requireBlobAccess(req, res, next) {
  const { projectId, hash } = req.params
  const token = req.query?.token
  redactFileToken(req)

  if (
    typeof token === 'string' &&
    GitBridgeFileTokenManager.verifyBlobToken(token, projectId, hash)
  ) {
    return next()
  }

  return requireAuthenticatedRead(req, res, next)
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

// Content hashes are git-style SHA-1 hex digests, as history-v1 stores them.
const BLOB_HASH_PATTERN = /^[0-9a-f]{40}$/

const GitBridgeApiController = {
  extractToken,
  requireGitBridgeAuth,
  requireProjectRead,
  requireProjectWrite,
  requireFileAccess,
  requireBlobAccess,
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
      return internalError(res, err)
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
      return internalError(res, err)
    }
  },

  async getSnapshot(req, res) {
    const { projectId, versionId } = req.params
    const baseUrl = requestOrigin(req)
    if (!baseUrl) {
      return res
        .status(400)
        .json({ code: 'invalidHost', message: 'Host is not a valid address' })
    }
    try {
      const snapshot = await GitBridgeSnapshotManager.getSnapshotForVersion(
        projectId,
        parseInt(versionId, 10),
        baseUrl
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
      return internalError(res, err)
    }
  },

  /**
   * Serves a binary file by its content hash, from the project's history. Used
   * for files in an older snapshot that have no current copy to link to.
   */
  async getBlob(req, res) {
    const { projectId, hash } = req.params
    if (!BLOB_HASH_PATTERN.test(hash)) {
      return res
        .status(400)
        .json({ code: 'invalidHash', message: 'Invalid blob hash' })
    }
    let blob
    try {
      blob = await HistoryManager.promises.requestBlobWithProjectId(
        projectId,
        hash
      )
    } catch (err) {
      if (err instanceof Errors.NotFoundError) {
        return res
          .status(404)
          .json({ code: 'notFound', message: 'Blob not found' })
      }
      logger.error(
        { err, projectId, hash },
        'error in GitBridgeApiController.getBlob'
      )
      return internalError(res, err)
    }
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Cache-Control', 'private, max-age=3600')
    if (Number.isFinite(blob.contentLength)) {
      res.setHeader('Content-Length', blob.contentLength)
    }
    try {
      await pipeline(blob.stream, res)
    } catch (err) {
      logger.error(
        { err, projectId, hash },
        'error streaming blob to git-bridge'
      )
    }
  },

  async pushSnapshot(req, res) {
    const { projectId } = req.params
    const { latestVerId, files, postbackUrl } = req.body || {}
    const userId = req.gitBridgeUserId

    try {
      // Cheap checks first, so a malformed push is refused with a 400 rather
      // than accepted and failed later through the postback.
      const filesError = GitBridgeSnapshotManager.validatePushFiles(files)
      if (filesError) {
        return res
          .status(400)
          .json({ status: 400, code: 'invalidFiles', message: filesError })
      }

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
      return internalError(res, err)
    }
  },
}

export default GitBridgeApiController
