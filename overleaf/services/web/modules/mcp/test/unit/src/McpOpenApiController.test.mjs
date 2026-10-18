import { describe, it, expect } from 'vitest'
import Settings from '@overleaf/settings'
import McpOpenApiController from '../../../app/src/McpOpenApiController.mjs'
import McpRouter from '../../../app/src/McpRouter.mjs'

const MCP_PREFIX = '/api/v0/mcp'

/** Every /api/v0/mcp route McpRouter registers, as an OpenAPI method and path. */
function registeredRoutes() {
  const routes = []
  const recorder = method => path => {
    if (path.startsWith(MCP_PREFIX)) {
      routes.push({
        method,
        path: path.slice(MCP_PREFIX.length).replace(/:(\w+)/g, '{$1}'),
      })
    }
  }
  const publicApiRouter = {
    get: recorder('get'),
    post: recorder('post'),
    patch: recorder('patch'),
    delete: recorder('delete'),
  }
  const origEnableMcp = Settings.enableMcp
  Settings.enableMcp = true
  try {
    McpRouter.apply({}, {}, publicApiRouter)
  } finally {
    Settings.enableMcp = origEnableMcp
  }
  return routes
}

function fetchSpec() {
  const sent = {}
  const res = {
    setHeader() {},
    send(body) {
      sent.body = body
    },
  }
  McpOpenApiController.getSpec({}, res)
  return JSON.parse(sent.body)
}

describe('McpOpenApiController', () => {
  it('describes the clean endpoint and the page render options', () => {
    const { paths } = fetchSpec()
    expect(paths).toHaveProperty('/projects/{projectId}/compile/clean')
    const page = paths['/projects/{projectId}/compile/pdf-page'].get
    const names = page.parameters.map(p => p.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'endLine',
        'maxEdgePx',
        'grayscale',
        'split',
        'labels',
      ])
    )
  })

  it('describes every compiled-PDF path', () => {
    const { paths } = fetchSpec()
    expect(paths).toHaveProperty('/projects/{projectId}/compile/pdf-overview')
    expect(paths).toHaveProperty('/projects/{projectId}/compile/pdf-search')
    expect(paths).toHaveProperty('/projects/{projectId}/compile/pdf-block')
    expect(paths).toHaveProperty('/projects/{projectId}/compile/pdf-diff')
  })
})

describe('McpOpenApiController coverage', () => {
  // openapi.json serves the spec itself, so it is not described in it.
  const routes = registeredRoutes().filter(
    r => r.path !== '/openapi.json'
  )

  it('finds the registered routes', () => {
    expect(routes.length).toBeGreaterThan(40)
  })

  it('describes every route the MCP router registers', () => {
    const { paths } = fetchSpec()
    const missing = routes
      .filter(({ method, path }) => !paths[path]?.[method])
      .map(({ method, path }) => `${method.toUpperCase()} ${path}`)
    expect(missing).toEqual([])
  })

  it('describes no route the MCP router does not register', () => {
    const { paths } = fetchSpec()
    const registered = new Set(routes.map(({ method, path }) => `${method} ${path}`))
    const extra = []
    for (const [path, operations] of Object.entries(paths)) {
      for (const method of Object.keys(operations)) {
        if (!registered.has(`${method} ${path}`)) {
          extra.push(`${method.toUpperCase()} ${path}`)
        }
      }
    }
    expect(extra).toEqual([])
  })
})
