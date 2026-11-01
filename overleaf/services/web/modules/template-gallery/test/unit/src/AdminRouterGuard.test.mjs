import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Settings from '@overleaf/settings'
import { DEFAULTS } from '../../../app/src/TemplateGalleryDefaults.mjs'
import { mergePlain } from './support/mergePlain.mjs'
import TemplateGalleryRouter from '../../../app/src/TemplateGalleryRouter.mjs'
import requireSiteAdminJson from '../../../app/src/middleware/requireSiteAdminJson.mjs'

function fakeRouter() {
  const routes = []
  const add =
    method =>
    (routePath, ...handlers) =>
      routes.push({ method, path: routePath, handlers })
  return {
    routes,
    get: add('GET'),
    post: add('POST'),
    patch: add('PATCH'),
    delete: add('DELETE'),
    use: add('USE'),
  }
}

describe('AdminRouterGuard (WP6)', () => {
  let router

  beforeEach(() => {
    Settings.enableTemplateGallery = true
    Settings.templateGallery = mergePlain(DEFAULTS, {})
    router = fakeRouter()
    TemplateGalleryRouter.apply(router)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('installs the prefix-level site admin middleware on /admin/templates/api', () => {
    const prefixGuard = router.routes.find(
      route => route.method === 'USE' && route.path === '/admin/templates/api'
    )
    expect(prefixGuard).toBeDefined()
    expect(prefixGuard.handlers).toContain(requireSiteAdminJson)
  })

  it('guarantees every route under /admin/templates/api has requireSiteAdminJson attached', () => {
    const apiRoutes = router.routes.filter(
      route =>
        route.path.startsWith('/admin/templates/api') && route.method !== 'USE'
    )
    expect(apiRoutes.length).toBe(20)
    for (const route of apiRoutes) {
      expect(
        route.handlers,
        `route ${route.method} ${route.path} missing requireSiteAdminJson`
      ).toContain(requireSiteAdminJson)
    }
  })

  it('protects both admin HTML pages with site admin guards', () => {
    const adminIndex = router.routes.find(
      route => route.method === 'GET' && route.path === '/admin/templates'
    )
    const adminItem = router.routes.find(
      route =>
        route.method === 'GET' && route.path === '/admin/templates/items/:id'
    )
    expect(adminIndex).toBeDefined()
    expect(adminItem).toBeDefined()
    expect(adminIndex.handlers.length).toBeGreaterThanOrEqual(3)
    expect(adminItem.handlers.length).toBeGreaterThanOrEqual(3)
  })
})
