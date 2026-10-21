import Settings from '@overleaf/settings'
import Errors from '../../../../app/src/Features/Errors/Errors.js'
import { requireMcpAuth } from './McpAuthMiddleware.mjs'
import {
  requireMcpProjectRead,
  requireMcpProjectWrite,
} from './McpAuthorizationMiddleware.mjs'
import McpProjectsController from './McpProjectsController.mjs'
import McpFilesController from './McpFilesController.mjs'
import McpCompileController from './McpCompileController.mjs'
import McpHistoryController from './McpHistoryController.mjs'
import McpTagsController from './McpTagsController.mjs'
import McpOpenApiController from './McpOpenApiController.mjs'
import McpErrors from './McpErrors.mjs'
import { getMcpRateLimiters, mcpRateLimited, rateLimitGate } from './McpRateLimit.mjs'

/**
 * Wrap an async MCP route handler so a thrown manager error becomes a proper
 * McpErrors envelope instead of an Express 500 with a stack trace.
 *
 * Domain rejections (a blocked or over-long file name, a name already in use)
 * and malformed ids are reported as the client error they are. Anything else
 * is an upstream failure and is logged.
 */
function mcpHandler(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res, next)
    } catch (err) {
      if (res.headersSent) {
        return
      }
      if (
        err instanceof Errors.NotFoundError ||
        err?.name === 'CastError' ||
        err?.name === 'BSONError'
      ) {
        return McpErrors.send(res, McpErrors.CODES.NOT_FOUND)
      }
      if (err instanceof Errors.InvalidNameError) {
        return McpErrors.send(res, McpErrors.CODES.VALIDATION, err.message)
      }
      if (err instanceof Errors.DuplicateNameError) {
        return McpErrors.send(res, McpErrors.CODES.CONFLICT, err.message)
      }
      return McpErrors.sendInternal(res, err, {
        route: req.route?.path,
        mcpUserId: req.mcpUserId,
      })
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

    // The per-IP budget is checked before authentication in the request guard
    // (McpRequestGuard.mjs, mounted ahead of the body parsers). This is the
    // per-token budget, applied after authentication on protected endpoints.
    const tokenRateLimit = rateLimitGate(getMcpRateLimiters().token, {
      getUserId: req => req.mcpTokenId,
      respond: mcpRateLimited,
    })
    function requireMcpAuthWithRateLimit(req, res, next) {
      return requireMcpAuth(req, res, () => tokenRateLimit(req, res, next))
    }
    Object.defineProperty(requireMcpAuthWithRateLimit, 'name', {
      value: 'requireMcpAuth',
    })

    router.get(
      '/api/v0/mcp/openapi.json',
      McpOpenApiController.getSpec
    )

    router.get(
      '/api/v0/mcp/projects',
      requireMcpAuthWithRateLimit,
      mcpHandler(McpProjectsController.listProjects)
    )
    router.post(
      '/api/v0/mcp/projects',
      requireMcpAuthWithRateLimit,
      mcpHandler(McpProjectsController.createProject)
    )
    router.get(
      '/api/v0/mcp/projects/:projectId',
      requireMcpAuthWithRateLimit,
      requireMcpProjectRead,
      mcpHandler(McpProjectsController.getProject)
    )
    router.patch(
      '/api/v0/mcp/projects/:projectId/settings',
      requireMcpAuthWithRateLimit,
      requireMcpProjectWrite,
      mcpHandler(McpProjectsController.updateSettings)
    )
    router.post(
      '/api/v0/mcp/projects/:projectId/status',
      requireMcpAuthWithRateLimit,
      requireMcpProjectRead,
      mcpHandler(McpProjectsController.setStatus)
    )
    router.post(
      '/api/v0/mcp/projects/:projectId/copy',
      requireMcpAuthWithRateLimit,
      requireMcpProjectRead,
      mcpHandler(McpProjectsController.copyProject)
    )
    router.delete(
      '/api/v0/mcp/projects/:projectId',
      requireMcpAuthWithRateLimit,
      requireMcpProjectRead,
      mcpHandler(McpProjectsController.deleteProject)
    )
    router.get(
      '/api/v0/mcp/projects/:projectId/tree',
      requireMcpAuthWithRateLimit,
      requireMcpProjectRead,
      mcpHandler(McpFilesController.getTree)
    )
    router.get(
      '/api/v0/mcp/projects/:projectId/search',
      requireMcpAuthWithRateLimit,
      requireMcpProjectRead,
      mcpHandler(McpFilesController.searchFiles)
    )
    router.get(
      '/api/v0/mcp/projects/:projectId/doc',
      requireMcpAuthWithRateLimit,
      requireMcpProjectRead,
      mcpHandler(McpFilesController.getDoc)
    )
    router.post(
      '/api/v0/mcp/projects/:projectId/docs/read',
      requireMcpAuthWithRateLimit,
      requireMcpProjectRead,
      mcpHandler(McpFilesController.readDocs)
    )
    router.post(
      '/api/v0/mcp/projects/:projectId/doc',
      requireMcpAuthWithRateLimit,
      requireMcpProjectWrite,
      mcpHandler(McpFilesController.writeDoc)
    )
    router.post(
      '/api/v0/mcp/projects/:projectId/folder',
      requireMcpAuthWithRateLimit,
      requireMcpProjectWrite,
      mcpHandler(McpFilesController.createFolder)
    )
    router.get(
      '/api/v0/mcp/projects/:projectId/file',
      requireMcpAuthWithRateLimit,
      requireMcpProjectRead,
      mcpHandler(McpFilesController.downloadFile)
    )
    router.post(
      '/api/v0/mcp/projects/:projectId/file',
      requireMcpAuthWithRateLimit,
      requireMcpProjectWrite,
      mcpHandler(McpFilesController.uploadFile)
    )
    router.delete(
      '/api/v0/mcp/projects/:projectId/file',
      requireMcpAuthWithRateLimit,
      requireMcpProjectWrite,
      mcpHandler(McpFilesController.deleteEntity)
    )
    router.post(
      '/api/v0/mcp/projects/:projectId/move',
      requireMcpAuthWithRateLimit,
      requireMcpProjectWrite,
      mcpHandler(McpFilesController.moveEntity)
    )
    router.get(
      '/api/v0/mcp/projects/:projectId/zip',
      requireMcpAuthWithRateLimit,
      requireMcpProjectRead,
      mcpHandler(McpFilesController.downloadProjectZip)
    )
    router.get(
      '/api/v0/mcp/projects-zip',
      requireMcpAuthWithRateLimit,
      mcpHandler(McpFilesController.downloadMultipleProjectsZip)
    )
    router.post(
      '/api/v0/mcp/projects-zip',
      requireMcpAuthWithRateLimit,
      mcpHandler(McpFilesController.downloadMultipleProjectsZip)
    )
    router.post(
      '/api/v0/mcp/projects/:projectId/compile',
      requireMcpAuthWithRateLimit,
      requireMcpProjectRead,
      mcpHandler(McpCompileController.compile)
    )
    router.get(
      '/api/v0/mcp/projects/:projectId/compile/log',
      requireMcpAuthWithRateLimit,
      requireMcpProjectRead,
      mcpHandler(McpCompileController.getLog)
    )
    router.get(
      '/api/v0/mcp/projects/:projectId/compile/diagnostics',
      requireMcpAuthWithRateLimit,
      requireMcpProjectRead,
      mcpHandler(McpCompileController.getDiagnostics)
    )
    router.get(
      '/api/v0/mcp/projects/:projectId/compile/pdf',
      requireMcpAuthWithRateLimit,
      requireMcpProjectRead,
      mcpHandler(McpCompileController.getPdf)
    )
    router.get(
      '/api/v0/mcp/projects/:projectId/compile/pdf-page',
      requireMcpAuthWithRateLimit,
      requireMcpProjectRead,
      mcpHandler(McpCompileController.getPdfPage)
    )
    router.get(
      '/api/v0/mcp/projects/:projectId/compile/pdf-overview',
      requireMcpAuthWithRateLimit,
      requireMcpProjectRead,
      mcpHandler(McpCompileController.getPdfOverview)
    )
    router.get(
      '/api/v0/mcp/projects/:projectId/compile/pdf-search',
      requireMcpAuthWithRateLimit,
      requireMcpProjectRead,
      mcpHandler(McpCompileController.searchPdf)
    )
    router.post(
      '/api/v0/mcp/projects/:projectId/compile/clean',
      requireMcpAuthWithRateLimit,
      requireMcpProjectWrite,
      mcpHandler(McpCompileController.clean)
    )
    // Deprecated name for compile/clean, still served for older MCP services.
    router.post(
      '/api/v0/mcp/projects/:projectId/compile/clear-cache',
      requireMcpAuthWithRateLimit,
      requireMcpProjectWrite,
      mcpHandler(McpCompileController.clearCache)
    )
    router.get(
      '/api/v0/mcp/projects/:projectId/compile/pdf-diff',
      requireMcpAuthWithRateLimit,
      requireMcpProjectRead,
      mcpHandler(McpCompileController.getPdfDiff)
    )
    router.get(
      '/api/v0/mcp/projects/:projectId/compile/pdf-block',
      requireMcpAuthWithRateLimit,
      requireMcpProjectRead,
      mcpHandler(McpCompileController.getPdfBlock)
    )
    router.get(
      '/api/v0/mcp/projects/:projectId/wordcount',
      requireMcpAuthWithRateLimit,
      requireMcpProjectRead,
      mcpHandler(McpCompileController.wordCount)
    )
    router.get(
      '/api/v0/mcp/projects/:projectId/synctex',
      requireMcpAuthWithRateLimit,
      requireMcpProjectRead,
      mcpHandler(McpCompileController.synctex)
    )

    router.get(
      '/api/v0/mcp/projects/:projectId/history',
      requireMcpAuthWithRateLimit,
      requireMcpProjectRead,
      mcpHandler(McpHistoryController.listHistory)
    )
    router.get(
      '/api/v0/mcp/projects/:projectId/history/diff',
      requireMcpAuthWithRateLimit,
      requireMcpProjectRead,
      mcpHandler(McpHistoryController.getDiff)
    )
    router.post(
      '/api/v0/mcp/projects/:projectId/history/restore',
      requireMcpAuthWithRateLimit,
      requireMcpProjectWrite,
      mcpHandler(McpHistoryController.restoreFile)
    )

    // Tags belong to the caller, so there is no project-level guard here.
    router.get(
      '/api/v0/mcp/tags',
      requireMcpAuthWithRateLimit,
      mcpHandler(McpTagsController.listTags)
    )
    router.post(
      '/api/v0/mcp/tags',
      requireMcpAuthWithRateLimit,
      mcpHandler(McpTagsController.createTag)
    )
    router.patch(
      '/api/v0/mcp/tags/:tagId',
      requireMcpAuthWithRateLimit,
      mcpHandler(McpTagsController.updateTag)
    )
    router.delete(
      '/api/v0/mcp/tags/:tagId',
      requireMcpAuthWithRateLimit,
      mcpHandler(McpTagsController.deleteTag)
    )
    router.post(
      '/api/v0/mcp/tags/:tagId/projects',
      requireMcpAuthWithRateLimit,
      mcpHandler(McpTagsController.addProjects)
    )
    router.post(
      '/api/v0/mcp/tags/:tagId/projects/remove',
      requireMcpAuthWithRateLimit,
      mcpHandler(McpTagsController.removeProjects)
    )
  },
}

export default McpRouter
export { McpRouter, mcpHandler }
