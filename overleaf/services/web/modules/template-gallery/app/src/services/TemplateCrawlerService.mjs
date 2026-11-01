import {
  crawlerStateCol,
  itemsCol,
  tagsCol,
} from '../persistence/Collections.mjs'
import AlgoliaProxyClient from './AlgoliaProxyClient.mjs'
import { FAMILIES, parseItemUrl } from '../util/GalleryUrls.mjs'
import { logInfo, logWarn } from '../observability/Log.mjs'

// Catalogue crawler: enumerates every hit of the Algolia gallery index with a
// recursive facet partition tree (MASTER-SPEC 7.1) and upserts the
// crawler-owned fields of each item keyed by token.
//
// Algolia returns at most 1000 hits per query and the public key cannot
// browse, so any node with more hits is split on the most balanced facet value
// (`tags.title` or `official`) into `F AND v` / `F AND NOT v` until every leaf
// fits. The two sides are disjoint by construction; the run is only accepted
// when the leaves add up to the root nbHits with no duplicate objectIDs.

export const MAX_LEAF_HITS = 1000
const MAX_TREE_DEPTH = 40
const BULK_CHUNK = 500

const PARTITION_FACETS = ['tags.title', 'official']
const HIT_ATTRIBUTES = [
  'objectID',
  'title',
  'author',
  'description',
  'tags',
  'featured',
  'url',
  'brand',
  'brandVariation',
  'official',
  'type',
  'imageUrl',
]

const CATALOGUE_DOC_ID = 'catalogue'

let activeRun = null

function codedError(code, message, extra = {}) {
  const err = new Error(message)
  err.code = code
  Object.assign(err, extra)
  return err
}

function and(filters, clause) {
  return filters ? `${filters} AND ${clause}` : clause
}

function str(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function triState(value) {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return null
}

const DATA_URI_REGEX =
  /^data:image\/(?:jpeg|jpg|png|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/

// Inline thumbnails are copied into every item row, so oversized ones are dropped.
export const MAX_THUMB_DATA_URI_BYTES = 64 * 1024

/**
 * Algolia's imageUrl is a base64 JPEG data URI wrapped with newlines.
 * Returns null when it is not one, or is larger than MAX_THUMB_DATA_URI_BYTES.
 */
export function normalizeDataUri(value) {
  if (typeof value !== 'string' || !value.startsWith('data:image/')) return null
  const compact = value.replace(/\s+/g, '')
  if (compact.length > MAX_THUMB_DATA_URI_BYTES) return null
  return DATA_URI_REGEX.test(compact) ? compact : null
}

export function normalizeTags(tags) {
  if (!Array.isArray(tags)) return []
  const seen = new Set()
  const result = []
  for (const tag of tags) {
    const name = str(tag?.name).trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    result.push({ name, title: str(tag?.title).trim() || name })
  }
  return result
}

/**
 * Maps an Algolia hit to the crawler-owned item fields, or null when the hit
 * has no usable objectID or item URL.
 */
export function transformHit(hit) {
  const parsed = parseItemUrl(hit?.url)
  const objectID = str(hit?.objectID).trim()
  if (!parsed || !objectID) return null
  const objectIDNum = Number(objectID)
  return {
    token: parsed.token,
    objectID,
    objectIDNum: Number.isSafeInteger(objectIDNum) ? objectIDNum : null,
    family: FAMILIES.includes(hit.type) ? hit.type : parsed.family,
    slug: parsed.slug,
    title: str(hit.title),
    author: str(hit.author),
    description: str(hit.description),
    tags: normalizeTags(hit.tags),
    featured: hit.featured === true,
    official: triState(hit.official),
    brand: hit.brand ?? null,
    brandVariation: hit.brandVariation ?? null,
    thumbDataUri: normalizeDataUri(hit.imageUrl),
  }
}

/**
 * Picks the most balanced facet split for an oversized node. Values that
 * cannot be quoted safely in an Algolia filter are skipped.
 *
 * @returns {{ positive: string, negative: string, size: number } | null}
 */
export function chooseSplit(facets, nbHits) {
  const candidates = []
  for (const [title, count] of Object.entries(facets?.['tags.title'] || {})) {
    if (!(count > 0 && count < nbHits) || /["\\]/.test(title)) continue
    candidates.push({
      score: Math.max(count, nbHits - count),
      key: `t:${title}`,
      positive: `tags.title:"${title}"`,
      negative: `NOT tags.title:"${title}"`,
      size: count,
    })
  }
  for (const value of ['true', 'false']) {
    const count = facets?.official?.[value] || 0
    if (!(count > 0 && count < nbHits)) continue
    candidates.push({
      score: Math.max(count, nbHits - count),
      key: `o:${value}`,
      positive: `official:${value}`,
      negative: `NOT official:${value}`,
      size: count,
    })
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.score - b.score || a.key.localeCompare(b.key))
  const { positive, negative, size } = candidates[0]
  return { positive, negative, size }
}

function assertExhaustive(res, filters) {
  if (res?.exhaustiveNbHits === false || res?.exhaustive?.nbHits === false) {
    throw codedError(
      'catalogue_not_exhaustive',
      `Algolia nbHits is approximate for filters: ${filters || '(root)'}`
    )
  }
}

/**
 * Builds the partition tree. `query(params)` performs one Algolia query.
 *
 * @returns {Promise<{ rootNbHits: number, leaves: Array<{ filters: string, nbHits: number }>, calls: number }>}
 */
export async function buildPartitionTree(query, { shouldStop } = {}) {
  const leaves = []
  let calls = 0

  async function facetQuery(filters) {
    if (shouldStop && (await shouldStop())) {
      throw codedError('catalogue_stopped', 'catalogue run stopped')
    }
    calls++
    const params = {
      query: '',
      hitsPerPage: 0,
      facets: PARTITION_FACETS,
      maxValuesPerFacet: 1000,
      analytics: false,
    }
    if (filters) params.filters = filters
    const res = await query(params)
    assertExhaustive(res, filters)
    return res
  }

  async function visit(filters, res, depth) {
    const nbHits = Number(res?.nbHits) || 0
    if (nbHits === 0) return
    if (nbHits <= MAX_LEAF_HITS) {
      leaves.push({ filters, nbHits })
      return
    }
    if (depth >= MAX_TREE_DEPTH) {
      throw codedError(
        'catalogue_too_deep',
        `partition tree too deep at ${filters}`
      )
    }
    const split = chooseSplit(res.facets, nbHits)
    if (!split) {
      throw codedError(
        'catalogue_unsplittable',
        `cannot split ${nbHits} hits for filters: ${filters || '(root)'}`
      )
    }
    for (const clause of [split.positive, split.negative]) {
      const childFilters = and(filters, clause)
      await visit(childFilters, await facetQuery(childFilters), depth + 1)
    }
  }

  const root = await facetQuery('')
  const rootNbHits = Number(root?.nbHits) || 0
  await visit('', root, 0)
  return { rootNbHits, leaves, calls }
}

/**
 * Fetches every hit of a leaf (one page of 1000 in practice).
 */
export async function fetchLeafHits(query, filters) {
  const hits = []
  let page = 0
  let nbPages = 1
  let nbHits = 0
  do {
    const params = {
      query: '',
      hitsPerPage: MAX_LEAF_HITS,
      page,
      attributesToRetrieve: HIT_ATTRIBUTES,
      attributesToHighlight: [],
      attributesToSnippet: [],
      analytics: false,
    }
    if (filters) params.filters = filters
    const res = await query(params)
    assertExhaustive(res, filters)
    nbHits = Number(res?.nbHits) || 0
    nbPages = Number(res?.nbPages) || 1
    const pageHits = Array.isArray(res?.hits) ? res.hits : []
    hits.push(...pageHits)
    page++
    if (pageHits.length === 0) break
  } while (page < nbPages && hits.length < nbHits)
  return { hits, nbHits }
}

/**
 * Builds the bulkWrite operation for one catalogued item.
 *
 * @param {object} doc - transformHit() output
 * @param {object | undefined} existing - projection of the stored doc, if any
 * @param {Date} now
 */
export function buildItemUpsert(doc, existing, now) {
  const $set = { 'mirror.catalogAt': now }
  for (const [field, value] of Object.entries(doc)) $set[field] = value

  if (!existing) {
    return {
      updateOne: {
        filter: { token: doc.token },
        update: {
          $set,
          $setOnInsert: {
            state: 'published',
            stats: { opens: 0, lastOpenedAt: null },
            createdAt: now,
          },
        },
        upsert: true,
      },
    }
  }

  const $unset = {}
  if (existing.mirror?.removedAt) {
    $unset['mirror.removedAt'] = ''
    $set['mirror.removedRuns'] = 0
  }
  if (existing.mirror?.unpublishedByCrawler) {
    $unset['mirror.unpublishedByCrawler'] = ''
    if (existing.state === 'unpublished') $set.state = 'published'
  }
  const update = { $set }
  if (Object.keys($unset).length > 0) update.$unset = $unset
  return {
    updateOne: {
      filter: { _id: existing._id },
      update,
    },
  }
}

/**
 * Accumulates per-tag family counts and Algolia title variants.
 */
export function createTagStats() {
  const byName = new Map()
  return {
    add(doc) {
      for (const tag of doc.tags) {
        let entry = byName.get(tag.name)
        if (!entry) {
          entry = {
            counts: { template: 0, example: 0, article: 0 },
            titles: new Map(),
          }
          byName.set(tag.name, entry)
        }
        if (entry.counts[doc.family] !== undefined) entry.counts[doc.family]++
        entry.titles.set(tag.title, (entry.titles.get(tag.title) || 0) + 1)
      }
    },
    entries() {
      return [...byName.entries()].map(([name, entry]) => {
        const titles = [...entry.titles.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([title]) => title)
        return { name, counts: entry.counts, titles }
      })
    },
  }
}

const BULK_ERROR_NAMES = new Set(['MongoBulkWriteError', 'BulkWriteError'])

function isDuplicateOnlyBulkError(err) {
  if (!BULK_ERROR_NAMES.has(err?.name)) return false
  const result = err.result
  const raw = result?.getRawResponse?.() || result?.result || result
  // A partial result can contain duplicate-key errors alongside failed write
  // concern or other write failures. Its wrapper name/code is not sufficient.
  if (
    err.err ||
    err.writeConcernError ||
    err.writeConcernErrors?.length ||
    result?.getWriteConcernError?.() ||
    raw?.writeConcernError ||
    raw?.writeConcernErrors?.length
  ) {
    return false
  }
  const writeErrors = [
    ...(err.writeErrors || []),
    ...(result?.getWriteErrors?.() || raw?.writeErrors || []),
  ]
  return (
    (err.code == null || err.code === 11000) &&
    writeErrors.length > 0 &&
    writeErrors.every(writeError => writeError.code === 11000)
  )
}

// Items whose insert lost a race (duplicate token) were not written. They only
// get the run stamp, so markRemoved does not count them as missing from the
// catalogue; the next run updates them.
async function deferConflicts(col, tokens, startedAt) {
  const res = await col.updateMany(
    { token: { $in: tokens }, 'mirror.catalogAt': { $ne: startedAt } },
    { $set: { 'mirror.catalogAt': startedAt } }
  )
  return res?.modifiedCount || 0
}

async function bulkWriteChunked(col, ops) {
  const totals = { inserted: 0, matched: 0 }
  for (let i = 0; i < ops.length; i += BULK_CHUNK) {
    const res = await col.bulkWrite(ops.slice(i, i + BULK_CHUNK), {
      ordered: false,
    })
    totals.inserted += res?.upsertedCount || 0
    totals.matched += res?.matchedCount || 0
  }
  return totals
}

// Item writes of one catalogue leaf. Conflicting items are deferred (see above).
async function bulkWriteItems(col, ops, tokens, startedAt) {
  const totals = { inserted: 0, matched: 0, deferred: 0 }
  for (let i = 0; i < ops.length; i += BULK_CHUNK) {
    const chunk = ops.slice(i, i + BULK_CHUNK)
    let res
    try {
      res = await col.bulkWrite(chunk, { ordered: false })
    } catch (err) {
      // Unordered writes: a duplicate-key race only fails its own operation.
      if (!isDuplicateOnlyBulkError(err)) throw err
      res = err.result
    }
    totals.inserted += res?.upsertedCount || 0
    totals.matched += res?.matchedCount || 0
    const applied = (res?.matchedCount || 0) + (res?.upsertedCount || 0)
    if (applied < chunk.length) {
      totals.deferred += await deferConflicts(
        col,
        tokens.slice(i, i + BULK_CHUNK),
        startedAt
      )
    }
  }
  return totals
}

async function loadExistingIndex(col) {
  const byToken = new Map()
  const byObjectID = new Map()
  const cursor = col.find(
    {},
    {
      projection: {
        token: 1,
        objectID: 1,
        state: 1,
        'mirror.removedAt': 1,
        'mirror.unpublishedByCrawler': 1,
      },
    }
  )
  for await (const doc of cursor) {
    if (typeof doc.token === 'string') byToken.set(doc.token, doc)
    if (typeof doc.objectID === 'string' && doc.objectID) {
      byObjectID.set(doc.objectID, doc)
    }
  }
  return {
    find(doc) {
      return byToken.get(doc.token) || byObjectID.get(doc.objectID)
    },
  }
}

async function writeTags(tagStats, now) {
  const col = await tagsCol()
  const canonical = new Map()
  const cursor = col.find({}, { projection: { canonicalTitle: 1 } })
  for await (const doc of cursor) canonical.set(doc._id, doc.canonicalTitle)

  const entries = tagStats.entries()
  const ops = entries.map(({ name, counts, titles }) => {
    const $set = { counts, titles, catalogAt: now }
    if (!canonical.get(name)) $set.canonicalTitle = titles[0]
    return {
      updateOne: { filter: { _id: name }, update: { $set }, upsert: true },
    }
  })
  await bulkWriteChunked(col, ops)
  await col.updateMany(
    { _id: { $nin: entries.map(entry => entry.name) } },
    {
      $set: { counts: { template: 0, example: 0, article: 0 }, catalogAt: now },
    }
  )
  return entries.length
}

// Items absent from a complete catalogue are flagged on the first miss and
// unpublished on the second consecutive miss; nothing is deleted.
async function markRemoved(col, runStartedAt) {
  const stale = {
    objectID: { $type: 'string' },
    $or: [
      { 'mirror.catalogAt': { $lt: runStartedAt } },
      { 'mirror.catalogAt': { $exists: false } },
    ],
  }
  const previouslyRemoved = { ...stale, 'mirror.removedAt': { $type: 'date' } }
  await col.updateMany(previouslyRemoved, { $inc: { 'mirror.removedRuns': 1 } })
  const unpublished = await col.updateMany(
    { ...previouslyRemoved, state: 'published' },
    {
      $set: {
        state: 'unpublished',
        'mirror.unpublishedByCrawler': true,
        updatedAt: runStartedAt,
      },
    }
  )
  const removed = await col.updateMany(
    { ...stale, 'mirror.removedAt': { $not: { $type: 'date' } } },
    { $set: { 'mirror.removedAt': runStartedAt, 'mirror.removedRuns': 1 } }
  )
  return {
    removed: removed?.modifiedCount || 0,
    unpublished: unpublished?.modifiedCount || 0,
  }
}

async function saveCatalogueState(fields) {
  const col = await crawlerStateCol()
  await col.updateOne(
    { _id: CATALOGUE_DOC_ID },
    { $set: { ...fields, updatedAt: new Date() } },
    { upsert: true }
  )
}

async function executeCatalogue({ shouldStop, query }) {
  const startedAt = new Date()
  const algoliaQuery =
    query ||
    (params => AlgoliaProxyClient.queryAlgolia(params, { priority: 'background' }))
  let calls = 0
  const runQuery = params => {
    calls++
    return algoliaQuery(params)
  }
  const stopCheck = async () => Boolean(shouldStop && (await shouldStop()))

  await saveCatalogueState({ status: 'running', startedAt, lastError: null })

  try {
    const tree = await buildPartitionTree(runQuery, { shouldStop: stopCheck })
    const col = await itemsCol()
    const existing = await loadExistingIndex(col)
    const tagStats = createTagStats()
    const seen = new Set()
    let leafHitTotal = 0
    let invalid = 0
    let inserted = 0
    let updated = 0
    let deferred = 0

    for (const leaf of tree.leaves) {
      if (await stopCheck()) {
        throw codedError('catalogue_stopped', 'catalogue run stopped')
      }
      const { hits, nbHits } = await fetchLeafHits(runQuery, leaf.filters)
      leafHitTotal += nbHits

      const ops = []
      const opTokens = []
      for (const hit of hits) {
        const objectID = str(hit?.objectID)
        if (seen.has(objectID)) continue
        seen.add(objectID)
        const doc = transformHit(hit)
        if (!doc) {
          invalid++
          continue
        }
        tagStats.add(doc)
        ops.push(buildItemUpsert(doc, existing.find(doc), startedAt))
        opTokens.push(doc.token)
      }
      const res = await bulkWriteItems(col, ops, opTokens, startedAt)
      inserted += res.inserted
      updated += res.matched
      deferred += res.deferred
    }

    // The index is live: a template added or removed while the leaves were read
    // moves the totals. Tags and upserts use the hits seen; removals need a
    // crawl that saw exactly the root's hits, so a drifted run removes nothing
    // and the next run settles it.
    const complete =
      leafHitTotal === tree.rootNbHits && seen.size === tree.rootNbHits
    if (!complete) {
      logWarn('catalogue_drift', {
        leafHitTotal,
        unique: seen.size,
        root: tree.rootNbHits,
      })
    }

    const tags = await writeTags(tagStats, startedAt)
    const { removed, unpublished } = complete
      ? await markRemoved(col, startedAt)
      : { removed: 0, unpublished: 0 }
    const result = {
      total: tree.rootNbHits,
      inserted,
      updated,
      deferred,
      removed,
      unpublished,
      invalid,
      tags,
      leaves: tree.leaves.length,
      calls,
    }
    await saveCatalogueState({
      status: 'completed',
      finishedAt: new Date(),
      lastSuccessAt: new Date(),
      lastResult: result,
    })
    if (invalid > 0) logWarn('catalogue_invalid_hits', { invalid })
    logInfo('catalogue_completed', result)
    return result
  } catch (err) {
    const stopped = err.code === 'catalogue_stopped'
    await saveCatalogueState({
      status: stopped ? 'stopped' : 'failed',
      finishedAt: new Date(),
      lastError: stopped ? null : String(err.message).slice(0, 500),
    }).catch(() => {})
    throw err
  }
}

/**
 * Runs one full catalogue pass. Concurrent callers share the running pass.
 *
 * @param {{ shouldStop?: () => Promise<boolean>|boolean, query?: Function }} [opts]
 * @returns {Promise<{ total, inserted, updated, removed, unpublished, invalid, tags, leaves, calls }>}
 */
export function runCatalogue(opts = {}) {
  if (!activeRun) {
    activeRun = executeCatalogue(opts).finally(() => {
      activeRun = null
    })
  }
  return activeRun
}

export function isCatalogueRunning() {
  return Boolean(activeRun)
}

export async function getCatalogueState() {
  const col = await crawlerStateCol()
  return col.findOne({ _id: CATALOGUE_DOC_ID })
}

export async function getStatus() {
  const catalogue = await getCatalogueState()
  return {
    running: isCatalogueRunning(),
    catalogue: catalogue || { status: 'never_run' },
  }
}

export default {
  MAX_LEAF_HITS,
  normalizeDataUri,
  normalizeTags,
  transformHit,
  chooseSplit,
  buildPartitionTree,
  fetchLeafHits,
  buildItemUpsert,
  createTagStats,
  runCatalogue,
  isCatalogueRunning,
  getCatalogueState,
  getStatus,
}
