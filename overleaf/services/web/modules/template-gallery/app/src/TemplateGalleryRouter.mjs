import express from 'express'
import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import AuthorizationMiddleware from '../../../../app/src/Features/Authorization/AuthorizationMiddleware.mjs'
import RateLimiterMiddleware from '../../../../app/src/Features/Security/RateLimiterMiddleware.mjs'
import { RateLimiter } from '../../../../app/src/infrastructure/RateLimiter.mjs'
import GalleryController from './controllers/GalleryController.mjs'
import * as OpenController from './controllers/OpenController.mjs'
import * as SearchController from './controllers/SearchController.mjs'
import AdminController from './controllers/AdminController.mjs'
import { registerEgressRoutes } from './EgressRoutes.mjs'
import GalleryReadService from './services/GalleryReadService.mjs'
import requireSiteAdminJson from './middleware/requireSiteAdminJson.mjs'
import { SCOPES, scopeBase } from './util/GalleryUrls.mjs'

// Item routes take a 12-letter token. Express matches routes
// case-insensitively, so the controllers re-check the token (and the .pdf
// suffix) and fall through to the 404 handler on a mismatch.
const ITEM = ':slug/:token([a-z]{12})'

const FAMILY_SCOPES = SCOPES.filter(scope => scope !== 'gallery')

// Admin rate limits, per user. Writes allow 60 a minute; hydration and source
// refetch (upstream work) allow 10.
function adminRateLimit(name, points) {
  return RateLimiterMiddleware.rateLimit(
    new RateLimiter(name, { points, duration: 60 }),
    {
      onLimited(res, limiterRes) {
        res.set(
          'Retry-After',
          String(Math.ceil((limiterRes?.msBeforeNext || 60_000) / 1000))
        )
        res.status(429).json({ error: 'rate_limited' })
      },
    }
  )
}

const adminWriteRateLimit = adminRateLimit('template-gallery-admin-write', 60)
const adminHeavyRateLimit = adminRateLimit('template-gallery-admin-heavy', 10)

// The session cookie is a single short string; keep its body small.
const credentialJsonParser = express.json({ limit: '16kb' })

export function apply(webRouter) {
  const requireLogin = AuthenticationController.requireLogin()

  if (
    typeof AuthenticationController.addEndpointToLoginWhitelist === 'function'
  ) {
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
    webRouter.get(
      `${base}/recent/page/:page`,
      GalleryController.renderRecent(scope)
    )
    webRouter.get(`${base}/tagged/:name`, GalleryController.renderTagged(scope))
    webRouter.get(
      `${base}/tagged/:name/page/:page`,
      GalleryController.renderTagged(scope)
    )
  }

  webRouter.get(
    '/gallery/_media/:token/thumb.jpg',
    GalleryController.serveThumbnail
  )
  webRouter.get(
    '/gallery/_media/:token/preview.jpg',
    GalleryController.servePreview
  )
  webRouter.get('/gallery/api/search', SearchController.search)

  for (const scope of FAMILY_SCOPES) {
    const base = scopeBase(scope)
    webRouter.get(`${base}/${ITEM}.pdf`, GalleryController.servePdf)
    webRouter.get(
      `${base}/${ITEM}/open`,
      requireLogin,
      OpenController.renderOpenLoader
    )
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
      const item = await GalleryReadService.findLegacyItemBySlug(
        req.params?.slug
      )
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

  // Admin HTML pages
  webRouter.get(
    '/admin/templates',
    requireLogin,
    ensureSiteAdminHtml,
    AdminController.renderAdminPage
  )
  webRouter.get(
    '/admin/templates/items/:id',
    requireLogin,
    ensureSiteAdminHtml,
    AdminController.renderItemPage
  )

  // Admin JSON API Routes. The site-admin check runs for the whole prefix, so
  // an unknown or newly added route under it is refused as well (defence in
  // depth; each route below also lists the guard).
  webRouter.use('/admin/templates/api', requireSiteAdminJson)

  // Sync overview
  webRouter.get(
    '/admin/templates/api/status',
    requireSiteAdminJson,
    AdminController.getStatus
  )
  webRouter.get(
    '/admin/templates/api/status/summary',
    requireSiteAdminJson,
    AdminController.getStatusSummary
  )

  // Templates: mirrored items, detail and upstream refetch
  webRouter.get(
    '/admin/templates/api/items',
    requireSiteAdminJson,
    AdminController.listItems
  )
  webRouter.get(
    '/admin/templates/api/items/:id',
    requireSiteAdminJson,
    AdminController.getItem
  )
  webRouter.post(
    '/admin/templates/api/items/:id/hydrate',
    requireSiteAdminJson,
    adminHeavyRateLimit,
    AdminController.hydrateItem
  )
  webRouter.post(
    '/admin/templates/api/items/:id/source',
    requireSiteAdminJson,
    adminHeavyRateLimit,
    AdminController.refetchSource
  )

  // Sync: start a run now, or stop the running one
  webRouter.post(
    '/admin/templates/api/crawler/sync',
    requireSiteAdminJson,
    adminWriteRateLimit,
    AdminController.triggerCrawlerSync
  )
  webRouter.post(
    '/admin/templates/api/crawler/sync/stop',
    requireSiteAdminJson,
    adminWriteRateLimit,
    AdminController.stopCrawlerSync
  )

  // Outbound proxies used for requests to overleaf.com, Algolia and S3
  registerEgressRoutes(webRouter, {
    requireSiteAdminJson,
    jsonParser: credentialJsonParser,
    adminWriteRateLimit,
    adminHeavyRateLimit,
  })

  // Sync settings: automatic sync and refetch interval
  webRouter.get(
    '/admin/templates/api/settings',
    requireSiteAdminJson,
    AdminController.getSyncSettings
  )
  webRouter.post(
    '/admin/templates/api/settings',
    requireSiteAdminJson,
    credentialJsonParser,
    adminWriteRateLimit,
    AdminController.saveSyncSettings
  )

  // Overleaf.com session cookie, used by Tier 1 of "Open as template"
  webRouter.get(
    '/admin/templates/api/credentials/session',
    requireSiteAdminJson,
    AdminController.getCredential
  )
  webRouter.post(
    '/admin/templates/api/credentials/session',
    requireSiteAdminJson,
    credentialJsonParser,
    adminWriteRateLimit,
    AdminController.saveSessionCookie
  )
  webRouter.delete(
    '/admin/templates/api/credentials/session',
    requireSiteAdminJson,
    adminWriteRateLimit,
    AdminController.deleteSessionCookie
  )
}

const TemplateGalleryRouter = {
  openRateLimiter: OpenController.openRateLimiter,
  apply,
}

export default TemplateGalleryRouter
