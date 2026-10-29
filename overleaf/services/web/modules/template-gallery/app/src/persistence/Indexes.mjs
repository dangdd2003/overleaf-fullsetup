import { itemsCol, jobsCol, auditCol } from './Collections.mjs'
import { migrateItems } from './Migrations.mjs'
import { logWarn } from '../observability/Log.mjs'

// MongoDB error codes for an index that exists with other options/keys.
const INDEX_CONFLICT_CODES = new Set([85, 86])

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
  { keys: { state: 1, updatedAt: -1 }, options: { name: 'state_updatedAt' } },
  { keys: { 'zip.sha256': 1 }, options: { name: 'zip_sha256' } },
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

// Indexes from earlier module versions that the current model replaces.
// The old text index must go first: a collection has at most one text index.
// (objectID_unique_sparse is dropped before the migration, see ensureAll.)
const OBSOLETE_ITEM_INDEXES = ['tags_title_state', 'template_gallery_text_search']

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

const AUDIT_INDEXES = [
  { keys: { itemId: 1, at: -1 }, options: { name: 'itemId_at' } },
  {
    keys: { at: 1 },
    options: { name: 'at_ttl_365d', expireAfterSeconds: 365 * 24 * 3600 },
  },
]

async function dropIndexIfExists(col, name) {
  try {
    await col.dropIndex(name)
    return true
  } catch {
    return false // absent (IndexNotFound) or collection missing
  }
}

async function createIndex(col, { keys, options }) {
  try {
    await col.createIndex(keys, options)
  } catch (err) {
    if (!INDEX_CONFLICT_CODES.has(err?.code)) throw err
    // same name or keys with other options: rebuild with the current spec
    await dropIndexIfExists(col, options.name)
    await col.createIndex(keys, options)
  }
}

async function ensureCollectionIndexes(name, getCol, specs, report, drops = []) {
  let col
  try {
    col = await getCol()
  } catch (err) {
    report.essentialOk = false
    report.failed.push({ collection: name, keys: 'collection_access', error: err.message })
    return
  }
  for (const indexName of drops) await dropIndexIfExists(col, indexName)
  for (const spec of specs) {
    try {
      await createIndex(col, spec)
    } catch (err) {
      if (spec.essential) report.essentialOk = false
      if (spec.text) report.textIndexOk = false
      report.failed.push({ collection: name, keys: spec.keys, error: err.message })
      logWarn('index_create_failed', {
        collection: name,
        index: spec.options.name,
        error: err.message,
      })
    }
  }
}

/**
 * Migrates legacy items, then creates every index the gallery uses. A failed
 * non-essential index is reported but never blocks startup.
 *
 * @returns {Promise<{ essentialOk: boolean, textIndexOk: boolean, failed: Array<{ collection: string, keys: any, error: string }>, migration: object }>}
 */
export async function ensureAll() {
  const report = { essentialOk: true, textIndexOk: true, failed: [] }

  // the old sparse objectID index must not block the migration writes
  try {
    await dropIndexIfExists(await itemsCol(), 'objectID_unique_sparse')
  } catch {}
  report.migration = await migrateItems()

  await ensureCollectionIndexes(
    'templateGalleryItems',
    itemsCol,
    ITEM_INDEXES,
    report,
    OBSOLETE_ITEM_INDEXES
  )
  await ensureCollectionIndexes('templateGalleryJobs', jobsCol, JOB_INDEXES, report)
  await ensureCollectionIndexes('templateGalleryAudit', auditCol, AUDIT_INDEXES, report)
  return report
}

export default {
  ensureAll,
}
