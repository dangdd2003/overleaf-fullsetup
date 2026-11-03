import mongodb from 'mongodb'
import { itemsCol } from '../persistence/Collections.mjs'
import { isValidToken, itemHref } from '../util/GalleryUrls.mjs'
import { logWarn } from '../observability/Log.mjs'
import SyncRun from '../jobs/SyncRun.mjs'

const { ObjectId } = mongodb

// Admin view of the upstream mirror: what is mirrored, how far each item got
// (details, source) and when the next attempt is due. Nothing here writes.

const OVERLEAF_ORIGIN = 'https://www.overleaf.com'
const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100
const MAX_PAGE = 10000
const SYNC_VALUES = Object.freeze([
  'all',
  'ok',
  'syncing',
  'queued',
  'failed',
  'removed',
])


// Heavy fields that no admin view needs.
const DETAIL_PROJECTION = Object.freeze({
  thumbDataUri: 0,
  abstractHtml: 0,
  mainText: 0,
})

// Inclusion projection for list rows.
const LIST_PROJECTION = Object.freeze({
  _id: 1,
  token: 1,
  slug: 1,
  title: 1,
  family: 1,
  state: 1,
  sourceAcquired: 1,
  acquisitionTier: 1,
  acquisitionBackoff: 1,
  'zip.attemptedAt': 1,
  mirror: 1,
})

const LIST_SORT = Object.freeze({ title: 1, _id: 1 })

const SOURCE_BY_TIER = Object.freeze({ 1: 'full', 2: 'git', 3: 'single-file' })

/**
 * Escapes regex special characters to safely use user input in $regex queries.
 *
 * @param {string} str
 * @returns {string}
 */
export function escapeRegex(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isoOrNull(value) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function isRemoved(item) {
  return (
    Boolean(item.mirror?.removedAt) ||
    (item.state === 'unpublished' && item.mirror?.unpublishedByCrawler === true)
  )
}

function backoffActive(item, now) {
  const retryAt = item.acquisitionBackoff?.retryAt
  return Boolean(retryAt) && new Date(retryAt) > now
}

/**
 * The one derivation of an item's sync status. Used by the list rows, the
 * item page and the refetch responses.
 *
 * @param {object} item - templateGalleryItems document
 * @param {Date} [now]
 * @param {Set<string>} [syncing] - tokens the sync pool is fetching right now
 * @returns {{ crawledAt: string|null, hydratedAt: string|null, detailStatus: string, sourceStatus: string, source: string, acquisitionTier: number|null, failures: number, lastError: string|null, nextAttemptAt: string|null, removedAt: string|null }}
 */
export function toSyncBlock(item, now = new Date(), syncing = null) {
  // An ItemDetail / ItemRow already carries its derived sync block. Stored
  // documents have `mirror` and no `sync` key, so only the view shapes match.
  if (item && !item.mirror && item.sync && typeof item.sync === 'object') {
    return item.sync
  }
  const mirror = item?.mirror || {}
  const backoff = item?.acquisitionBackoff || null
  const removed = isRemoved(item)
  const detailed = Boolean(mirror.detailAt)
  const failures = Number(mirror.attempts) || 0

  let detailStatus = 'queued'
  if (removed) detailStatus = 'removed'
  else if (syncing?.has(item?.token)) detailStatus = 'syncing'
  // a failed refetch keeps hydratedAt, so the failure must be checked first
  else if (failures > 0) detailStatus = 'failed'
  else if (detailed) detailStatus = 'ok'

  const tier = Number(item?.acquisitionTier)
  const sourceAcquired = Boolean(item?.sourceAcquired)
  let sourceStatus = 'pending'
  if (sourceAcquired) sourceStatus = 'ok'
  else if (backoffActive(item, now)) sourceStatus = 'backoff'
  else if (item?.zip?.attemptedAt || backoff?.attemptedAt) sourceStatus = 'failed'

  let nextAttemptAt = null
  if (sourceStatus === 'backoff') nextAttemptAt = isoOrNull(backoff.retryAt)
  else if (detailStatus === 'failed') nextAttemptAt = isoOrNull(mirror.nextAttemptAt)

  let lastError = mirror.lastError || null
  if (!lastError && (sourceStatus === 'failed' || sourceStatus === 'backoff')) {
    lastError = backoff?.reasons?.length ? backoff.reasons.join('; ') : null
  }

  return {
    crawledAt: isoOrNull(mirror.catalogAt),
    hydratedAt: isoOrNull(mirror.detailAt),
    detailStatus,
    sourceStatus,
    source: sourceAcquired ? SOURCE_BY_TIER[tier] || 'none' : 'none',
    acquisitionTier: sourceAcquired && SOURCE_BY_TIER[tier] ? tier : null,
    failures,
    lastError,
    nextAttemptAt,
    removedAt: isoOrNull(mirror.removedAt),
  }
}

function upstreamUrlFor(item) {
  return `${OVERLEAF_ORIGIN}${itemHref(item)}`
}

/**
 * Admin list row.
 *
 * @param {object} item
 * @returns {object} ItemRow
 */
export function toItemRow(item, syncing = null) {
  return {
    id: String(item._id),
    slug: item.slug ?? null,
    token: item.token ?? null,
    family: item.family ?? null,
    title: item.title ?? null,
    upstreamUrl: upstreamUrlFor(item),
    galleryUrl: itemHref(item),
    sync: toSyncBlock(item, new Date(), syncing),
  }
}

/**
 * Admin item page view (no heavy text fields).
 *
 * @param {object} item
 * @param {Set<string>} [syncing] - tokens the sync pool is fetching right now
 * @returns {object} ItemDetail
 */
export function toItemDetail(item, syncing = null) {
  return {
    id: String(item._id),
    slug: item.slug ?? null,
    token: item.token ?? null,
    family: item.family ?? null,
    title: item.title ?? null,
    author: item.author ?? null,
    description: item.description ?? null,
    tags: Array.isArray(item.tags)
      ? item.tags.map((tag) => ({ name: tag?.name, title: tag?.title }))
      : [],
    upstreamUrl: upstreamUrlFor(item),
    galleryUrl: itemHref(item),
    objectID: item.objectID != null ? String(item.objectID) : null,
    publishedId: item.publishedId != null ? String(item.publishedId) : null,
    licenseLabel: item.licenseLabel ?? null,
    state: item.state ?? null,
    sync: toSyncBlock(item, new Date(), syncing),
  }
}

// Mongo filters matching the derived detailStatus (see toSyncBlock). Built per
// request from the tokens the sync pool is fetching right now.
const REMOVED_FILTER = Object.freeze({
  $or: [
    { 'mirror.removedAt': { $ne: null } },
    { state: 'unpublished', 'mirror.unpublishedByCrawler': true },
  ],
})
const NOT_REMOVED_FILTER = Object.freeze({
  'mirror.removedAt': null,
  $nor: [{ state: 'unpublished', 'mirror.unpublishedByCrawler': true }],
})
function syncFilters(syncing = new Set()) {
  const tokens = [...syncing]
  const notSyncing = { ...NOT_REMOVED_FILTER, token: { $nin: tokens } }
  return {
    ok: {
      ...notSyncing,
      'mirror.detailAt': { $ne: null },
      'mirror.attempts': { $not: { $gt: 0 } },
    },
    syncing: { ...NOT_REMOVED_FILTER, token: { $in: tokens } },
    queued: {
      ...notSyncing,
      'mirror.detailAt': null,
      'mirror.attempts': { $not: { $gt: 0 } },
    },
    failed: {
      ...notSyncing,
      'mirror.attempts': { $gt: 0 },
    },
    removed: REMOVED_FILTER,
  }
}

function parseSync(raw) {
  const value = String(raw ?? 'all')
  return SYNC_VALUES.includes(value) ? value : 'all'
}

function parsePage(raw) {
  return Math.max(1, Math.min(MAX_PAGE, Number.parseInt(String(raw ?? '1'), 10) || 1))
}

function parsePageSize(raw) {
  const value = Number.parseInt(String(raw ?? DEFAULT_PAGE_SIZE), 10)
  if (!Number.isFinite(value) || value < 1) return DEFAULT_PAGE_SIZE
  return Math.min(MAX_PAGE_SIZE, value)
}

/**
 * Builds the search clause for q. `text` means the clause is a $text query
 * that may fall back to a regex.
 */
function searchClause(q) {
  if (!q) return null
  if (isValidToken(q)) return { clause: { token: q }, text: false }
  if (/^[a-f0-9]{24}$/i.test(q))
    return { clause: { _id: new ObjectId(q) }, text: false }
  if (/^\d+$/.test(q)) return { clause: { objectID: q }, text: false }
  return { clause: { $text: { $search: q } }, text: true }
}

function regexClause(q) {
  const regex = new RegExp(escapeRegex(q), 'i')
  return { $or: [{ title: regex }, { slug: regex }] }
}

/**
 * Lists items for the admin Templates tab.
 *
 * @param {object} options
 * @param {string} [options.q] - token, _id, objectID, or free text
 * @param {string} [options.sync='all'] - all | ok | syncing | queued | failed | removed (unknown values mean all)
 * @param {number|string} [options.page=1]
 * @param {number|string} [options.pageSize=25] - 1..100
 * @returns {Promise<{ items: object[], page: number, pageSize: number, total: number, totalPages: number }>}
 */
export async function listAdmin({ q, sync, page, pageSize } = {}) {
  const query = typeof q === 'string' ? q.trim() : ''
  const currentPage = parsePage(page)
  const size = parsePageSize(pageSize)
  const search = searchClause(query)
  const syncValue = parseSync(sync)
  const syncing = await SyncRun.syncingTokens()

  const run = async (useText) => {
    const clauses = []
    if (syncValue !== 'all') clauses.push(syncFilters(syncing)[syncValue])
    if (search) {
      clauses.push(search.text && !useText ? regexClause(query) : search.clause)
    }
    const filter = clauses.length === 0 ? {} : clauses.length === 1 ? clauses[0] : { $and: clauses }
    const col = await itemsCol()
    const [rows, total] = await Promise.all([
      col
        .find(filter, { projection: LIST_PROJECTION })
        .sort(LIST_SORT)
        .skip((currentPage - 1) * size)
        .limit(size)
        .toArray(),
      col.countDocuments(filter),
    ])
    return { rows, total }
  }

  let result
  if (search?.text) {
    try {
      result = await run(true)
    } catch (err) {
      // $text needs the tg_text index; a regex keeps search working without it
      logWarn('tg.admin.text_search_fallback', { message: err?.message })
      result = await run(false)
    }
  } else {
    result = await run(false)
  }

  return {
    items: result.rows.map(row => toItemRow(row, syncing)),
    page: currentPage,
    pageSize: size,
    total: result.total,
    totalPages: Math.ceil(result.total / size) || 1,
  }
}

/**
 * Raw item lookup by Mongo id, token, 24-hex id, objectID or slug (in that
 * order). Heavy fields are excluded unless a projection is given.
 *
 * @param {ObjectId|string} id
 * @param {object} [projection]
 * @returns {Promise<object|null>}
 */
export async function findItemDoc(id, projection = DETAIL_PROJECTION) {
  const col = await itemsCol()
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
 * @param {ObjectId|string} id
 * @returns {Promise<object|null>} ItemDetail
 */
export async function getItemById(id) {
  const item = await findItemDoc(id)
  return item ? toItemDetail(item) : null
}

/**
 * @param {string} slug
 * @returns {Promise<object|null>} ItemDetail
 */
export async function findItemDocBySlug(slug, projection = DETAIL_PROJECTION) {
  const col = await itemsCol()
  return col.findOne({ slug: String(slug ?? '') }, { projection })
}

export async function getItemBySlug(slug) {
  const col = await itemsCol()
  const item = await col.findOne({ slug: String(slug ?? '') }, { projection: DETAIL_PROJECTION })
  return item ? toItemDetail(item) : null
}

/**
 * Counts for the Sync tab: each item is in exactly one state.
 *
 * @returns {Promise<{ counts: { total: number, synced: number, syncing: number, queued: number, failed: number, removed: number } }>}
 */
export async function getSummaryCounts() {
  const col = await itemsCol()
  const filters = syncFilters(await SyncRun.syncingTokens())
  // Tombstoned duplicates (dedup) are not part of the mirror's counts; they are reported apart
  const live = filter => ({ ...filter, duplicateOf: null })
  const count = (filter) => col.countDocuments(live(filter))
  const [total, synced, syncing, queued, failed, removed, duplicates] = await Promise.all([
    col.countDocuments({ duplicateOf: null }),
    count(filters.ok),
    count(filters.syncing),
    count(filters.queued),
    count(filters.failed),
    count(filters.removed),
    col.countDocuments({ duplicateOf: { $ne: null } }),
  ])
  return { counts: { total, synced, syncing, queued, failed, removed, duplicates } }
}

export default {
  escapeRegex,
  toSyncBlock,
  toItemRow,
  toItemDetail,
  listAdmin,
  findItemDoc,
  findItemDocBySlug,
  getItemById,
  getItemBySlug,
  getSummaryCounts,
}
