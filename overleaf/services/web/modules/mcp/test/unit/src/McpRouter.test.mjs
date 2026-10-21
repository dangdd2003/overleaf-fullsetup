import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import sinon from 'sinon'
import Settings from '@overleaf/settings'
import { EventEmitter } from 'node:events'
import McpRouter, {
  mcpHandler,
} from '../../../app/src/McpRouter.mjs'
import Errors from '../../../../../app/src/Features/Errors/Errors.js'

function makeRouter() {
  return {
    get: sinon.stub(),
    post: sinon.stub(),
    patch: sinon.stub(),
    delete: sinon.stub(),
    use: sinon.stub(),
  }
}

describe('McpRouter', function () {
  let webRouter, privateApiRouter, publicApiRouter
  let origEnableMcp

  beforeEach(function () {
    origEnableMcp = Settings.enableMcp
    webRouter = makeRouter()
    privateApiRouter = makeRouter()
    publicApiRouter = makeRouter()
  })

  afterEach(function () {
    Settings.enableMcp = origEnableMcp
  })

  function apply() {
    McpRouter.apply(webRouter, privateApiRouter, publicApiRouter)
  }

  it('registers no routes when enableMcp is false', function () {
    Settings.enableMcp = false
    apply()
    for (const r of [webRouter, privateApiRouter, publicApiRouter]) {
      expect(r.get.called).toBe(false)
      expect(r.post.called).toBe(false)
      expect(r.patch.called).toBe(false)
      expect(r.delete.called).toBe(false)
    }
  })

  it('registers the mcp routes on publicApiRouter (not webRouter) when enabled', function () {
    Settings.enableMcp = true
    apply()

    // nothing lands on webRouter — cookieless bearer clients would otherwise
    // be blocked by the global csurf middleware there.
    expect(webRouter.get.called).toBe(false)
    expect(webRouter.post.called).toBe(false)
    expect(webRouter.patch.called).toBe(false)

    expect(publicApiRouter.get.calledWith('/api/v0/mcp/projects')).toBe(true)
    expect(publicApiRouter.post.calledWith('/api/v0/mcp/projects')).toBe(true)
    expect(
      publicApiRouter.get.calledWith('/api/v0/mcp/projects/:projectId')
    ).toBe(true)
    expect(
      publicApiRouter.patch.calledWith(
        '/api/v0/mcp/projects/:projectId/settings'
      )
    ).toBe(true)
    expect(
      publicApiRouter.get.calledWith('/api/v0/mcp/projects/:projectId/tree')
    ).toBe(true)
    expect(
      publicApiRouter.post.calledWith('/api/v0/mcp/projects/:projectId/doc')
    ).toBe(true)
    expect(
      publicApiRouter.post.calledWith(
        '/api/v0/mcp/projects/:projectId/docs/read'
      )
    ).toBe(true)
    expect(
      publicApiRouter.post.calledWith('/api/v0/mcp/projects/:projectId/move')
    ).toBe(true)
    expect(
      publicApiRouter.get.calledWith('/api/v0/mcp/projects/:projectId/file')
    ).toBe(true)
    expect(
      publicApiRouter.post.calledWith('/api/v0/mcp/projects/:projectId/file')
    ).toBe(true)
    expect(
      publicApiRouter.post.calledWith('/api/v0/mcp/projects/:projectId/compile')
    ).toBe(true)
    expect(
      publicApiRouter.get.calledWith(
        '/api/v0/mcp/projects/:projectId/compile/log'
      )
    ).toBe(true)
    expect(
      publicApiRouter.get.calledWith(
        '/api/v0/mcp/projects/:projectId/compile/pdf'
      )
    ).toBe(true)
    expect(
      publicApiRouter.post.calledWith(
        '/api/v0/mcp/projects/:projectId/compile/clear-cache'
      )
    ).toBe(true)
    expect(
      publicApiRouter.post.calledWith(
        '/api/v0/mcp/projects/:projectId/compile/clean'
      )
    ).toBe(true)
    expect(
      publicApiRouter.get.calledWith(
        '/api/v0/mcp/projects/:projectId/compile/pdf-block'
      )
    ).toBe(true)
    expect(
      publicApiRouter.get.calledWith(
        '/api/v0/mcp/projects/:projectId/compile/pdf-diff'
      )
    ).toBe(true)
    expect(
      publicApiRouter.get.calledWith('/api/v0/mcp/projects/:projectId/wordcount')
    ).toBe(true)
    expect(
      publicApiRouter.get.calledWith('/api/v0/mcp/projects/:projectId/zip')
    ).toBe(true)
    expect(publicApiRouter.get.calledWith('/api/v0/mcp/projects-zip')).toBe(
      true
    )
    expect(publicApiRouter.post.calledWith('/api/v0/mcp/projects-zip')).toBe(
      true
    )
    expect(
      publicApiRouter.get.calledWith('/api/v0/mcp/projects/:projectId/synctex')
    ).toBe(true)
    expect(
      publicApiRouter.get.calledWith('/api/v0/mcp/projects/:projectId/search')
    ).toBe(true)
    expect(publicApiRouter.get.calledWith('/api/v0/mcp/openapi.json')).toBe(
      true
    )
  })

  it('registers GET /api/v0/mcp/openapi.json without authentication', function () {
    Settings.enableMcp = true
    apply()

    const openApiCall = publicApiRouter.get
      .getCalls()
      .find(c => c.args[0] === '/api/v0/mcp/openapi.json')
    expect(openApiCall).toBeDefined()
    const handlerNames = openApiCall.args.slice(1).map(h => h.name)
    expect(handlerNames).toEqual(['getSpec'])
  })

  it('guards search endpoint with auth and project read middleware', function () {
    Settings.enableMcp = true
    apply()

    const searchCall = publicApiRouter.get
      .getCalls()
      .find(c => c.args[0] === '/api/v0/mcp/projects/:projectId/search')
    expect(searchCall).toBeDefined()
    const handlerNames = searchCall.args.slice(1).map(h => h.name)
    expect(handlerNames[0]).toBe('requireMcpAuth')
    expect(handlerNames).toContain('requireMcpProjectRead')
  })

  it('guards project-scoped routes with the auth + authz middleware', function () {
    Settings.enableMcp = true
    apply()

    const treeCall = publicApiRouter.get
      .getCalls()
      .find(c => c.args[0] === '/api/v0/mcp/projects/:projectId/tree')
    const treeNames = treeCall.args.slice(1).map(h => h.name)
    expect(treeNames).toContain('requireMcpAuth')
    expect(treeNames).toContain('requireMcpProjectRead')

    const readDocsCall = publicApiRouter.post
      .getCalls()
      .find(c => c.args[0] === '/api/v0/mcp/projects/:projectId/docs/read')
    expect(readDocsCall.args.slice(1).map(h => h.name)).toContain(
      'requireMcpProjectRead'
    )
    expect(readDocsCall.args.slice(1).map(h => h.name)).not.toContain(
      'requireMcpProjectWrite'
    )

    const writeCall = publicApiRouter.post
      .getCalls()
      .find(c => c.args[0] === '/api/v0/mcp/projects/:projectId/doc')
    expect(writeCall.args.slice(1).map(h => h.name)).toContain(
      'requireMcpProjectWrite'
    )

    const clearCacheCall = publicApiRouter.post
      .getCalls()
      .find(
        c => c.args[0] === '/api/v0/mcp/projects/:projectId/compile/clear-cache'
      )
    expect(clearCacheCall.args.slice(1).map(h => h.name)).toContain(
      'requireMcpProjectWrite'
    )

    const fileCall = publicApiRouter.post
      .getCalls()
      .find(c => c.args[0] === '/api/v0/mcp/projects/:projectId/file')
    expect(fileCall.args.slice(1).map(h => h.name)).toContain(
      'requireMcpProjectWrite'
    )

    const compileCall = publicApiRouter.post
      .getCalls()
      .find(c => c.args[0] === '/api/v0/mcp/projects/:projectId/compile')
    expect(compileCall.args.slice(1).map(h => h.name)).toContain(
      'requireMcpProjectRead'
    )
  })

  it('registers the project status, copy and delete routes behind project read authz', function () {
    Settings.enableMcp = true
    apply()

    expect(
      publicApiRouter.post.calledWith('/api/v0/mcp/projects/:projectId/status')
    ).toBe(true)
    expect(
      publicApiRouter.post.calledWith('/api/v0/mcp/projects/:projectId/copy')
    ).toBe(true)
    expect(
      publicApiRouter.delete.calledWith('/api/v0/mcp/projects/:projectId')
    ).toBe(true)

    // copy and delete check ownership inside the controller, so the router
    // only requires read access up front.
    for (const [stub, path] of [
      [publicApiRouter.post, '/api/v0/mcp/projects/:projectId/status'],
      [publicApiRouter.post, '/api/v0/mcp/projects/:projectId/copy'],
      [publicApiRouter.delete, '/api/v0/mcp/projects/:projectId'],
    ]) {
      const call = stub.getCalls().find(c => c.args[0] === path)
      const names = call.args.slice(1).map(h => h.name)
      expect(names).toContain('requireMcpAuth')
      expect(names).toContain('requireMcpProjectRead')
    }
  })

  it('registers history reads behind read authz and restore behind write authz', function () {
    Settings.enableMcp = true
    apply()

    for (const [stub, path, guard] of [
      [publicApiRouter.get, '/api/v0/mcp/projects/:projectId/history', 'requireMcpProjectRead'],
      [publicApiRouter.get, '/api/v0/mcp/projects/:projectId/history/diff', 'requireMcpProjectRead'],
      [publicApiRouter.post, '/api/v0/mcp/projects/:projectId/history/restore', 'requireMcpProjectWrite'],
    ]) {
      const call = stub.getCalls().find(c => c.args[0] === path)
      expect(call, path).toBeDefined()
      const names = call.args.slice(1).map(h => h.name)
      expect(names).toContain('requireMcpAuth')
      expect(names).toContain(guard)
    }
  })

  it('registers tag routes behind auth with no project guard', function () {
    Settings.enableMcp = true
    apply()

    for (const [stub, path] of [
      [publicApiRouter.get, '/api/v0/mcp/tags'],
      [publicApiRouter.post, '/api/v0/mcp/tags'],
      [publicApiRouter.patch, '/api/v0/mcp/tags/:tagId'],
      [publicApiRouter.delete, '/api/v0/mcp/tags/:tagId'],
      [publicApiRouter.post, '/api/v0/mcp/tags/:tagId/projects'],
      [publicApiRouter.post, '/api/v0/mcp/tags/:tagId/projects/remove'],
    ]) {
      const call = stub.getCalls().find(c => c.args[0] === path)
      expect(call, path).toBeDefined()
      const names = call.args.slice(1).map(h => h.name)
      expect(names).toContain('requireMcpAuth')
      expect(names).not.toContain('requireMcpProjectRead')
    }
  })

  it('runs requireMcpAuth before the route handler on every authenticated route', function () {
    Settings.enableMcp = true
    apply()

    const allCalls = [
      ...publicApiRouter.get.getCalls(),
      ...publicApiRouter.post.getCalls(),
      ...publicApiRouter.patch.getCalls(),
      ...publicApiRouter.delete.getCalls(),
    ]
      .filter(c => String(c.args[0]).startsWith('/api/v0/mcp/'))
      .filter(c => c.args[0] !== '/api/v0/mcp/openapi.json')

    expect(allCalls.length).toBeGreaterThan(0)
    for (const c of allCalls) {
      const names = c.args.slice(1).map(h => h.name)
      expect(names[0], c.args[0]).toBe('requireMcpAuth')
    }
  })
})

describe('mcpHandler', function () {
  function fakeRes() {
    const res = { headersSent: false, statusCode: 200, body: null }
    res.status = s => {
      res.statusCode = s
      return res
    }
    res.json = body => {
      res.body = body
      return res
    }
    return res
  }

  async function runHandlerThrowing(err) {
    const res = fakeRes()
    const handler = mcpHandler(async () => {
      throw err
    })
    await handler({ route: { path: '/x' }, mcpUserId: 'u1' }, res, () => {})
    return res
  }

  it('reports a rejected file or folder name as a validation error', async function () {
    const res = await runHandlerThrowing(
      new Errors.InvalidNameError('blocked element name')
    )
    expect(res.statusCode).toBe(400)
    expect(res.body.code).toBe('validation_error')
    expect(res.body.message).toBe('blocked element name')
  })

  it('reports a name already in use as a conflict', async function () {
    const res = await runHandlerThrowing(
      new Errors.DuplicateNameError('file already exists')
    )
    expect(res.statusCode).toBe(409)
    expect(res.body.code).toBe('conflict')
  })

  it('reports a malformed id as not found', async function () {
    const castError = Object.assign(new Error('Cast to ObjectId failed'), {
      name: 'CastError',
    })
    const res = await runHandlerThrowing(castError)
    expect(res.statusCode).toBe(404)
    expect(res.body.code).toBe('not_found')
  })

  it('keeps unexpected errors as an upstream failure', async function () {
    const res = await runHandlerThrowing(new Error('boom'))
    expect(res.statusCode).toBe(502)
    expect(res.body.code).toBe('upstream_error')
  })
})
