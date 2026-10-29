import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import AuthorizationMiddleware from '../../../../app/src/Features/Authorization/AuthorizationMiddleware.mjs'
import GalleryController from './controllers/GalleryController.mjs'
import * as OpenController from './controllers/OpenController.mjs'
import * as SearchController from './controllers/SearchController.mjs'
import AdminController from './controllers/AdminController.mjs'
import GalleryReadService from './services/GalleryReadService.mjs'
import requireSiteAdminJson from './middleware/requireSiteAdminJson.mjs'
import { SCOPES, scopeBase } from './util/GalleryUrls.mjs'

// Item routes take a 12-letter token. Express matches routes
// case-insensitively, so the controllers re-check the token (and the .pdf
// suffix) and fall through to the 404 handler on a mismatch.
const ITEM = ':slug/:token([a-z]{12})'

const FAMILY_SCOPES = SCOPES.filter(scope => scope !== 'gallery')

export function apply(webRouter) {
  const requireLogin = AuthenticationController.requireLogin()

  if (typeof AuthenticationController.addEndpointToLoginWhitelist === 'function') {
    AuthenticationController.addEndpointToLoginWhitelist(
      /^\/(?:latex\/(?:templates|examples)|articles|gallery|templates)(?!\/.*\/open(?:\/|$|\?))(?:\/.*)?$/
    )
  }

  const ensureSiteAdminHtml =
    typeof AuthorizationMiddleware.ensureUserIsSiteAdmin === 'function'
      ? AuthorizationMiddleware.ensureUserIsSiteAdmin
      : requireSiteAdminJson

  // Public gallery pages, same URL space as overleaf.com. Listing, tag and
  // media routes come first so that e.g. /latex/templates/tagged/presentation
  // (a 12-letter tag) never reaches the item routes.
  for (const scope of SCOPES) {
    const base = scopeBase(scope)
    webRouter.get(base, GalleryController.renderScopeRoot(scope))
    webRouter.get(`${base}/recent`, GalleryController.renderRecent(scope))
    webRouter.get(`${base}/recent/page/:page`, GalleryController.renderRecent(scope))
    webRouter.get(`${base}/tagged/:name`, GalleryController.renderTagged(scope))
    webRouter.get(
      `${base}/tagged/:name/page/:page`,
      GalleryController.renderTagged(scope)
    )
  }

  webRouter.get('/gallery/_media/:token/thumb.jpg', GalleryController.serveThumbnail)
  webRouter.get('/gallery/_media/:token/preview.jpg', GalleryController.servePreview)
  webRouter.get('/gallery/api/search', SearchController.search)

  for (const scope of FAMILY_SCOPES) {
    const base = scopeBase(scope)
    webRouter.get(`${base}/${ITEM}.pdf`, GalleryController.servePdf)
    webRouter.get(`${base}/${ITEM}/open`, requireLogin, OpenController.renderOpenLoader)
    webRouter.post(
      `${base}/${ITEM}/open`,
      requireLogin,
      OpenController.openTemplate
    )
    webRouter.get(`${base}/${ITEM}`, GalleryController.renderDetail)
  }

  // Links of the previous module version
  webRouter.get('/templates', GalleryController.redirectLegacyGallery)
  webRouter.get('/templates/t/:slug', GalleryController.redirectLegacyItem())
  webRouter.get(
    '/templates/t/:slug/thumbnail',
    GalleryController.redirectLegacyItem('thumbnail')
  )
  webRouter.get(
    '/templates/t/:slug/preview.pdf',
    GalleryController.redirectLegacyItem('pdf')
  )

  const resolveLegacySlug = async (req, res, next) => {
    try {
      const item = await GalleryReadService.findLegacyItemBySlug(req.params?.slug)
      if (!item) return next()
      req.params = { ...req.params, token: item.token }
      next()
    } catch (err) {
      next(err)
    }
  }

  webRouter.post(
    '/templates/t/:slug/open',
    requireLogin,
    resolveLegacySlug,
    OpenController.openTemplate
  )

  // Admin HTML Page
  webRouter.get('/admin/templates', requireLogin, ensureSiteAdminHtml, AdminController.renderAdminPage)

  // Admin JSON API Routes
  webRouter.get('/admin/templates/api/status', requireSiteAdminJson, AdminController.getStatus)
  webRouter.get('/admin/templates/api/items', requireSiteAdminJson, AdminController.listItems)
  webRouter.get('/admin/templates/api/items/:id', requireSiteAdminJson, AdminController.getItem)
  webRouter.patch('/admin/templates/api/items/:id', requireSiteAdminJson, AdminController.patchItem)

  // BYO-ZIP & Package / Thumbnail Upload Routes
  webRouter.post('/admin/templates/api/uploads', requireSiteAdminJson, AdminController.uploadByoZip)
  webRouter.post('/admin/templates/api/items/:id/package', requireSiteAdminJson, AdminController.replaceItemPackage)
  webRouter.post('/admin/templates/api/items/:id/zip', requireSiteAdminJson, AdminController.replaceItemPackage)
  webRouter.post('/admin/templates/api/items/:id/thumbnail', requireSiteAdminJson, AdminController.uploadThumbnail)

  // Validation, Hydration, Licence & Publish Lifecycle Routes
  webRouter.post('/admin/templates/api/items/:id/validate', requireSiteAdminJson, AdminController.validateItem)
  webRouter.post('/admin/templates/api/items/:id/hydrate', requireSiteAdminJson, AdminController.hydrateItem)
  webRouter.post('/admin/templates/api/items/:id/licence-ack', requireSiteAdminJson, AdminController.acknowledgeLicence)
  webRouter.post('/admin/templates/api/items/:id/publish', requireSiteAdminJson, AdminController.publishItem)
  webRouter.post('/admin/templates/api/items/:id/unpublish', requireSiteAdminJson, AdminController.unpublishItem)
  webRouter.post('/admin/templates/api/items/:id/archive', requireSiteAdminJson, AdminController.archiveItem)
  webRouter.post('/admin/templates/api/items/:id/delete', requireSiteAdminJson, AdminController.deleteItem)
  webRouter.get('/admin/templates/api/items/:id/log', requireSiteAdminJson, AdminController.getValidationLog)
  webRouter.get('/admin/templates/api/jobs/:id', requireSiteAdminJson, AdminController.getJob)

  // Algolia Auto-Crawler & Tier-1 Cloud Session Credential Controls
  webRouter.post('/admin/templates/api/crawler/sync', requireSiteAdminJson, AdminController.triggerCrawlerSync)
  webRouter.post('/admin/templates/api/crawler/pause', requireSiteAdminJson, AdminController.pauseCrawler)
  webRouter.post('/admin/templates/api/crawler/resume', requireSiteAdminJson, AdminController.resumeCrawler)
  webRouter.post('/admin/templates/api/credentials/session', requireSiteAdminJson, AdminController.saveSessionCookie)
  webRouter.delete('/admin/templates/api/credentials/session', requireSiteAdminJson, AdminController.deleteSessionCookie)

  // Maintenance Runner & Sandbox Override Controls
  webRouter.post('/admin/templates/api/runner', requireSiteAdminJson, AdminController.controlRunner)
  webRouter.post('/admin/templates/api/validation/unsandboxed-ack', requireSiteAdminJson, AdminController.acknowledgeUnsandboxed)
}

const TemplateGalleryRouter = {
  openRateLimiter: OpenController.openRateLimiter,
  apply,
}

export default TemplateGalleryRouter
