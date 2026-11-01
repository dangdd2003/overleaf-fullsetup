import Path from 'node:path'
import moment from 'moment'
import Settings from '@overleaf/settings'
import SessionManager from '../../../../../app/src/Features/Authentication/SessionManager.mjs'
import AuthorizationManager from '../../../../../app/src/Features/Authorization/AuthorizationManager.mjs'
import GalleryReadService from '../services/GalleryReadService.mjs'
import BlobStore from '../storage/BlobStore.mjs'
import {
  isValidToken,
  scopeBase,
  scopeForFamily,
  itemHref,
  itemPdfHref,
  itemOpenHref,
  thumbHref,
  previewHref,
  taggedHref,
} from '../util/GalleryUrls.mjs'
import { buildPagination } from '../util/Pagination.mjs'
import {
  scopeCopy,
  categoryTiles,
  filterLinks,
  LISTING_DESCRIPTION_KEY,
} from '../util/GalleryCopy.mjs'
import { isTransientCode } from '../transport/HostLimiter.mjs'
import { logError } from '../observability/Log.mjs'

const VIEWS_DIR = Path.resolve(import.meta.dirname, '../../views')

const PAGE_PARAM_REGEX = /^[1-9]\d{0,6}$/
const SEARCH_QUERY_MAX = 100
const META_DESCRIPTION_MAX = 155

const MEDIA_CACHE_CONTROL = 'public, max-age=86400'
const FALLBACK_MEDIA_CACHE_CONTROL = 'public, max-age=3600'
const DATA_URI_REGEX =
  /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/i

function view(name) {
  return Path.join(VIEWS_DIR, name)
}

async function isSiteAdmin(req) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  if (!userId) return false
  try {
    return Boolean(await AuthorizationManager.promises.isUserSiteAdmin(userId))
  } catch {
    return false
  }
}

function canonicalUrl(path) {
  const origin = String(Settings.siteUrl || '').replace(/\/+$/, '')
  return `${origin}${path}`
}

// Page number from a /page/:page segment; null when it is not a positive
// integer, so the route falls through to the 404 handler.
function parsePageParam(raw) {
  if (raw === undefined) return 1
  const value = String(raw)
  return PAGE_PARAM_REGEX.test(value) ? Number(value) : null
}

function searchState(req) {
  const q = typeof req.query?.q === 'string' ? req.query.q.trim() : ''
  const page = typeof req.query?.page === 'string' ? req.query.page : ''
  return {
    query: q.slice(0, SEARCH_QUERY_MAX),
    page: PAGE_PARAM_REGEX.test(page) ? page : '',
  }
}

function toCard(item, badge = null) {
  return {
    token: item.token,
    title: item.title || '',
    author: item.author || '',
    description: item.description || '',
    href: itemHref(item),
    thumbUrl: thumbHref(item),
    badge,
  }
}

function truncate(text, max) {
  const value = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
  return value.length > max ? `${value.slice(0, max)}...` : value
}

function renderError(res, status, { titleKey, messageKey }) {
  return res.status(status).render(view('error'), {
    statusCode: status,
    titleKey,
    messageKey,
  })
}

function failPage(req, res, err, event) {
  logError(event, err, { path: req.path })
  if (res.headersSent) return
  return renderError(res, 500, {
    titleKey: 'generic_something_went_wrong',
    messageKey: 'something_went_wrong_server',
  })
}

// ---------------------------------------------------------------------------
// Listing pages: /latex/templates, /latex/examples, /articles, /gallery
// ---------------------------------------------------------------------------

async function renderListing(req, res, { scope, page, recentOnly }) {
  const recentBase = `${scopeBase(scope)}/recent`
  const isRoot = !recentOnly
  const [listing, featured] = await Promise.all([
    GalleryReadService.listPage({ scope, page }),
    isRoot && scopeCopy(scope).hasFeatured
      ? GalleryReadService.listFeatured(scope)
      : [],
  ])

  const path = isRoot
    ? scopeBase(scope)
    : page > 1
      ? `${recentBase}/page/${page}`
      : recentBase

  res.render(view('listing'), {
    scope,
    copy: scopeCopy(scope),
    filters: filterLinks(scope),
    canonicalURL: canonicalUrl(path),
    isRoot,
    categories: isRoot ? categoryTiles(scope) : [],
    recent: listing.items.map(item => toCard(item)),
    pagination: buildPagination({
      current: listing.page,
      total: listing.totalPages,
      basePath: recentBase,
    }),
    featured: featured.map(item =>
      toCard(item, item.official === true ? 'official' : null)
    ),
    search: searchState(req),
  })
}

export function renderScopeRoot(scope) {
  return async function renderScopeRootHandler(req, res) {
    try {
      await renderListing(req, res, { scope, page: 1, recentOnly: false })
    } catch (err) {
      failPage(req, res, err, 'tg.listing.render_failed')
    }
  }
}

export function renderRecent(scope) {
  return async function renderRecentHandler(req, res, next) {
    const page = parsePageParam(req.params?.page)
    if (page === null) return next()
    if (req.params?.page !== undefined && page === 1) {
      return res.redirect(301, `${scopeBase(scope)}/recent`)
    }
    try {
      await renderListing(req, res, { scope, page, recentOnly: true })
    } catch (err) {
      failPage(req, res, err, 'tg.recent.render_failed')
    }
  }
}

// ---------------------------------------------------------------------------
// Tag pages: /<scope base>/tagged/:name[/page/:page]
// ---------------------------------------------------------------------------

export function renderTagged(scope) {
  return async function renderTaggedHandler(req, res, next) {
    const tagName = GalleryReadService.normalizeTagName(req.params?.name)
    const page = parsePageParam(req.params?.page)
    if (!tagName || page === null) return next()

    try {
      const listing = await GalleryReadService.listPage({
        scope,
        tagName,
        page,
      })
      const tag = await GalleryReadService.getTagView({
        scope,
        tagName,
        page,
        count: listing.total,
      })
      const basePath = taggedHref(scope, tagName)
      const path =
        req.params?.page !== undefined ? `${basePath}/page/${page}` : basePath

      res.render(view('tagged'), {
        scope,
        copy: scopeCopy(scope),
        filters: filterLinks(scope, tagName),
        canonicalURL: canonicalUrl(path),
        backHref: scopeBase(scope),
        tag: {
          ...tag,
          related: tag.related.map(related => ({
            name: related.name,
            title: related.title || related.name,
            href: taggedHref(scope, related.name),
          })),
        },
        topPicks: tag.topPicks.map(item => toCard(item, 'top-pick')),
        recent: listing.items.map(item => toCard(item)),
        pagination: buildPagination({
          current: listing.page,
          total: listing.totalPages,
          basePath,
        }),
      })
    } catch (err) {
      failPage(req, res, err, 'tg.tagged.render_failed')
    }
  }
}

// ---------------------------------------------------------------------------
// Detail page: /<family base>/:slug/:token
// ---------------------------------------------------------------------------

function lastUpdated(value) {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return {
    epoch: Math.floor(date.getTime() / 1000),
    relative: moment(date).fromNow(),
  }
}

export async function renderDetail(req, res, next) {
  const token = req.params?.token
  if (!isValidToken(token)) return next()

  try {
    const isAdmin = await isSiteAdmin(req)
    const item = await GalleryReadService.getItemByToken(token, {
      includeUnpublished: isAdmin,
    })
    if (!item) return next()

    const scope = scopeForFamily(item.family)
    const href = itemHref(item)
    const description = truncate(item.description, META_DESCRIPTION_MAX)

    res.render(view('detail'), {
      scope,
      copy: scopeCopy(scope),
      canonicalURL: canonicalUrl(href),
      metaDescription: description,
      backHref: scopeBase(scope),
      adminPreviewState:
        isAdmin && item.state !== 'published' ? String(item.state || '') : null,
      item: {
        token: item.token,
        title: item.title || '',
        author: item.author || '',
        official: item.official === true,
        licenseLabel: item.licenseLabel || null,
        abstractHtml: item.abstractHtml || null,
        description: item.description || '',
        mainText: typeof item.mainText === 'string' ? item.mainText : null,
        lastUpdated: lastUpdated(
          item.lastUpdatedAt || item.updatedAt || item.createdAt
        ),
        tags: (item.tags || [])
          .filter(tag => tag?.name)
          .map(tag => ({
            name: tag.name,
            title: tag.title || tag.name,
            href: taggedHref('gallery', tag.name),
          })),
        openHref: itemOpenHref(item),
        pdfHref: itemPdfHref(item),
        previewUrl: previewHref(item),
      },
    })
  } catch (err) {
    failPage(req, res, err, 'tg.detail.render_failed')
  }
}

// ---------------------------------------------------------------------------
// Media: thumbnails, detail previews and PDFs mirrored into the BlobStore
// ---------------------------------------------------------------------------

async function lookupMediaItem(req) {
  const token = req.params?.token
  if (!isValidToken(token)) return null
  const isAdmin = await isSiteAdmin(req)
  return GalleryReadService.getMediaItem(token, { includeUnpublished: isAdmin })
}

async function existingBlob(sha) {
  return sha && (await BlobStore.exists(sha)) ? sha : null
}

function streamBlob(req, res, { sha, mime, cacheControl, extraHeaders = {} }) {
  const etag = `"${sha}"`
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', cacheControl)
  res.setHeader('ETag', etag)
  for (const [name, value] of Object.entries(extraHeaders)) {
    res.setHeader(name, value)
  }
  if (req.headers?.['if-none-match'] === etag) {
    return res.status(304).end()
  }
  res.setHeader('Content-Type', mime)
  const stream = BlobStore.getStream(sha)
  stream.on('error', err => {
    logError('tg.media.stream_failed', err, { sha })
    if (!res.headersSent) {
      res.status(404).end()
    } else {
      res.destroy(err)
    }
  })
  stream.pipe(res)
}

function sendDataUri(res, dataUri) {
  const match = DATA_URI_REGEX.exec(String(dataUri || '').replace(/\s+/g, ''))
  if (!match) return false
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', FALLBACK_MEDIA_CACHE_CONTROL)
  res.setHeader('Content-Type', match[1].toLowerCase())
  res.status(200).send(Buffer.from(match[2], 'base64'))
  return true
}

// The listing thumbnail and the detail preview are the same published JPEG on
// overleaf.com, so each one can stand in for the other.
function serveImage(kind) {
  const [primary, secondary] =
    kind === 'thumb' ? ['thumb', 'preview'] : ['preview', 'thumb']

  return async function serveImageHandler(req, res) {
    try {
      const item = await lookupMediaItem(req)
      if (!item) return res.sendStatus(404)
      const media = item.media || {}

      for (const k of [primary, secondary]) {
        const sha = await existingBlob(media[`${k}Sha`])
        if (sha) {
          return streamBlob(req, res, {
            sha,
            mime: media[`${k}Mime`] || 'image/jpeg',
            cacheControl: MEDIA_CACHE_CONTROL,
          })
        }
      }

      const mirrored = await GalleryReadService.ensureMedia(item, primary)
      const sha = await existingBlob(mirrored?.sha)
      if (sha) {
        return streamBlob(req, res, {
          sha,
          mime: mirrored.mime || 'image/jpeg',
          cacheControl: MEDIA_CACHE_CONTROL,
        })
      }

      if (kind === 'thumb' && sendDataUri(res, item.thumbDataUri)) return
      return res.sendStatus(404)
    } catch (err) {
      if (isTransientCode(err?.code)) {
        if (!res.headersSent) return res.sendStatus(404)
      }
      logError('tg.media.failed', err, { kind, token: req.params?.token })
      if (!res.headersSent) res.sendStatus(500)
    }
  }
}

export const serveThumbnail = serveImage('thumb')
export const servePreview = serveImage('preview')

export async function servePdf(req, res, next) {
  // Express matches paths case-insensitively; only the lower-case .pdf
  // suffix is a PDF route (".PDF" is a 404, not an error page).
  if (!req.path.endsWith('.pdf') || !isValidToken(req.params?.token)) {
    return next()
  }
  try {
    const item = await lookupMediaItem(req)
    if (!item) return next()

    let sha = await existingBlob(item.media?.pdfSha)
    if (!sha) {
      const mirrored = await GalleryReadService.ensurePdf(item)
      sha = await existingBlob(mirrored?.sha)
    }
    if (!sha) return next()

    return streamBlob(req, res, {
      sha,
      mime: 'application/pdf',
      cacheControl: MEDIA_CACHE_CONTROL,
      extraHeaders: {
        'Content-Disposition': `inline; filename="${item.token}.pdf"`,
      },
    })
  } catch (err) {
    if (isTransientCode(err?.code)) {
      return next()
    }
    logError('tg.pdf.failed', err, { token: req.params?.token })
    if (!res.headersSent) res.sendStatus(500)
  }
}

// ---------------------------------------------------------------------------
// Legacy /templates URLs of the previous module version
// ---------------------------------------------------------------------------

export function redirectLegacyGallery(req, res) {
  const { query } = searchState(req)
  const target = query
    ? `${scopeBase('templates')}?q=${encodeURIComponent(query)}`
    : scopeBase('templates')
  res.redirect(301, target)
}

export function redirectLegacyItem(suffix = '') {
  return async function redirectLegacyItemHandler(req, res, next) {
    try {
      const item = await GalleryReadService.findLegacyItemBySlug(
        req.params?.slug
      )
      if (!item) return next()
      const targets = {
        '': itemHref(item),
        thumbnail: thumbHref(item),
        pdf: itemPdfHref(item),
      }
      res.redirect(301, targets[suffix] ?? itemHref(item))
    } catch (err) {
      next(err)
    }
  }
}

const GalleryController = {
  renderScopeRoot,
  renderRecent,
  renderTagged,
  renderDetail,
  serveThumbnail,
  servePreview,
  servePdf,
  redirectLegacyGallery,
  redirectLegacyItem,
}

export default GalleryController
