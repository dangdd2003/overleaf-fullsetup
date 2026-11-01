import Path from 'node:path'
import Settings from '@overleaf/settings'
import { expressify } from '@overleaf/promise-utils'
import AuthenticationController from '../../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import SessionManager from '../../../../../app/src/Features/Authentication/SessionManager.mjs'
import AuthorizationManager from '../../../../../app/src/Features/Authorization/AuthorizationManager.mjs'
import { RateLimiter } from '../../../../../app/src/infrastructure/RateLimiter.mjs'
import { acceptsJson } from '../../../../../app/src/infrastructure/RequestContentTypeDetection.mjs'
import Lifecycle from '../Lifecycle.mjs'
import OpenService from '../services/OpenService.mjs'
import { isTransientCode } from '../transport/HostLimiter.mjs'
import { isValidToken, itemOpenHref } from '../util/GalleryUrls.mjs'
import { logWarn, logError, incMetric } from '../observability/Log.mjs'

// GET  /<familyBase>/:slug/:token/open  -> loader page that auto-submits
// POST /<familyBase>/:slug/:token/open  -> create the project, 302 /project/<id>
// Both sit behind requireLogin; anonymous users go to /login and come back to
// the GET URL through CE's post-login redirect.

const VIEWS_DIR = Path.resolve(import.meta.dirname, '../../views')

export const openRateLimiter = new RateLimiter(
  'template-gallery-open',
  Settings.templateGallery?.rateLimits?.open || { points: 20, duration: 60 }
)

const NOT_FOUND = {
  status: 404,
  title: 'Template not found',
  message: 'This template does not exist or is no longer available.',
}
const UNAVAILABLE = {
  status: 503,
  title: 'Template gallery unavailable',
  message: 'The template gallery is temporarily unavailable. Please try again later.',
}
const INVALID = {
  status: 422,
  title: 'Cannot open template',
  message: 'The files of this template are invalid and cannot be opened.',
}

// Public copy only: internal error messages never reach the response.
const ERRORS = {
  item_not_found: NOT_FOUND,
  template_not_found: NOT_FOUND,
  source_acquisition_failed: {
    status: 502,
    title: 'Template source unavailable',
    message: 'We could not fetch the files of this template. Please try again later.',
  },
  upstream_busy: {
    status: 503,
    title: 'Template service busy',
    message: 'The upstream template service is currently busy. Please wait a moment and try again.',
  },
  gallery_unavailable: UNAVAILABLE,
  bundle_unavailable: UNAVAILABLE,
  bundle_invalid: INVALID,
  main_file_missing: INVALID,
  image_unavailable: {
    status: 409,
    title: 'Cannot open template',
    message: 'The TeX Live image this template needs is not available on this server.',
  },
  rate_limited: {
    status: 429,
    title: 'Too many templates opened',
    message: 'You have opened many templates in a short time. Please wait a minute and try again.',
  },
  open_failed: {
    status: 500,
    title: 'Cannot open template',
    message: 'Something went wrong while creating your project. Please try again.',
  },
}

export function errorFor(code) {
  if (isTransientCode(code)) return { code: 'upstream_busy', ...ERRORS.upstream_busy }
  if (ERRORS[code]) return { code, ...ERRORS[code] }
  if (typeof code === 'string' && code.startsWith('image_')) {
    return { code, ...ERRORS.image_unavailable }
  }
  return { code: 'open_failed', ...ERRORS.open_failed }
}

function sendError(req, res, code) {
  const error = errorFor(code)
  if (acceptsJson(req)) {
    return res.status(error.status).json({ error: error.code, message: error.message })
  }
  return res.status(error.status).render(Path.join(VIEWS_DIR, 'error'), {
    title: error.title,
    statusCode: error.status,
    code: error.code,
    message: error.message,
  })
}

async function isSiteAdmin(userId) {
  try {
    return Boolean(await AuthorizationManager.promises.isUserSiteAdmin(userId))
  } catch {
    return false
  }
}

function tokenParam(req) {
  const token = String(req.params?.token || '')
  return isValidToken(token) ? token : null
}

async function _renderOpenLoader(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  if (!userId) {
    AuthenticationController.setRedirectInSession(req)
    return res.redirect('/login')
  }
  if (!Lifecycle.isReady()) return sendError(req, res, 'gallery_unavailable')

  const token = tokenParam(req)
  const item =
    token &&
    (await OpenService.findOpenableItem(token, {
      allowUnpublished: await isSiteAdmin(userId),
    }))
  if (!item) return sendError(req, res, 'item_not_found')

  res.render(Path.join(VIEWS_DIR, 'open'), {
    formAction: itemOpenHref(item),
    metadata: { title: item.title, robotsNoindexNofollow: true },
  })
}

async function _openTemplate(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  if (!userId) {
    AuthenticationController.setRedirectInSession(req)
    return res.redirect('/login')
  }
  if (!Lifecycle.isReady()) {
    incMetric('open_total', { result: 'gallery_unavailable' })
    return sendError(req, res, 'gallery_unavailable')
  }

  const token = tokenParam(req)
  if (!token) return sendError(req, res, 'item_not_found')

  try {
    await openRateLimiter.consume(String(userId), 1, { method: 'userId' })
  } catch (err) {
    if (err instanceof Error) throw err
    incMetric('open_total', { result: 'rate_limited' })
    res.set('Retry-After', String(Math.ceil((err?.msBeforeNext || 60_000) / 1000)))
    return sendError(req, res, 'rate_limited')
  }

  let result
  try {
    result = await OpenService.openTemplate(token, userId, {
      cfg: Settings.templateGallery,
      allowUnpublished: await isSiteAdmin(userId),
    })
  } catch (err) {
    const { code, status } = errorFor(err?.code)
    incMetric('open_total', { result: code })
    if (status >= 500 && status !== 503 && status !== 502) {
      logError('open_failed', err, { token, userId: String(userId), code, reasons: err?.reasons })
    } else {
      logWarn('open_rejected', { token, userId: String(userId), code })
    }
    if (status === 503) {
      res.set('Retry-After', '30')
    }
    return sendError(req, res, code)
  }

  incMetric('open_total', { result: 'ok', tier: String(result.acquisitionTier) })
  const redirect = `/project/${result.projectId}`
  if (acceptsJson(req)) {
    return res.json({
      projectId: result.projectId,
      redirect,
      acquisitionTier: result.acquisitionTier,
      hasMissingDependencies: Boolean(result.hasMissingDependencies),
    })
  }
  return res.redirect(302, redirect)
}

export const renderOpenLoader = expressify(_renderOpenLoader)
export const openTemplate = expressify(_openTemplate)

const OpenController = {
  renderOpenLoader,
  openTemplate,
}

export default OpenController
