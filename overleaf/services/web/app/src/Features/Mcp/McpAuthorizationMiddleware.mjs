import logger from '@overleaf/logger'
import AuthorizationManager from '../Authorization/AuthorizationManager.mjs'
import Errors from '../Errors/Errors.js'
import McpErrors from './McpErrors.mjs'

function isBadIdError(err) {
  return err && (err.name === 'CastError' || err.name === 'BSONError')
}

/**
 * Shared catch handler for the project authz middleware.
 *
 * A well-formed but nonexistent project id makes `CollaboratorsGetter` throw
 * `Errors.NotFoundError`. Treat that exactly like a malformed id — a plain
 * `404 not_found`, no `logger.error` — so the API never becomes a
 * project-existence oracle (spec §5.5, §12) and a missing project does not
 * flood the error log. A genuine unexpected error is still a `502`.
 */
function handleAuthzError(err, req, res, logMessage) {
  const { projectId } = req.params
  if (isBadIdError(err) || err instanceof Errors.NotFoundError) {
    return McpErrors.send(res, McpErrors.CODES.NOT_FOUND)
  }
  logger.error({ err, projectId, mcpUserId: req.mcpUserId }, logMessage)
  return McpErrors.send(res, McpErrors.CODES.UPSTREAM)
}

async function requireMcpProjectRead(req, res, next) {
  const { projectId } = req.params
  try {
    const canRead = await AuthorizationManager.promises.canUserReadProject(
      req.mcpUserId,
      projectId,
      null
    )
    if (!canRead) {
      return McpErrors.send(res, McpErrors.CODES.NOT_FOUND)
    }
    return next()
  } catch (err) {
    return handleAuthzError(err, req, res, 'mcp read authz error')
  }
}

async function requireMcpProjectWrite(req, res, next) {
  const { projectId } = req.params
  try {
    const canWrite =
      await AuthorizationManager.promises.canUserWriteProjectContent(
        req.mcpUserId,
        projectId,
        null
      )
    if (canWrite) {
      return next()
    }
    const canRead = await AuthorizationManager.promises.canUserReadProject(
      req.mcpUserId,
      projectId,
      null
    )
    return McpErrors.send(
      res,
      canRead ? McpErrors.CODES.FORBIDDEN : McpErrors.CODES.NOT_FOUND
    )
  } catch (err) {
    return handleAuthzError(err, req, res, 'mcp write authz error')
  }
}

export default { requireMcpProjectRead, requireMcpProjectWrite }
export { requireMcpProjectRead, requireMcpProjectWrite }
