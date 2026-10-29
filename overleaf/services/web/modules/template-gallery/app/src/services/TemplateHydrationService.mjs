import mongodb from 'mongodb'
import Settings from '@overleaf/settings'
import { itemsCol } from '../persistence/Collections.mjs'
import { isValidToken } from '../util/GalleryUrls.mjs'
import { DEFAULTS } from '../TemplateGalleryDefaults.mjs'
import * as MirrorService from './mirror/MirrorService.mjs'
import { parseDetailPage } from './mirror/DetailParser.mjs'

// Compatibility facade over services/mirror/MirrorService.mjs for the older
// "hydrate one item" entry points (admin hydrate endpoint, legacy callers).

const { ObjectId } = mongodb

// An admin is waiting on the response; a PDF can take a while to stream.
const HYDRATE_TIMEOUT_MS = 120_000

const GIT_REPO_REGEX =
  /https?:\/\/(?:www\.)?(?:github|gitlab)\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/

async function findItem(col, id) {
  const projection = { token: 1 }
  if (id instanceof ObjectId) return col.findOne({ _id: id }, { projection })
  const value = String(id ?? '')
  if (isValidToken(value)) {
    const byToken = await col.findOne({ token: value }, { projection })
    if (byToken) return byToken
  }
  if (ObjectId.isValid(value) && value.length === 24) {
    return col.findOne({ _id: new ObjectId(value) }, { projection })
  }
  return col.findOne({ $or: [{ objectID: value }, { slug: value }] }, { projection })
}

/**
 * Legacy-shaped view of a parsed detail page (see DetailParser for the
 * canonical shape).
 */
export function parseDetailPageHtml(html) {
  const detail = parseDetailPage(html)
  if (!detail) return {}
  const { cta } = detail
  return {
    title: detail.title,
    author: detail.author || '',
    licenseLabel: detail.licenseLabel || '',
    lastUpdatedEpoch: detail.lastUpdatedAt
      ? Math.floor(detail.lastUpdatedAt.getTime() / 1000)
      : null,
    abstractHtml: detail.abstractHtml || '',
    tags: detail.tags.map(tag => tag.title),
    openParams: {
      templateVersionId: cta.publishedId != null ? String(cta.publishedId) : null,
      templateId: cta.objectID,
      latexEngine: cta.latexEngine,
      mainFile: cta.mainFile,
      templateName: cta.templateName,
      texImage: cta.texImage,
      brandVariationId:
        cta.brandVariationId != null ? String(cta.brandVariationId) : null,
    },
    latexSourcePreview: detail.mainText ? detail.mainText.trim() : '',
    pdfPath: detail.pdfHref || '',
    s3ThumbnailUrl: detail.preview?.url || '',
    gitRepoUrl: GIT_REPO_REGEX.exec(detail.abstractHtml || '')?.[0] || null,
  }
}

/**
 * Refreshes one item's mirrored detail (and PDF unless disabled) from
 * overleaf.com. Accepts a token, Mongo id, objectID or (legacy) slug.
 * Returns the stored item, or null when no such item exists; throws when
 * the upstream refresh fails.
 */
export async function hydrateItem(id, opts = {}) {
  const col = await itemsCol()
  const item = await findItem(col, id)
  if (!item) return null
  if (!isValidToken(item.token)) return col.findOne({ _id: item._id })

  const cfg = opts.cfg || Settings.templateGallery || DEFAULTS
  const ensureOpts = {
    priority: 'interactive',
    force: Boolean(opts.force),
    timeoutMs: opts.timeoutMs ?? HYDRATE_TIMEOUT_MS,
    throwOnError: true,
  }
  const detailed = await MirrorService.ensureDetail(item.token, ensureOpts)

  const cachePdf = opts.cachePdfPreviews ?? cfg?.hydration?.cachePdfPreviews !== false
  if (detailed && cachePdf) {
    await MirrorService.ensurePdf(item.token, { ...ensureOpts, throwOnError: false })
  }
  return col.findOne({ _id: item._id })
}

export default {
  parseDetailPageHtml,
  hydrateItem,
}
