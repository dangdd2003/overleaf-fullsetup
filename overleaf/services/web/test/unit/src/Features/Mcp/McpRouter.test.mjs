import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import sinon from 'sinon'
import Settings from '@overleaf/settings'
import McpRouter from '../../../../../app/src/Features/Mcp/McpRouter.mjs'

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

  it('registers GET /api/v0/mcp/openapi.json with unauthenticated rate limiting on publicApiRouter', function () {
    Settings.enableMcp = true
    apply()

    const openApiCall = publicApiRouter.get
      .getCalls()
      .find(c => c.args[0] === '/api/v0/mcp/openapi.json')
    expect(openApiCall).toBeDefined()
    const handlerNames = openApiCall.args.slice(1).map(h => h.name)
    expect(handlerNames[0]).toBe('mcpUnauthenticatedRateLimit')
    expect(handlerNames).toContain('getSpec')
    expect(handlerNames).not.toContain('requireMcpAuth')
  })

  it('guards search endpoint with auth and project read middleware', function () {
    Settings.enableMcp = true
    apply()

    const searchCall = publicApiRouter.get
      .getCalls()
      .find(c => c.args[0] === '/api/v0/mcp/projects/:projectId/search')
    expect(searchCall).toBeDefined()
    const handlerNames = searchCall.args.slice(1).map(h => h.name)
    expect(handlerNames[0]).toBe('mcpUnauthenticatedRateLimit')
    expect(handlerNames).toContain('requireMcpAuth')
    expect(handlerNames).toContain('mcpRateLimit')
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

  it('runs the IP limiter first, then requireMcpAuth, then mcpRateLimit on authenticated routes', function () {
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
      expect(names[0], c.args[0]).toBe('mcpUnauthenticatedRateLimit')
      const authIdx = names.indexOf('requireMcpAuth')
      expect(authIdx, c.args[0]).toBeGreaterThan(0)
      expect(names[authIdx + 1], c.args[0]).toBe('mcpRateLimit')
    }
  })
})
