import { itemsCol, jobsCol } from './Collections.mjs'
import { logWarn } from '../observability/Log.mjs'

// MongoDB error codes for an index that exists with other options/keys.
const INDEX_CONFLICT_CODES = new Set([85, 86])

// Items are mirrored from overleaf.com, so these are the only item indexes.
// token_unique is not essential: a duplicate token fails its build, is logged
// and reported, and startup continues.
const ITEM_INDEXES = [
  {
    keys: { token: 1 },
    options: {
      name: 'token_unique',
      unique: true,
      partialFilterExpression: { token: { $type: 'string' } },
    },
  },
  {
    keys: { objectID: 1 },
    options: {
      name: 'objectID_unique',
      unique: true,
      partialFilterExpression: { objectID: { $type: 'string' } },
    },
  },
  { keys: { slug: 1 }, options: { name: 'slug_1' } },
  {
    keys: { family: 1, recentOrder: -1, objectIDNum: -1 },
    options: { name: 'family_recent' },
  },
  {
    keys: { recentOrder: -1, objectIDNum: -1 },
    options: { name: 'recent_all' },
  },
  {
    keys: { 'tags.name': 1, family: 1, recentOrder: -1 },
    options: { name: 'tags_family_recent' },
  },
  { keys: { featured: 1 }, options: { name: 'featured_1' } },
  {
    keys: { 'mirror.nextAttemptAt': 1 },
    options: { name: 'mirror_nextAttemptAt' },
  },
  {
    keys: { 'integrity.lastCheckedAt': 1 },
    options: { name: 'integrity_lastCheckedAt' },
  },
  // dedup: tombstones are excluded from every read path; PDFs are grouped by hash
  { keys: { duplicateOf: 1 }, options: { name: 'duplicateOf_1' } },
  { keys: { 'media.pdfSha': 1 }, options: { name: 'media_pdfSha_1' } },
  {
    keys: {
      title: 'text',
      'tags.title': 'text',
      author: 'text',
      description: 'text',
    },
    options: {
      name: 'tg_text',
      weights: { title: 10, 'tags.title': 5, author: 3, description: 1 },
      default_language: 'none',
    },
    text: true,
  },
]

const JOB_INDEXES = [
  {
    keys: { state: 1, runAfter: 1, createdAt: 1 },
    options: { name: 'state_runAfter_createdAt' },
    essential: true,
  },
  {
    keys: { dedupeKey: 1 },
    options: {
      name: 'dedupeKey_unique_partial',
      unique: true,
      partialFilterExpression: { dedupeKey: { $type: 'string' } },
    },
    essential: true,
  },
  { keys: { itemId: 1, createdAt: -1 }, options: { name: 'itemId_createdAt' } },
  {
    keys: { finishedAt: 1 },
    options: { name: 'finishedAt_ttl_30d', expireAfterSeconds: 30 * 24 * 3600 },
  },
]

async function createIndex(col, { keys, options }) {
  try {
    await col.createIndex(keys, options)
  } catch (err) {
    if (!INDEX_CONFLICT_CODES.has(err?.code)) throw err
    // same name or keys with other options: rebuild with the current spec
    try {
      await col.dropIndex(options.name)
    } catch {
      // absent: nothing to drop
    }
    await col.createIndex(keys, options)
  }
}

async function ensureCollectionIndexes(name, getCol, specs, report) {
  let col
  try {
    col = await getCol()
  } catch (err) {
    report.essentialOk = false
    report.failed.push({
      collection: name,
      keys: 'collection_access',
      error: err.message,
    })
    return
  }
  for (const spec of specs) {
    try {
      await createIndex(col, spec)
    } catch (err) {
      if (spec.essential) report.essentialOk = false
      if (spec.text) report.textIndexOk = false
      report.failed.push({
        collection: name,
        keys: spec.keys,
        error: err.message,
      })
      logWarn('index_create_failed', {
        collection: name,
        index: spec.options.name,
        error: err.message,
      })
    }
  }
}

/**
 * Creates every index the gallery uses. A failed non-essential index is
 * reported but never blocks startup.
 *
 * @returns {Promise<{ essentialOk: boolean, textIndexOk: boolean, failed: Array<{ collection: string, keys: any, error: string }> }>}
 */
export async function ensureAll() {
  const report = { essentialOk: true, textIndexOk: true, failed: [] }
  await ensureCollectionIndexes(
    'templateGalleryItems',
    itemsCol,
    ITEM_INDEXES,
    report
  )
  await ensureCollectionIndexes(
    'templateGalleryJobs',
    jobsCol,
    JOB_INDEXES,
    report
  )
  return report
}

export default {
  ensureAll,
}
