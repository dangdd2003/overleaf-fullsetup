import { itemsCol, tagsCol, listingsCol } from '../../persistence/Collections.mjs'
import * as BlobStore from '../../storage/BlobStore.mjs'
import Settings from '@overleaf/settings'
import { DEFAULTS } from '../../TemplateGalleryDefaults.mjs'
import {
  FAMILIES,
  PAGE_SIZE,
  SCOPES,
  isValidToken,
  itemHref,
  itemPdfHref,
  recentHref,
  taggedHref,
} from '../../util/GalleryUrls.mjs'
import { parseListingPage } from './ListingParser.mjs'
import { parseTagPage } from './TagParser.mjs'
import { parseDetailPage } from './DetailParser.mjs'
import * as Fetch from './Fetch.mjs'
import { logInfo, logWarn, incMetric } from '../../observability/Log.mjs'

// Mirrors the official overleaf.com gallery into Mongo + BlobStore:
// recent order and published ids (listing scan), featured blocks, tag page
// metadata, item detail (metadata, abstract, main .tex, preview JPEG) and
// PDFs. Every upstream request is routed through HostLimiter by Fetch.mjs.

const HOUR = 3600_000
const DAY = 24 * HOUR

const DETAIL_MAX_AGE_MS = 30 * DAY
const TAG_MAX_AGE_MS = 30 * DAY
const DEFAULT_INTERACTIVE_TIMEOUT_MS = 10_000
const RETRY_DELAYS_MS = [HOUR, 6 * HOUR, DAY, 3 * DAY, 7 * DAY]

// A scan of pages 1..3 only looks for new submissions (hourly); anything
// longer is (a chunk of) the full weekly scan.
const INCREMENTAL_MAX_PAGES = 3
// Gap between scans: a full scan's values all sort above every older value.
const RECENT_ORDER_HEADROOM = 100_000
const RECENT_SCAN_ID = 'scan:gallery-recent'

const DEFAULT_BATCH_LIMITS = { detail: 10, pdf: 5, tag: 10 }

const ITEM_PROJECTION = {
  _id: 1,
  token: 1,
  family: 1,
  slug: 1,
  source: 1,
  title: 1,
  author: 1,
  tags: 1,
  official: 1,
  objectID: 1,
  publishedId: 1,
  recentOrder: 1,
  media: 1,
  mirror: 1,
  adminOverrides: 1,
}

const TIMED_OUT = Symbol('timed_out')
const inFlight = new Map()

// ---------------------------------------------------------------------------
// helpers

function singleFlight(key, fn) {
  const existing = inFlight.get(key)
  if (existing) return existing
  const promise = Promise.resolve()
    .then(fn)
    .finally(() => inFlight.delete(key))
  inFlight.set(key, promise)
  return promise
}

/**
 * Applies the caller-facing contract of the ensure* functions: interactive
 * calls are bounded by `timeoutMs` (the work itself carries on and is stored
 * when it lands), and failures resolve to null unless `throwOnError`.
 */
async function settle(promise, opts, label) {
  const timeoutMs =
    opts.timeoutMs ??
    (opts.priority === 'interactive' ? DEFAULT_INTERACTIVE_TIMEOUT_MS : null)
  let timer = null
  try {
    if (!timeoutMs) return await promise
    const result = await Promise.race([
      promise,
      new Promise(resolve => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs)
        timer.unref?.()
      }),
    ])
    if (result === TIMED_OUT) {
      if (opts.throwOnError) {
        const err = new Error(`${label} timed out after ${timeoutMs}ms`)
        err.code = 'timeout'
        throw err
      }
      return null
    }
    return result
  } catch (err) {
    if (opts.throwOnError) throw err
    logWarn('tg.mirror.ensure_failed', {
      label,
      code: err?.code,
      status: err?.status,
      message: err?.message,
    })
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function config() {
  return Settings.templateGallery || DEFAULTS
}

function storageDir() {
  return config().storageDir
}

function isCircuitOpen(err) {
  return err?.code === 'circuit_open'
}

function errorSummary(err) {
  const status = err?.status ? `HTTP ${err.status}: ` : ''
  return `${status}${err?.code ? `${err.code}: ` : ''}${err?.message || err}`.slice(0, 500)
}

function retryDelayMs(attempts) {
  return RETRY_DELAYS_MS[Math.min(Math.max(attempts, 1), RETRY_DELAYS_MS.length) - 1]
}

// Items the mirror is responsible for: crawled official items with a valid URL.
function isMirrorable(item) {
  return Boolean(
    item &&
      item.source !== 'upload' &&
      isValidToken(item.token) &&
      FAMILIES.includes(item.family) &&
      item.slug
  )
}

function isOverridden(item, field) {
  if (!item?.adminOverrides) return false
  if (item.adminOverrides[field] === true) return true
  const parts = field.split('.')
  let curr = item.adminOverrides
  for (const part of parts) {
    if (!curr || typeof curr !== 'object') return false
    curr = curr[part]
  }
  return curr === true
}

// Sets crawler-owned fields, leaving admin-edited ones untouched.
function assignOwned(target, item, fields) {
  for (const [field, value] of Object.entries(fields)) {
    if (value === undefined || isOverridden(item, field)) continue
    target[field] = value
  }
}

function isFuture(date) {
  return date != null && new Date(date).getTime() > Date.now()
}

async function findItem(token) {
  if (!isValidToken(token)) return null
  const col = await itemsCol()
  return col.findOne({ token }, { projection: ITEM_PROJECTION })
}

async function findFullItem(token) {
  const col = await itemsCol()
  return col.findOne({ token })
}

async function blobExists(sha) {
  return Boolean(sha) && BlobStore.exists(sha, storageDir())
}

async function currentMaxRecentOrder() {
  const col = await itemsCol()
  const top = await col.findOne(
    { recentOrder: { $type: 'number' } },
    { sort: { recentOrder: -1 }, projection: { recentOrder: 1 } }
  )
  return Number.isFinite(top?.recentOrder) ? top.recentOrder : 0
}

// ---------------------------------------------------------------------------
// images (listing thumbnails and detail previews are the same published_ver
// JPEG, so one download serves both)

function needsImage(item, publishedId) {
  if (!item?.media?.thumbSha || !item?.media?.previewSha) return true
  return publishedId != null && item.mirror?.imagePublishedId !== publishedId
}

async function downloadImage(item, image, opts = {}) {
  const stored = await Fetch.storeS3Image(image.url, opts)
  const now = new Date()
  const fields = {
    'media.thumbSha': stored.sha256,
    'media.thumbMime': stored.mime,
    'media.previewSha': stored.sha256,
    'media.previewMime': stored.mime,
    'mirror.thumbAt': now,
    'mirror.previewAt': now,
    'mirror.imagePublishedId': image.publishedId,
  }
  const set = {}
  assignOwned(set, item, fields)
  return { set, stored }
}

async function mirrorImageFor(item, image, opts = {}) {
  if (!image?.url) return null
  const { set, stored } = await downloadImage(item, image, opts)
  const col = await itemsCol()
  await col.updateOne({ token: item.token }, { $set: set })
  incMetric('mirror_image', { status: 'ok' })
  return stored
}

/**
 * Downloads the thumbnails of freshly scraped cards (their signed URLs are
 * valid for 4 h only) unless the item already has the image of that version.
 */
async function mirrorCardImages(cards, opts = {}) {
  const withImages = cards.filter(card => card.imageUrl && card.publishedId)
  if (withImages.length === 0) return { stored: 0, failed: 0 }
  const col = await itemsCol()
  const items = await col
    .find(
      { token: { $in: withImages.map(card => card.token) } },
      { projection: ITEM_PROJECTION }
    )
    .toArray()
  const byToken = new Map(items.map(item => [item.token, item]))

  let stored = 0
  let failed = 0
  for (const card of withImages) {
    const item = byToken.get(card.token)
    if (!isMirrorable(item) || !needsImage(item, card.publishedId)) continue
    try {
      await mirrorImageFor(item, { url: card.imageUrl, publishedId: card.publishedId }, opts)
      stored++
    } catch (err) {
      failed++
      incMetric('mirror_image', { status: 'failed' })
      logWarn('tg.mirror.image_failed', {
        token: card.token,
        status: err?.status,
        message: err?.message,
      })
      if (isCircuitOpen(err)) break
    }
  }
  return { stored, failed }
}

// ---------------------------------------------------------------------------
// listing cards

function cardInsertFields(card, now) {
  return {
    token: card.token,
    family: card.family,
    slug: card.slug,
    title: card.title,
    author: card.author,
    description: card.description,
    tags: [],
    state: 'published',
    source: 'crawler',
    stats: { opens: 0, lastOpenedAt: null },
    createdAt: now,
  }
}

/**
 * Records listed cards. Unknown tokens become minimal items for the
 * catalogue to complete. `orders` maps token -> recentOrder to set.
 */
async function upsertCards(cards, { orders = new Map(), listed = false } = {}) {
  if (cards.length === 0) return
  const col = await itemsCol()
  const now = new Date()
  for (const card of cards) {
    const set = {}
    if (card.publishedId) set.publishedId = card.publishedId
    if (orders.has(card.token)) set.recentOrder = orders.get(card.token)
    if (listed) set['mirror.listedAt'] = now
    const update = { $setOnInsert: cardInsertFields(card, now) }
    if (Object.keys(set).length > 0) update.$set = set
    await col.updateOne({ token: card.token }, update, { upsert: true })
  }
}

// ---------------------------------------------------------------------------
// recent scan

async function readScanCheckpoint() {
  const col = await listingsCol()
  return (await col.findOne({ _id: RECENT_SCAN_ID })) || null
}

async function writeScanCheckpoint(fields) {
  const col = await listingsCol()
  await col.updateOne({ _id: RECENT_SCAN_ID }, { $set: fields }, { upsert: true })
}

async function fetchRecentPage(page, opts) {
  const res = await Fetch.fetchOverleafPage(recentHref('gallery', page), opts)
  if (res.status !== 200) {
    const err = new Error(`HTTP ${res.status} on recent page ${page}`)
    err.status = res.status
    err.code = 'unexpected_status'
    throw err
  }
  return parseListingPage(res.html)
}

async function saveFeatured(scope, cards) {
  if (cards.length === 0) {
    logWarn('tg.mirror.featured_empty', { scope })
    return 0
  }
  const col = await listingsCol()
  await col.updateOne(
    { _id: `featured:${scope}` },
    { $set: { tokens: cards.map(card => card.token), scrapedAt: new Date() } },
    { upsert: true }
  )
  return cards.length
}

function isPageDone(listing, page) {
  return (
    listing.recent.length < PAGE_SIZE ||
    (listing.lastPage != null && page >= listing.lastPage)
  )
}

async function scanFull({ fromPage, toPage, priority }) {
  const checkpoint = await readScanCheckpoint()
  let baseOrder = checkpoint?.baseOrder
  if (fromPage === 1 || !Number.isFinite(baseOrder)) {
    baseOrder = (await currentMaxRecentOrder()) + RECENT_ORDER_HEADROOM
    await writeScanCheckpoint({
      baseOrder,
      nextPage: fromPage,
      startedAt: new Date(),
      finishedAt: null,
    })
  }

  const result = { pages: 0, items: 0, done: false, nextPage: fromPage }
  for (let page = fromPage; page <= toPage; page++) {
    const listing = await fetchRecentPage(page, { priority })
    result.pages++
    result.items += listing.recent.length

    const orders = new Map()
    listing.recent.forEach((card, index) => {
      orders.set(card.token, baseOrder - ((page - 1) * PAGE_SIZE + index))
    })
    await upsertCards(listing.recent, { orders, listed: true })
    if (page === 1) {
      await upsertCards(listing.featured)
      await saveFeatured('gallery', listing.featured)
    }
    await mirrorCardImages([...listing.recent, ...listing.featured], { priority })

    result.done = isPageDone(listing, page)
    result.nextPage = result.done ? 1 : page + 1
    await writeScanCheckpoint({
      nextPage: result.nextPage,
      ...(listing.lastPage ? { totalPages: listing.lastPage } : {}),
      ...(result.done ? { finishedAt: new Date() } : {}),
    })
    if (result.done) break
  }
  return result
}

async function scanIncremental({ toPage, priority }) {
  const listings = []
  const result = { pages: 0, items: 0, done: false, nextPage: null }
  for (let page = 1; page <= toPage; page++) {
    const listing = await fetchRecentPage(page, { priority })
    listings.push(listing)
    result.pages++
    result.items += listing.recent.length
    if (isPageDone(listing, page)) {
      result.done = true
      break
    }
  }

  const cards = []
  const seen = new Set()
  for (const listing of listings) {
    for (const card of listing.recent) {
      if (seen.has(card.token)) continue
      seen.add(card.token)
      cards.push(card)
    }
  }

  // Only tokens without an order yet move: they go above everything known,
  // keeping their page order. Known items keep their full-scan position.
  const col = await itemsCol()
  const known = await col
    .find(
      { token: { $in: cards.map(card => card.token) }, recentOrder: { $type: 'number' } },
      { projection: { token: 1 } }
    )
    .toArray()
  const knownTokens = new Set(known.map(item => item.token))
  const fresh = cards.filter(card => !knownTokens.has(card.token))
  const orders = new Map()
  if (fresh.length > 0) {
    const max = await currentMaxRecentOrder()
    fresh.forEach((card, index) => orders.set(card.token, max + fresh.length - index))
  }

  const featured = listings[0]?.featured || []
  await upsertCards(cards, { orders, listed: true })
  await upsertCards(featured)
  if (listings[0]) await saveFeatured('gallery', featured)
  await mirrorCardImages([...cards, ...featured], { priority })
  if (fresh.length > 0) logInfo('tg.mirror.recent_new_items', { count: fresh.length })
  return result
}

/**
 * Scans https://www.overleaf.com/gallery (page 1) and /gallery/recent/page/N.
 *
 * Pages 1..3 run as an incremental check for new submissions. Any other
 * range is a chunk of the full scan, resumable from the `scan:gallery-recent`
 * checkpoint (omit fromPage to resume, fromPage 1 starts a new scan).
 */
export async function scanGalleryRecent({
  fromPage,
  toPage = Infinity,
  priority = 'background',
  mode,
} = {}) {
  let start = Number(fromPage)
  if (!Number.isInteger(start) || start < 1) {
    start = (await readScanCheckpoint())?.nextPage || 1
  }
  const end = Number.isFinite(Number(toPage)) ? Math.max(start, Number(toPage)) : Infinity
  const incremental =
    mode === 'incremental' || (mode !== 'full' && start === 1 && end <= INCREMENTAL_MAX_PAGES)

  try {
    const result = incremental
      ? await scanIncremental({ toPage: end, priority })
      : await scanFull({ fromPage: start, toPage: end, priority })
    incMetric('mirror_recent_pages', { mode: incremental ? 'incremental' : 'full' })
    return result
  } catch (err) {
    logWarn('tg.mirror.recent_scan_failed', {
      fromPage: start,
      code: err?.code,
      status: err?.status,
      message: err?.message,
    })
    const checkpoint = incremental ? null : await readScanCheckpoint().catch(() => null)
    return {
      pages: 0,
      items: 0,
      done: false,
      nextPage: checkpoint?.nextPage ?? start,
      error: err?.code || err?.message || 'scan_failed',
    }
  }
}

/**
 * Scrapes the Featured blocks of /latex/templates and /gallery.
 */
export async function scanFeatured({ priority = 'background' } = {}) {
  const counts = { templates: 0, gallery: 0 }
  for (const [scope, path] of [
    ['templates', recentHref('templates', 1)],
    ['gallery', recentHref('gallery', 1)],
  ]) {
    try {
      const res = await Fetch.fetchOverleafPage(path, { priority })
      if (res.status !== 200) continue
      const { featured } = parseListingPage(res.html)
      await upsertCards(featured)
      counts[scope] = await saveFeatured(scope, featured)
      await mirrorCardImages(featured, { priority })
    } catch (err) {
      logWarn('tg.mirror.featured_failed', { scope, code: err?.code, message: err?.message })
      if (isCircuitOpen(err)) break
    }
  }
  return counts
}

// ---------------------------------------------------------------------------
// tags

function isValidTagName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 200 && !name.includes('/')
}

async function scrapeTag(scope, name, { priority }) {
  const res = await Fetch.fetchOverleafPage(taggedHref(scope, name, 1), { priority })
  const now = new Date()
  const parsed = res.status === 200 ? parseTagPage(res.html, name) : { known: false }

  const entry = parsed.known
    ? {
        h1Title: parsed.title,
        summary: parsed.summary,
        related: parsed.related,
        topPicks: parsed.topPicks.map(card => card.token),
        scrapedAt: now,
      }
    : { missing: true, h1Title: null, summary: '', related: [], topPicks: [], scrapedAt: now }

  const set = { [`byScope.${scope}`]: entry }
  if (parsed.known) set.canonicalTitle = parsed.title
  const col = await tagsCol()
  await col.updateOne({ _id: name }, { $set: set }, { upsert: true })

  if (parsed.known) {
    // Signed thumbnail URLs on this page are fresh; use them for any card
    // still missing its image.
    const cards = [...parsed.topPicks, ...parsed.cards]
    await upsertCards(cards)
    await mirrorCardImages(cards, { priority })
  }
  incMetric('mirror_tag', { scope, known: String(Boolean(parsed.known)) })
  return col.findOne({ _id: name })
}

/**
 * Ensures the official tag page metadata (h1 title, summary, related tags
 * order, top picks) for (scope, name) is mirrored. Returns the tag doc.
 */
export async function ensureTag(scope, name, opts = {}) {
  const work = (async () => {
    if (!SCOPES.includes(scope) || !isValidTagName(name)) return null
    const col = await tagsCol()
    const doc = await col.findOne({ _id: name })
    const scrapedAt = doc?.byScope?.[scope]?.scrapedAt
    const maxAgeMs = opts.maxAgeMs ?? TAG_MAX_AGE_MS
    if (!opts.force && scrapedAt && Date.now() - new Date(scrapedAt).getTime() <= maxAgeMs) {
      return doc
    }
    return singleFlight(`tag:${scope}:${name}`, () =>
      scrapeTag(scope, name, { priority: opts.priority || 'background' })
    )
  })()
  return settle(work, opts, `tag ${scope}/${name}`)
}

const SCOPE_COUNT_KEYS = { templates: 'template', examples: 'example', articles: 'article' }

function tagScopeCount(counts, scope) {
  if (scope === 'gallery') {
    return Object.values(SCOPE_COUNT_KEYS).reduce((sum, key) => sum + (Number(counts?.[key]) || 0), 0)
  }
  return Number(counts?.[SCOPE_COUNT_KEYS[scope]]) || 0
}

/**
 * Scrapes due (scope, tag) pairs: never scraped first (largest first), then
 * the stalest. Only pairs with items in that scope qualify.
 */
export async function runTagBatch({ limit = DEFAULT_BATCH_LIMITS.tag } = {}) {
  const result = { processed: 0, failed: 0 }
  try {
    const col = await tagsCol()
    const projection = { counts: 1 }
    for (const scope of SCOPES) projection[`byScope.${scope}.scrapedAt`] = 1
    const docs = await col.find({}, { projection }).toArray()

    const staleBefore = Date.now() - TAG_MAX_AGE_MS
    const pending = []
    const stale = []
    for (const doc of docs) {
      for (const scope of SCOPES) {
        const count = tagScopeCount(doc.counts, scope)
        if (count <= 0) continue
        const scrapedAt = doc.byScope?.[scope]?.scrapedAt
        if (!scrapedAt) pending.push({ scope, name: doc._id, count })
        else if (new Date(scrapedAt).getTime() < staleBefore) {
          stale.push({ scope, name: doc._id, at: new Date(scrapedAt).getTime() })
        }
      }
    }
    pending.sort((a, b) => b.count - a.count)
    stale.sort((a, b) => a.at - b.at)

    for (const { scope, name } of [...pending, ...stale].slice(0, limit)) {
      result.processed++
      try {
        await singleFlight(`tag:${scope}:${name}`, () =>
          scrapeTag(scope, name, { priority: 'background' })
        )
      } catch (err) {
        result.failed++
        logWarn('tg.mirror.tag_failed', { scope, name, code: err?.code, message: err?.message })
        if (isCircuitOpen(err)) break
      }
    }
  } catch (err) {
    logWarn('tg.mirror.tag_batch_failed', { message: err?.message })
  }
  return result
}

// ---------------------------------------------------------------------------
// detail

// Per-step retry bookkeeping on the item (detail uses the contract fields).
const FAILURE_FIELDS = {
  detail: {
    attempts: 'mirror.attempts',
    lastError: 'mirror.lastError',
    nextAttemptAt: 'mirror.nextAttemptAt',
  },
  pdf: {
    attempts: 'mirror.pdfAttempts',
    lastError: 'mirror.pdfLastError',
    nextAttemptAt: 'mirror.pdfNextAttemptAt',
  },
}

async function recordFailure(token, step, attempts, err) {
  // A closed-off host says nothing about the item itself.
  if (isCircuitOpen(err) || err?.code === 'host_backoff') return
  const fields = FAILURE_FIELDS[step]
  const col = await itemsCol()
  await col.updateOne(
    { token },
    {
      $set: {
        [fields.attempts]: attempts,
        [fields.lastError]: errorSummary(err),
        [fields.nextAttemptAt]: new Date(Date.now() + retryDelayMs(attempts)),
      },
    }
  )
}

async function markRemoved(token) {
  const col = await itemsCol()
  await col.updateOne({ token }, { $set: { 'mirror.removedAt': new Date() } })
  incMetric('mirror_removed')
  logInfo('tg.mirror.item_removed_upstream', { token })
}

function detailFields(item, detail) {
  const { cta } = detail
  const set = {}
  assignOwned(set, item, {
    publishedId: cta.publishedId,
    brandVariationId: cta.brandVariationId,
    templateName: cta.templateName,
    mainFile: cta.mainFile,
    latexEngine: cta.latexEngine,
    texImage: cta.texImage,
    lastUpdatedAt: detail.lastUpdatedAt,
    licenseLabel: detail.licenseLabel,
    abstractHtml: detail.abstractHtml,
    mainText: detail.mainText,
  })
  // Catalogue (Algolia) fields: only filled in when the catalogue has not.
  assignOwned(set, item, {
    title: item.title ? undefined : detail.title,
    author: item.author ? undefined : detail.author || undefined,
    tags: item.tags?.length ? undefined : detail.tags,
    official: item.official == null && detail.official ? true : undefined,
  })
  if (!item.objectID && cta.objectID) {
    set.objectID = cta.objectID
    const num = Number(cta.objectID)
    if (Number.isSafeInteger(num)) set.objectIDNum = num
  }
  return set
}

async function refreshDetail(token, { priority = 'background', forceImage = false } = {}) {
  const item = await findItem(token)
  if (!isMirrorable(item)) return item ? findFullItem(token) : null

  const attempts = (item.mirror?.attempts || 0) + 1
  let page
  let detail
  try {
    page = await Fetch.fetchOverleafPage(itemHref(item), { priority })
    if (page.status === 200) {
      detail = parseDetailPage(page.html)
      if (!detail) {
        const err = new Error('detail page did not match the expected layout')
        err.code = 'detail_unparseable'
        throw err
      }
    }
  } catch (err) {
    await recordFailure(token, 'detail', attempts, err)
    incMetric('mirror_detail', { status: 'failed' })
    throw err
  }

  if (page.status !== 200) {
    await markRemoved(token)
    return null
  }

  const now = new Date()
  const set = {
    ...detailFields(item, detail),
    'mirror.detailAt': now,
    'mirror.detailHash': detail.detailHash,
    'mirror.attempts': 0,
    'mirror.lastError': null,
    'mirror.nextAttemptAt': null,
    'mirror.removedAt': null,
  }
  // A changed page means a republished item: refetch its PDF (the old blob
  // keeps being served until then).
  if (item.mirror?.detailHash && item.mirror.detailHash !== detail.detailHash) {
    set['mirror.pdfAt'] = null
  }

  if (detail.preview && (forceImage || needsImage(item, detail.preview.publishedId))) {
    try {
      const { set: imageSet } = await downloadImage(item, detail.preview, { priority })
      Object.assign(set, imageSet)
    } catch (err) {
      logWarn('tg.mirror.preview_failed', { token, status: err?.status, message: err?.message })
    }
  }

  const col = await itemsCol()
  try {
    await col.updateOne({ token }, { $set: set })
  } catch (err) {
    if (err?.code !== 11000 || !set.objectID) throw err
    // objectID already claimed by another document: keep everything else.
    delete set.objectID
    delete set.objectIDNum
    await col.updateOne({ token }, { $set: set })
  }
  incMetric('mirror_detail', { status: 'ok' })
  return findFullItem(token)
}

/**
 * Ensures the item's detail (metadata, abstract, main .tex, CTA params,
 * preview JPEG) is mirrored. Returns the item, or null when unknown, gone
 * upstream or unavailable.
 */
export async function ensureDetail(
  token,
  { priority = 'background', maxAgeMs, force = false, timeoutMs, throwOnError = false } = {}
) {
  const opts = { priority, timeoutMs, throwOnError }
  const work = (async () => {
    const item = await findItem(token)
    if (!item) return null
    if (!isMirrorable(item)) return findFullItem(token)
    const detailAt = item.mirror?.detailAt
    const hasDetail = Boolean(detailAt)
    if (!force) {
      const fresh =
        hasDetail && (maxAgeMs == null || Date.now() - new Date(detailAt).getTime() <= maxAgeMs)
      if (fresh || item.mirror?.removedAt || isFuture(item.mirror?.nextAttemptAt)) {
        return hasDetail ? findFullItem(token) : null
      }
    }
    return singleFlight(`detail:${token}`, () => refreshDetail(token, { priority }))
  })()
  return settle(work, opts, `detail ${token}`)
}

/**
 * Picks items missing detail (then those older than 30 days), most recent
 * first, and mirrors them. Never throws.
 */
export async function runDetailBatch({ limit = DEFAULT_BATCH_LIMITS.detail } = {}) {
  const result = { processed: 0, failed: 0 }
  try {
    const now = new Date()
    const col = await itemsCol()
    const base = {
      source: { $ne: 'upload' },
      'mirror.removedAt': null,
      'mirror.nextAttemptAt': { $not: { $gt: now } },
    }
    const sort = { recentOrder: -1, objectIDNum: -1 }
    const missing = await col
      .find({ ...base, 'mirror.detailAt': null }, { projection: { token: 1 } })
      .sort(sort)
      .limit(limit)
      .toArray()
    let picked = missing
    if (picked.length < limit) {
      const stale = await col
        .find(
          { ...base, 'mirror.detailAt': { $lt: new Date(now.getTime() - DETAIL_MAX_AGE_MS) } },
          { projection: { token: 1 } }
        )
        .sort(sort)
        .limit(limit - picked.length)
        .toArray()
      picked = picked.concat(stale)
    }

    for (const { token } of picked) {
      if (!isValidToken(token)) continue
      result.processed++
      try {
        await singleFlight(`detail:${token}`, () => refreshDetail(token, { priority: 'background' }))
      } catch (err) {
        result.failed++
        logWarn('tg.mirror.detail_failed', { token, code: err?.code, status: err?.status, message: err?.message })
        if (isCircuitOpen(err)) break
      }
    }
  } catch (err) {
    logWarn('tg.mirror.detail_batch_failed', { message: err?.message })
  }
  return result
}

// ---------------------------------------------------------------------------
// pdf

async function refreshPdf(token, { priority = 'background' } = {}) {
  const item = await findItem(token)
  if (!isMirrorable(item)) return null
  const attempts = (item.mirror?.pdfAttempts || 0) + 1
  let res
  try {
    res = await Fetch.storeOverleafPdf(itemPdfHref(item), { priority })
  } catch (err) {
    await recordFailure(token, 'pdf', attempts, err)
    incMetric('mirror_pdf', { status: 'failed' })
    throw err
  }
  if (res.status !== 200) {
    const col = await itemsCol()
    await col.updateOne(
      { token },
      {
        $set: {
          'mirror.pdfAt': new Date(),
          'mirror.pdfAttempts': attempts,
          'mirror.pdfLastError': `PDF unavailable (HTTP ${res.status})`,
          'mirror.pdfNextAttemptAt': null,
        },
      }
    )
    incMetric('mirror_pdf', { status: 'unavailable' })
    return null
  }
  const col = await itemsCol()
  const set = {
    'mirror.pdfAt': new Date(),
    'mirror.pdfAttempts': 0,
    'mirror.pdfLastError': null,
    'mirror.pdfNextAttemptAt': null,
  }
  if (!isOverridden(item, 'media.pdfSha')) {
    assignOwned(set, item, {
      'media.pdfSha': res.sha256,
      'media.pdfBytes': res.sizeBytes,
    })
  }
  await col.updateOne({ token }, { $set: set })
  incMetric('mirror_pdf', { status: 'ok' })
  const finalSha = isOverridden(item, 'media.pdfSha') ? item.media?.pdfSha : res.sha256
  const finalBytes = isOverridden(item, 'media.pdfSha') ? item.media?.pdfBytes : res.sizeBytes
  return { sha: finalSha, bytes: finalBytes }
}

/**
 * Ensures the official PDF of the item is in the BlobStore.
 * Returns { sha, bytes } or null.
 */
export async function ensurePdf(
  token,
  { priority = 'background', force = false, timeoutMs, throwOnError = false } = {}
) {
  const opts = { priority, timeoutMs, throwOnError }
  const work = (async () => {
    const item = await findItem(token)
    if (!item) return null
    const sha = item.media?.pdfSha
    const existing = sha ? { sha, bytes: item.media.pdfBytes ?? null } : null
    if (!force && existing && (await blobExists(sha))) return existing
    if (!isMirrorable(item)) return null
    if (!force && (item.mirror?.removedAt || isFuture(item.mirror?.pdfNextAttemptAt))) {
      return null
    }
    if (!force && item.mirror?.pdfAt && !sha) {
      return null
    }
    return singleFlight(`pdf:${token}`, () => refreshPdf(token, { priority }))
  })()
  return settle(work, opts, `pdf ${token}`)
}

/**
 * Mirrors PDFs for items whose detail is known and whose PDF is missing or
 * stale, most recent first. Never throws.
 */
export async function runPdfBatch({ limit = DEFAULT_BATCH_LIMITS.pdf } = {}) {
  const result = { processed: 0, failed: 0 }
  try {
    const now = new Date()
    const col = await itemsCol()
    const picked = await col
      .find(
        {
          source: { $ne: 'upload' },
          'mirror.detailAt': { $ne: null },
          'mirror.pdfAt': null,
          'mirror.removedAt': null,
          'mirror.pdfNextAttemptAt': { $not: { $gt: now } },
        },
        { projection: { token: 1 } }
      )
      .sort({ recentOrder: -1, objectIDNum: -1 })
      .limit(limit)
      .toArray()

    for (const { token } of picked) {
      if (!isValidToken(token)) continue
      result.processed++
      try {
        await singleFlight(`pdf:${token}`, () => refreshPdf(token, { priority: 'background' }))
      } catch (err) {
        result.failed++
        logWarn('tg.mirror.pdf_failed', { token, code: err?.code, status: err?.status, message: err?.message })
        if (isCircuitOpen(err)) break
      }
    }
  } catch (err) {
    logWarn('tg.mirror.pdf_batch_failed', { message: err?.message })
  }
  return result
}

// ---------------------------------------------------------------------------
// media

const MEDIA_KINDS = { thumb: 'preview', preview: 'thumb' }

/**
 * Ensures the thumbnail or preview JPEG of the item is in the BlobStore.
 * Signed image URLs are never stored, so a missing image needs a fresh
 * detail page fetch. Returns { sha, mime } or null.
 */
export async function ensureMedia(token, kind, opts = {}) {
  const { priority = 'background', force = false } = opts
  const work = (async () => {
    if (!MEDIA_KINDS[kind]) return null
    let item = await findItem(token)
    if (!item) return null

    const sha = item.media?.[`${kind}Sha`]
    if (!force && sha && (await blobExists(sha))) {
      return { sha, mime: item.media[`${kind}Mime`] || 'image/jpeg' }
    }
    // Thumbnail and preview are the same published image.
    const other = MEDIA_KINDS[kind]
    const otherSha = item.media?.[`${other}Sha`]
    if (!force && otherSha && !isOverridden(item, `media.${kind}Sha`) && (await blobExists(otherSha))) {
      const mime = item.media[`${other}Mime`] || 'image/jpeg'
      const col = await itemsCol()
      await col.updateOne(
        { token },
        { $set: { [`media.${kind}Sha`]: otherSha, [`media.${kind}Mime`]: mime } }
      )
      return { sha: otherSha, mime }
    }

    if (!isMirrorable(item)) return null
    if (!force && (item.mirror?.removedAt || isFuture(item.mirror?.nextAttemptAt))) return null

    await singleFlight(`detail:${token}`, () =>
      refreshDetail(token, { priority, forceImage: true })
    )
    item = await findItem(token)
    const stored = item?.media?.[`${kind}Sha`]
    if (!stored || !(await blobExists(stored))) return null
    return { sha: stored, mime: item.media[`${kind}Mime`] || 'image/jpeg' }
  })()
  return settle(work, opts, `${kind} ${token}`)
}

export default {
  ensureDetail,
  ensurePdf,
  ensureMedia,
  ensureTag,
  scanGalleryRecent,
  scanFeatured,
  runDetailBatch,
  runPdfBatch,
  runTagBatch,
}
