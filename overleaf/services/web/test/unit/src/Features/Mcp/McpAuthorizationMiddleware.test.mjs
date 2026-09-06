import { describe, it, expect, vi, beforeEach } from 'vitest'
import Errors from '../../../../../app/src/Features/Errors/Errors.js'

const canUserReadProject = vi.fn()
const canUserWriteProjectContent = vi.fn()
const loggerError = vi.fn()
vi.mock('@overleaf/logger', () => ({
  default: { error: (...a) => loggerError(...a), warn: vi.fn(), info: vi.fn() },
}))
vi.mock('../../../../../app/src/Features/Authorization/AuthorizationManager.mjs', () => ({
  default: { promises: { canUserReadProject, canUserWriteProjectContent } },
}))
const { requireMcpProjectRead, requireMcpProjectWrite } = await import(
  '../../../../../app/src/Features/Mcp/McpAuthorizationMiddleware.mjs'
)

function ctx(projectId = '507f1f77bcf86cd799439011') {
  const req = { mcpUserId: 'u1', params: { projectId } }
  const res = {
    statusCode: 0,
    body: null,
    status(s) {
      this.statusCode = s
      return this
    },
    json(b) {
      this.body = b
      return this
    },
  }
  return { req, res, next: vi.fn() }
}

beforeEach(() => {
  canUserReadProject.mockReset()
  canUserWriteProjectContent.mockReset()
  loggerError.mockReset()
})

describe('requireMcpProjectRead', () => {
  it('calls next when the user can read', async () => {
    canUserReadProject.mockResolvedValue(true)
    const { req, res, next } = ctx()
    await requireMcpProjectRead(req, res, next)
    expect(next).toHaveBeenCalled()
  })
  it('returns 404 not_found (not 403) when the user cannot read', async () => {
    canUserReadProject.mockResolvedValue(false)
    const { req, res, next } = ctx()
    await requireMcpProjectRead(req, res, next)
    expect(res.statusCode).toBe(404)
    expect(res.body.code).toBe('not_found')
    expect(next).not.toHaveBeenCalled()
  })
  it('returns 404 for a malformed project id', async () => {
    const { req, res, next } = ctx('not-an-id')
    canUserReadProject.mockRejectedValue(
      Object.assign(new Error('cast'), { name: 'CastError' })
    )
    await requireMcpProjectRead(req, res, next)
    expect(res.statusCode).toBe(404)
    expect(next).not.toHaveBeenCalled()
  })
  it('returns 502 upstream_error on an unexpected error', async () => {
    canUserReadProject.mockRejectedValue(new Error('boom'))
    const { req, res, next } = ctx()
    await requireMcpProjectRead(req, res, next)
    expect(res.statusCode).toBe(502)
    expect(res.body.code).toBe('upstream_error')
    expect(next).not.toHaveBeenCalled()
  })
  it('returns 404 not_found (no error log) when the project does not exist', async () => {
    canUserReadProject.mockRejectedValue(new Errors.NotFoundError('missing'))
    const { req, res, next } = ctx()
    await requireMcpProjectRead(req, res, next)
    expect(res.statusCode).toBe(404)
    expect(res.body.code).toBe('not_found')
    expect(loggerError).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })
})

describe('requireMcpProjectWrite', () => {
  it('calls next when the user can write', async () => {
    canUserWriteProjectContent.mockResolvedValue(true)
    const { req, res, next } = ctx()
    await requireMcpProjectWrite(req, res, next)
    expect(next).toHaveBeenCalled()
  })
  it('returns 403 forbidden when the user can read but not write', async () => {
    canUserWriteProjectContent.mockResolvedValue(false)
    canUserReadProject.mockResolvedValue(true)
    const { req, res, next } = ctx()
    await requireMcpProjectWrite(req, res, next)
    expect(res.statusCode).toBe(403)
    expect(res.body.code).toBe('forbidden')
    expect(next).not.toHaveBeenCalled()
  })
  it('returns 404 not_found when the user cannot even read', async () => {
    canUserWriteProjectContent.mockResolvedValue(false)
    canUserReadProject.mockResolvedValue(false)
    const { req, res, next } = ctx()
    await requireMcpProjectWrite(req, res, next)
    expect(res.statusCode).toBe(404)
    expect(res.body.code).toBe('not_found')
    expect(next).not.toHaveBeenCalled()
  })
  it('returns 404 for a malformed project id', async () => {
    canUserWriteProjectContent.mockRejectedValue(
      Object.assign(new Error('cast'), { name: 'BSONError' })
    )
    const { req, res, next } = ctx('not-an-id')
    await requireMcpProjectWrite(req, res, next)
    expect(res.statusCode).toBe(404)
    expect(next).not.toHaveBeenCalled()
  })
  it('returns 502 upstream_error on an unexpected error', async () => {
    canUserWriteProjectContent.mockRejectedValue(new Error('boom'))
    const { req, res, next } = ctx()
    await requireMcpProjectWrite(req, res, next)
    expect(res.statusCode).toBe(502)
    expect(res.body.code).toBe('upstream_error')
    expect(next).not.toHaveBeenCalled()
  })
  it('returns 404 not_found (no error log) when the project does not exist', async () => {
    canUserWriteProjectContent.mockRejectedValue(
      new Errors.NotFoundError('missing')
    )
    const { req, res, next } = ctx()
    await requireMcpProjectWrite(req, res, next)
    expect(res.statusCode).toBe(404)
    expect(res.body.code).toBe('not_found')
    expect(loggerError).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })
})
