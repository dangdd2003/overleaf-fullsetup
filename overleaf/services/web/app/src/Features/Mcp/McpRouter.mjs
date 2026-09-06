import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import Errors from '../Errors/Errors.js'
import { requireMcpAuth } from './McpAuthMiddleware.mjs'
import {
  requireMcpProjectRead,
  requireMcpProjectWrite,
} from './McpAuthorizationMiddleware.mjs'
import McpProjectsController from './McpProjectsController.mjs'
import McpFilesController from './McpFilesController.mjs'
import McpCompileController from './McpCompileController.mjs'
import McpOpenApiController from './McpOpenApiController.mjs'
import McpErrors from './McpErrors.mjs'
import { RateLimiter } from '../../infrastructure/RateLimiter.mjs'

// Per-token rate limit for the MCP HTTP API. Keyed on the presented token
// (prefix + resolved user id) rather than the client IP, so one user's token
// cannot exhaust another's quota. Runs after `requireMcpAuth`.
const MCP_RATE_LIMIT_MAX_REQUESTS = 200
const MCP_RATE_LIMIT_INTERVAL_SEC = 60

const mcpRateLimiter = new RateLimiter('mcp-api', {
  points: MCP_RATE_LIMIT_MAX_REQUESTS,
  duration: MCP_RATE_LIMIT_INTERVAL_SEC,
})

// IP-keyed limiter that runs BEFORE authentication so an unauthenticated
// caller cannot force an unbounded number of Mongo lookups + sha256 hashes
// with junk tokens.
const mcpUnauthenticatedRateLimiter = new RateLimiter(
  'mcp-api-unauthenticated',
  { points: 60, duration: 60 }
)

function handleRateLimiterBackendError(err, res) {
  logger.warn({ err }, 'mcp rate limiter backend error')
  return McpErrors.send(res, McpErrors.CODES.UPSTREAM)
}

function mcpUnauthenticatedRateLimit(req, res, next) {
  mcpUnauthenticatedRateLimiter
    .consume(req.ip, 1, { method: 'ip' })
    .then(() => next())
    .catch(err => {
      if (err instanceof Error) {
        return handleRateLimiterBackendError(err, res)
      }
      return McpErrors.send(res, McpErrors.CODES.RATE_LIMITED)
    })
}

function mcpRateLimit(req, res, next) {
  const key = `${req.mcpTokenPrefix}:${req.mcpUserId}`
  mcpRateLimiter
    .consume(key, 1, { method: 'userId' })
    .then(() => next())
    .catch(err => {
      if (err instanceof Error) {
        return handleRateLimiterBackendError(err, res)
      }
      return McpErrors.send(res, McpErrors.CODES.RATE_LIMITED)
    })
}

/**
 * Wrap an async MCP route handler so a thrown manager error becomes a proper
 * McpErrors envelope instead of an Express 500 with a stack trace.
 */
function mcpHandler(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res, next)
    } catch (err) {
      if (res.headersSent) {
        return
      }
      if (err instanceof Errors.NotFoundError) {
        return McpErrors.send(res, McpErrors.CODES.NOT_FOUND)
      }
      logger.error(
        { err, route: req.route?.path, mcpUserId: req.mcpUserId },
        'mcp endpoint error'
      )
      return McpErrors.send(res, McpErrors.CODES.UPSTREAM)
    }
  }
}

const McpRouter = {
  apply(webRouter, privateApiRouter, publicApiRouter) {
    if (!Settings.enableMcp) {
      return
    }

    // Register on `publicApiRouter` (no session, no csurf, JSON error
    // handling), mirroring how git-bridge registers its `/api/v0/*` routes.
    // A cookieless `Authorization: Bearer` client would otherwise be blocked
    // by the global csurf middleware on `webRouter` for every write route.
    const router = publicApiRouter

    router.get(
      '/api/v0/mcp/openapi.json',
      mcpUnauthenticatedRateLimit,
      McpOpenApiController.getSpec
    )

    router.get(
      '/api/v0/mcp/projects',
      mcpUnauthenticatedRateLimit,
      requireMcpAuth,
      mcpRateLimit,
      mcpHandler(McpProjectsController.listProjects)
    )
    router.post(
      '/api/v0/mcp/projects',
      mcpUnauthenticatedRateLimit,
      requireMcpAuth,
      mcpRateLimit,
      mcpHandler(McpProjectsController.createProject)
    )
    router.get(
      '/api/v0/mcp/projects/:projectId',
      mcpUnauthenticatedRateLimit,
      requireMcpAuth,
      mcpRateLimit,
      requireMcpProjectRead,
      mcpHandler(McpProjectsController.getProject)
    )
    router.patch(
      '/api/v0/mcp/projects/:projectId/settings',
      mcpUnauthenticatedRateLimit,
      requireMcpAuth,
      mcpRateLimit,
      requireMcpProjectWrite,
      mcpHandler(McpProjectsController.updateSettings)
    )
    router.get(
      '/api/v0/mcp/projects/:projectId/tree',
      mcpUnauthenticatedRateLimit,
      requireMcpAuth,
      mcpRateLimit,
      requireMcpProjectRead,
      mcpHandler(McpFilesController.getTree)
    )
    router.get(
      '/api/v0/mcp/projects/:projectId/search',
      mcpUnauthenticatedRateLimit,
      requireMcpAuth,
      mcpRateLimit,
      requireMcpProjectRead,
      mcpHandler(McpFilesController.searchFiles)
    )
    router.get(
      '/api/v0/mcp/projects/:projectId/doc',
      mcpUnauthenticatedRateLimit,
      requireMcpAuth,
      mcpRateLimit,
      requireMcpProjectRead,
      mcpHandler(McpFilesController.getDoc)
    )
    router.post(
      '/api/v0/mcp/projects/:projectId/doc',
      mcpUnauthenticatedRateLimit,
      requireMcpAuth,
      mcpRateLimit,
      requireMcpProjectWrite,
      mcpHandler(McpFilesController.writeDoc)
    )
    router.post(
      '/api/v0/mcp/projects/:projectId/folder',
      mcpUnauthenticatedRateLimit,
      requireMcpAuth,
      mcpRateLimit,
      requireMcpProjectWrite,
      mcpHandler(McpFilesController.createFolder)
    )
    router.get(
      '/api/v0/mcp/projects/:projectId/file',
      mcpUnauthenticatedRateLimit,
      requireMcpAuth,
      mcpRateLimit,
      requireMcpProjectRead,
      mcpHandler(McpFilesController.downloadFile)
    )
    router.post(
      '/api/v0/mcp/projects/:projectId/file',
      mcpUnauthenticatedRateLimit,
      requireMcpAuth,
      mcpRateLimit,
      requireMcpProjectWrite,
      mcpHandler(McpFilesController.uploadFile)
    )
    router.post(
      '/api/v0/mcp/projects/:projectId/move',
      mcpUnauthenticatedRateLimit,
      requireMcpAuth,
      mcpRateLimit,
      requireMcpProjectWrite,
      mcpHandler(McpFilesController.moveEntity)
    )
    router.get(
      '/api/v0/mcp/projects/:projectId/zip',
      mcpUnauthenticatedRateLimit,
      requireMcpAuth,
      mcpRateLimit,
      requireMcpProjectRead,
      mcpHandler(McpFilesController.downloadProjectZip)
    )
    router.get(
      '/api/v0/mcp/projects-zip',
      mcpUnauthenticatedRateLimit,
      requireMcpAuth,
      mcpRateLimit,
      mcpHandler(McpFilesController.downloadMultipleProjectsZip)
    )
    router.post(
      '/api/v0/mcp/projects-zip',
      mcpUnauthenticatedRateLimit,
      requireMcpAuth,
      mcpRateLimit,
      mcpHandler(McpFilesController.downloadMultipleProjectsZip)
    )
    router.post(
      '/api/v0/mcp/projects/:projectId/compile',
      mcpUnauthenticatedRateLimit,
      requireMcpAuth,
      mcpRateLimit,
      requireMcpProjectRead,
      mcpHandler(McpCompileController.compile)
    )
    router.get(
      '/api/v0/mcp/projects/:projectId/compile/log',
      mcpUnauthenticatedRateLimit,
      requireMcpAuth,
      mcpRateLimit,
      requireMcpProjectRead,
      mcpHandler(McpCompileController.getLog)
    )
    router.get(
      '/api/v0/mcp/projects/:projectId/compile/pdf',
      mcpUnauthenticatedRateLimit,
      requireMcpAuth,
      mcpRateLimit,
      requireMcpProjectRead,
      mcpHandler(McpCompileController.getPdf)
    )
    router.post(
      '/api/v0/mcp/projects/:projectId/compile/clear-cache',
      mcpUnauthenticatedRateLimit,
      requireMcpAuth,
      mcpRateLimit,
      requireMcpProjectWrite,
      mcpHandler(McpCompileController.clearCache)
    )
    router.get(
      '/api/v0/mcp/projects/:projectId/wordcount',
      mcpUnauthenticatedRateLimit,
      requireMcpAuth,
      mcpRateLimit,
      requireMcpProjectRead,
      mcpHandler(McpCompileController.wordCount)
    )
    router.get(
      '/api/v0/mcp/projects/:projectId/synctex',
      mcpUnauthenticatedRateLimit,
      requireMcpAuth,
      mcpRateLimit,
      requireMcpProjectRead,
      mcpHandler(McpCompileController.synctex)
    )
  },
}

export default McpRouter
export { McpRouter, mcpHandler, mcpRateLimit, mcpUnauthenticatedRateLimit }
