import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import openApiSpec from '../../../app/src/openapi.json' with { type: 'json' }

const WEB_ROOT = path.resolve(import.meta.dirname, '../../../../..')
const MODULES = path.join(WEB_ROOT, 'modules')

function extractRoutes(filePath, callPrefix) {
  const source = fs.readFileSync(filePath, 'utf8')
  const pattern = new RegExp(
    `\\b${callPrefix}\\.(get|post|put|patch|delete)\\(\\s*['"]([^'"]+)['"]`,
    'g'
  )
  const routes = []
  let match
  while ((match = pattern.exec(source))) {
    const [, method, expressPath] = match
    const openApiPath = expressPath.replace(/:([a-zA-Z0-9_]+)/g, '{$1}')
    routes.push({ method, path: openApiPath })
  }
  return routes
}

// The consent form submit is posted by the browser page served from
// GET /oauth/authorize, so it is documented as part of that endpoint.
// Extended MCP routes (diagnostics, visual PDF diff, tags, history) and
// token revocation are documented by MCP's own openapi.json.
const NOT_DOCUMENTED = new Set([
  'post /oauth/authorize',
  'post /oauth/revoke',
  'post /api/v0/mcp/projects/{projectId}/status',
  'post /api/v0/mcp/projects/{projectId}/copy',
  'delete /api/v0/mcp/projects/{projectId}',
  'delete /api/v0/mcp/projects/{projectId}/file',
  'get /api/v0/mcp/projects/{projectId}/compile/diagnostics',
  'get /api/v0/mcp/projects/{projectId}/compile/pdf-page',
  'get /api/v0/mcp/projects/{projectId}/compile/pdf-overview',
  'get /api/v0/mcp/projects/{projectId}/compile/pdf-search',
  'post /api/v0/mcp/projects/{projectId}/compile/clean',
  'get /api/v0/mcp/projects/{projectId}/compile/pdf-diff',
  'get /api/v0/mcp/projects/{projectId}/compile/pdf-block',
  'get /api/v0/mcp/projects/{projectId}/history',
  'get /api/v0/mcp/projects/{projectId}/history/diff',
  'post /api/v0/mcp/projects/{projectId}/history/restore',
  'get /api/v0/mcp/tags',
  'post /api/v0/mcp/tags',
  'patch /api/v0/mcp/tags/{tagId}',
  'delete /api/v0/mcp/tags/{tagId}',
  'post /api/v0/mcp/tags/{tagId}/projects',
  'post /api/v0/mcp/tags/{tagId}/projects/remove',
])

describe('openapi.json stays in sync with the real routers', function () {
  const allRoutes = [
    ...extractRoutes(
      path.join(MODULES, 'git-bridge/app/src/GitBridgeRouter.mjs'),
      'r'
    ),
    ...extractRoutes(
      path.join(
        MODULES,
        'personal-access-token/app/src/PersonalAccessTokenRouter.mjs'
      ),
      'webRouter'
    ),
    ...extractRoutes(
      path.join(MODULES, 'mcp/app/src/McpRouter.mjs'),
      'router'
    ),
    ...extractRoutes(
      path.join(MODULES, 'mcp/app/src/OAuth2/OAuth2Router.mjs'),
      'r'
    ),
    ...extractRoutes(
      path.join(MODULES, 'mcp/app/src/OAuth2/OAuth2Router.mjs'),
      'publicApiRouter'
    ),
    ...extractRoutes(
      path.join(MODULES, 'mcp/app/src/OAuth2/OAuth2Router.mjs'),
      'webRouter'
    ),
  ].filter(({ method, path: p }) => !NOT_DOCUMENTED.has(`${method} ${p}`))

  it('found every known public route', function () {
    expect(allRoutes.length).to.equal(37)
  })

  it('documents every extracted route with a matching method', function () {
    const missing = []
    for (const { method, path: routePath } of allRoutes) {
      const documented = openApiSpec.paths?.[routePath]?.[method]
      if (!documented) {
        missing.push(`${method.toUpperCase()} ${routePath}`)
      }
    }
    expect(missing, `undocumented routes: ${missing.join(', ')}`).to.deep.equal(
      []
    )
  })

  it('does not document operations that have no route', function () {
    const routes = new Set(allRoutes.map(r => `${r.method} ${r.path}`))
    const stale = []
    for (const [routePath, operations] of Object.entries(openApiSpec.paths)) {
      for (const method of Object.keys(operations)) {
        if (!routes.has(`${method} ${routePath}`)) {
          stale.push(`${method.toUpperCase()} ${routePath}`)
        }
      }
    }
    expect(
      stale,
      `documented but not routed: ${stale.join(', ')}`
    ).to.deep.equal([])
  })
})
