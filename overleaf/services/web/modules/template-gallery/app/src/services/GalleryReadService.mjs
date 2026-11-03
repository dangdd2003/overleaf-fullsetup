// Read side of the public gallery pages: listings, tag pages, featured
// blocks, item detail and media lookups against the local Mongo mirror.
// When a page needs data the mirror does not have yet (tag metadata, detail
// fields, media) it asks MirrorService for it at interactive priority, but
// never waits longer than a short timeout: the page renders with what we have.

import { itemsCol, tagsCol, listingsCol } from '../persistence/Collections.mjs'
import * as MirrorService from './mirror/MirrorService.mjs'
import {
  PAGE_SIZE,
  familyForScope,
  isValidToken,
} from '../util/GalleryUrls.mjs'
import { totalPagesFor } from '../util/Pagination.mjs'
import { logWarn } from '../observability/Log.mjs'

export const FEATURED_LIMIT = 5
export const RELATED_TAGS_LIMIT = 40
export const TAG_WAIT_MS = 4000
export const DETAIL_WAIT_MS = 4000
export const MEDIA_WAIT_MS = 6000
export const PDF_WAIT_MS = 20000

const LISTING_SORT = Object.freeze({ recentOrder: -1, objectIDNum: -1 })

// Fields a listing card needs. Never ship mainText/abstractHtml on listings.
const CARD_PROJECTION = Object.freeze({
  _id: 0,
  token: 1,
  family: 1,
  slug: 1,
  title: 1,
  author: 1,
  description: 1,
  official: 1,
  featured: 1,
})

const DETAIL_PROJECTION = Object.freeze({
  thumbDataUri: 0,
  sourceBlobStoreKey: 0,
})

const MEDIA_PROJECTION = Object.freeze({
  _id: 0,
  token: 1,
  slug: 1,
  family: 1,
  state: 1,
  source: 1,
  objectID: 1,
  media: 1,
  thumbDataUri: 1,
  duplicateOf: 1,
})

const TAG_NAME_MAX = 100

// Computed tag fallbacks are cheap to rebuild but run an aggregation, so keep
// them for a while per (scope, tag).
const COMPUTED_TAG_TTL_MS = 10 * 60 * 1000
const COMPUTED_TAG_CACHE_MAX = 500
const computedTagCache = new Map()

export function normalizeTagName(name) {
  const value = String(name ?? '').trim()
  if (!value || value.length > TAG_NAME_MAX || value.includes('/')) return null
  return value
}

function visibilityFilter({ includeUnpublished = false } = {}) {
  return includeUnpublished ? {} : { state: 'published' }
}

// Tombstoned duplicates (duplicateOf set) are never listed or counted.
function listingFilter(scope, tagName = null) {
  const filter = { state: 'published', 'mirror.removedAt': null, duplicateOf: null }
  const family = familyForScope(scope)
  if (family) filter.family = family
  if (tagName) filter['tags.name'] = tagName
  return filter
}

// Resolves to the task result, or to null when it fails or takes too long.
// The task keeps running in the background (MirrorService is single-flight),
// so a later request benefits from its result.
async function settleWithin(label, ms, task) {
  let timer
  const pending = Promise.resolve()
    .then(task)
    .catch(err => {
      logWarn('tg.read.mirror_failed', { label, message: err?.message })
      return null
    })
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => {
      logWarn('tg.read.mirror_timeout', { label, ms })
      resolve(null)
    }, ms)
  })
  try {
    return await Promise.race([pending, timeout])
  } finally {
    clearTimeout(timer)
  }
}

function clampPage(page) {
  const n = Number.parseInt(String(page), 10)
  return Number.isFinite(n) && n > 0 ? n : 1
}

async function findCardsByTokens(tokens) {
  const wanted = (tokens || []).filter(isValidToken)
  if (wanted.length === 0) return []
  const col = await itemsCol()
  const docs = await col
    .find(
      { token: { $in: wanted }, ...listingFilter('gallery') },
      { projection: CARD_PROJECTION }
    )
    .toArray()
  const byToken = new Map(docs.map(doc => [doc.token, doc]))
  return wanted.map(token => byToken.get(token)).filter(Boolean)
}

/**
 * One page of a listing (Recent of a scope, optionally restricted to a tag).
 * Pages beyond the end return no items; the caller renders the empty state.
 */
export async function listPage({ scope, tagName = null, page = 1 }) {
  const current = clampPage(page)
  const col = await itemsCol()
  const filter = listingFilter(scope, tagName)
  const total = await col.countDocuments(filter)
  const totalPages = totalPagesFor(total, PAGE_SIZE)
  let items = []
  if (current <= totalPages) {
    items = await col
      .find(filter, { projection: CARD_PROJECTION })
      .sort(LISTING_SORT)
      .skip((current - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .toArray()
  }
  return { items, total, totalPages, page: current }
}

/**
 * The curated "Featured" block of /latex/templates and /gallery. Uses the
 * scraped official slots when present, else items flagged featured.
 */
export async function listFeatured(scope) {
  if (scope !== 'templates' && scope !== 'gallery') return []
  const listings = await listingsCol()
  const slot = await listings.findOne({ _id: `featured:${scope}` })
  if (Array.isArray(slot?.tokens) && slot.tokens.length > 0) {
    const items = await findCardsByTokens(slot.tokens)
    if (items.length > 0) return items.slice(0, FEATURED_LIMIT)
  }
  const col = await itemsCol()
  return col
    .find(
      { ...listingFilter(scope), featured: true },
      { projection: CARD_PROJECTION }
    )
    .sort(LISTING_SORT)
    .limit(FEATURED_LIMIT)
    .toArray()
}

// Strips the scope prefix ("LaTeX templates — ") when a scraped h1 was stored
// verbatim, leaving the tag display title.
function tagTitleFromHeading(heading) {
  const value = String(heading || '').trim()
  if (!value) return null
  const idx = value.lastIndexOf(' — ')
  return idx >= 0 ? value.slice(idx + 3).trim() || null : value
}

function cacheGet(key) {
  const entry = computedTagCache.get(key)
  if (!entry) return null
  if (entry.expiresAt < Date.now()) {
    computedTagCache.delete(key)
    return null
  }
  return entry.value
}

function cacheSet(key, value) {
  if (computedTagCache.size >= COMPUTED_TAG_CACHE_MAX) {
    computedTagCache.delete(computedTagCache.keys().next().value)
  }
  computedTagCache.set(key, { value, expiresAt: Date.now() + COMPUTED_TAG_TTL_MS })
}

export function clearComputedTagCacheForTests() {
  computedTagCache.clear()
}

/**
 * Derives tag metadata from the items themselves, for tags whose official
 * page has not been mirrored yet: the most common Algolia title of the tag and
 * the tags that co-occur with it most often in this scope.
 */
export async function computeTagFallback(scope, tagName) {
  const key = `${scope}\u0000${tagName}`
  const cached = cacheGet(key)
  if (cached) return cached

  const col = await itemsCol()
  const rows = await col
    .aggregate([
      { $match: listingFilter(scope, tagName) },
      { $project: { _id: 0, tags: 1 } },
      { $unwind: '$tags' },
      {
        $group: {
          _id: { name: '$tags.name', title: '$tags.title' },
          count: { $sum: 1 },
        },
      },
    ])
    .toArray()

  const byName = new Map()
  for (const row of rows) {
    const name = row?._id?.name
    if (!name) continue
    const entry = byName.get(name) || { name, count: 0, title: null, titleCount: 0 }
    entry.count += row.count
    if (row._id.title && row.count > entry.titleCount) {
      entry.title = row._id.title
      entry.titleCount = row.count
    }
    byName.set(name, entry)
  }

  const self = byName.get(tagName)
  byName.delete(tagName)
  const related = [...byName.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, RELATED_TAGS_LIMIT)
    .map(({ name, title }) => ({ name, title: title || name }))

  const value = { title: self?.title || null, related }
  cacheSet(key, value)
  return value
}

/**
 * Everything a tag page needs besides its Recent grid: display title, summary,
 * related tags and (page 1 only) the staff top picks.
 */
export async function getTagView({ scope, tagName, page = 1, count }) {
  const tags = await tagsCol()
  let tagDoc = await tags.findOne({ _id: tagName })
  // Only known tags (catalogued or with items) may trigger an upstream fetch,
  // so arbitrary URLs cannot be used to queue requests to overleaf.com.
  const known = Boolean(tagDoc) || count > 0
  if (known && !tagDoc?.byScope?.[scope]) {
    const fetched = await settleWithin(`tag:${scope}:${tagName}`, TAG_WAIT_MS, () =>
      MirrorService.ensureTag(scope, tagName, { priority: 'interactive' })
    )
    if (fetched) tagDoc = fetched
  }

  const scraped = tagDoc?.byScope?.[scope] || null
  let title = tagTitleFromHeading(scraped?.h1Title) || tagDoc?.canonicalTitle || null
  let related = Array.isArray(scraped?.related) ? scraped.related : null

  if (known && (!title || !related)) {
    const computed = await computeTagFallback(scope, tagName)
    title = title || computed.title
    related = related || computed.related
  }

  const topPicks =
    clampPage(page) === 1 && scraped?.topPicks?.length
      ? await findCardsByTokens(scraped.topPicks)
      : []

  return {
    name: tagName,
    known,
    title: title || tagName,
    summary: scraped?.summary || '',
    related: (related || []).filter(tag => tag?.name && tag.name !== tagName),
    topPicks,
  }
}

/**
 * Detail lookup by token (never by slug: slugs are not unique). Public
 * callers only see published items; site admins see every state. Detail
 * fields missing from the mirror are fetched on demand, bounded by a timeout.
 */
export async function getItemByToken(requestedToken, { includeUnpublished = false } = {}) {
  if (!isValidToken(requestedToken)) return null
  const token = await servedToken(requestedToken, { includeUnpublished })
  if (!token) return null
  const col = await itemsCol()
  const filter = { token, ...visibilityFilter({ includeUnpublished }) }
  const item = await col.findOne(filter, { projection: DETAIL_PROJECTION })
  if (!item) return null
  if (item.objectID && !item.mirror?.detailAt) {
    const fresh = await settleWithin(`detail:${token}`, DETAIL_WAIT_MS, () =>
      MirrorService.ensureDetail(token, { priority: 'interactive' })
    )
    if (fresh && fresh.token === token) {
      return col.findOne(filter, { projection: DETAIL_PROJECTION })
    }
  }
  return item
}

/**
 * Small projection used by the thumbnail/preview/PDF handlers.
 */
export async function getMediaItem(requestedToken, { includeUnpublished = false } = {}) {
  if (!isValidToken(requestedToken)) return null
  const token = await servedToken(requestedToken, { includeUnpublished })
  if (!token) return null
  const col = await itemsCol()
  return col.findOne(
    { token, ...visibilityFilter({ includeUnpublished }) },
    { projection: MEDIA_PROJECTION }
  )
}

/**
 * The token whose content a request is served from. A tombstoned duplicate
 * serves its canonical item (one hop, so a chain or a cycle cannot loop).
 * Returns null when the item is missing or its canonical is not visible.
 */
async function servedToken(token, { includeUnpublished = false } = {}) {
  const col = await itemsCol()
  const item = await col.findOne(
    { token, ...visibilityFilter({ includeUnpublished }) },
    { projection: { token: 1, duplicateOf: 1 } }
  )
  if (!item) return null
  if (!item.duplicateOf) return token
  const canonical = await col.findOne(
    {
      token: item.duplicateOf,
      duplicateOf: null,
      ...visibilityFilter({ includeUnpublished }),
    },
    { projection: { token: 1 } }
  )
  return canonical?.token ?? null
}

/**
 * Mirrors a thumbnail or preview JPEG on demand. Returns { sha, mime } | null.
 */
export async function ensureMedia(item, kind) {
  if (!item?.objectID) return null
  return settleWithin(`media:${kind}:${item.token}`, MEDIA_WAIT_MS, () =>
    MirrorService.ensureMedia(item.token, kind, { priority: 'interactive' })
  )
}

/**
 * Mirrors the compiled PDF on demand. Returns { sha, bytes } | null.
 */
export async function ensurePdf(item) {
  if (!item?.objectID) return null
  return settleWithin(`pdf:${item.token}`, PDF_WAIT_MS, () =>
    MirrorService.ensurePdf(item.token, { priority: 'interactive' })
  )
}

/**
 * Legacy /templates/t/:slug links: the newest published item with that slug.
 */
export async function findLegacyItemBySlug(slug) {
  const value = String(slug || '').trim()
  if (!value) return null
  const col = await itemsCol()
  const [item] = await col
    .find(
      { slug: value, state: 'published' },
      { projection: { _id: 0, token: 1, family: 1, slug: 1, duplicateOf: 1 } }
    )
    .sort(LISTING_SORT)
    .limit(1)
    .toArray()
  if (!item) return null
  if (!item.duplicateOf) return { token: item.token, family: item.family, slug: item.slug }
  // A duplicate's legacy link leads to its canonical item
  const canonical = await col.findOne(
    { token: item.duplicateOf, state: 'published', duplicateOf: null },
    { projection: { _id: 0, token: 1, family: 1, slug: 1 } }
  )
  return canonical || null
}

export default {
  FEATURED_LIMIT,
  normalizeTagName,
  listPage,
  listFeatured,
  computeTagFallback,
  getTagView,
  getItemByToken,
  getMediaItem,
  ensureMedia,
  ensurePdf,
  findLegacyItemBySlug,
  clearComputedTagCacheForTests,
}
