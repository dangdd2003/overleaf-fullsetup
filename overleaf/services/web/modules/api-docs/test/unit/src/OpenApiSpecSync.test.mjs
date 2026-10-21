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

describe('openapi.json stays in sync with the real routers', function () {
  const allRoutes = [
    ...extractRoutes(
      path.join(WEB_ROOT, 'app/src/router.mjs'),
      'publicApiRouter'
    ),
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
    ...extractRoutes(
      path.join(MODULES, 'google-drive-sync/app/src/GoogleDriveRouter.mjs'),
      'publicApiRouter'
    ),
  ]

  it('found every known public route', function () {
    expect(allRoutes.length).to.equal(65)
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
