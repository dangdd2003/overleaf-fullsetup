import EgressController from './controllers/EgressController.mjs'

const BASE = '/admin/templates/api/egress'

// Outbound proxy admin routes. Mounted by TemplateGalleryRouter next to the
// other admin routes. Only GET, POST and DELETE are used.
export function registerEgressRoutes(
  webRouter,
  {
    requireSiteAdminJson,
    jsonParser,
    adminWriteRateLimit,
    adminHeavyRateLimit,
    controller = EgressController,
  }
) {
  webRouter.get(BASE, requireSiteAdminJson, controller.getEgress)
  webRouter.post(
    `${BASE}/proxies`,
    requireSiteAdminJson,
    jsonParser,
    adminWriteRateLimit,
    controller.createProxy
  )
  // Before `${BASE}/proxies/:id`, which would otherwise match 'bulk' as an id
  webRouter.post(
    `${BASE}/proxies/bulk`,
    requireSiteAdminJson,
    jsonParser,
    adminWriteRateLimit,
    controller.createProxiesBulk
  )
  webRouter.post(
    `${BASE}/proxies/:id`,
    requireSiteAdminJson,
    jsonParser,
    adminWriteRateLimit,
    controller.updateProxy
  )
  webRouter.delete(
    `${BASE}/proxies/:id`,
    requireSiteAdminJson,
    adminWriteRateLimit,
    controller.deleteProxy
  )
  webRouter.post(
    `${BASE}/proxies/:id/test`,
    requireSiteAdminJson,
    adminHeavyRateLimit,
    controller.testProxy
  )
}

export default { registerEgressRoutes }
