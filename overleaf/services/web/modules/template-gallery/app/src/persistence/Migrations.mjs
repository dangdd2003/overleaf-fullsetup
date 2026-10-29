import crypto from 'node:crypto'
import { crawlerStateCol, itemsCol } from './Collections.mjs'
import { FAMILIES, parseItemUrl } from '../util/GalleryUrls.mjs'
import { logInfo, logWarn } from '../observability/Log.mjs'

// Brings items written by earlier module versions onto the token-keyed data
// model before the unique token index is built. Idempotent and cheap when
// there is nothing to do.

const TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz'
const BULK_CHUNK = 500

/**
 * Random 12-letter [a-z] token, the same shape as overleaf.com item tokens.
 */
export function generateToken() {
  const bytes = crypto.randomBytes(12)
  let token = ''
  for (const byte of bytes) token += TOKEN_ALPHABET[byte % 26]
  return token
}

function familyFromLegacyType(type) {
  return FAMILIES.includes(type) ? type : 'template'
}

/**
 * Computes the $set needed to migrate one legacy item doc, or null.
 */
export function legacyItemPatch(doc, newToken = generateToken) {
  const $set = {}
  const fromUrl = typeof doc.url === 'string' ? parseItemUrl(doc.url) : null

  if (typeof doc.token !== 'string' || !/^[a-z]{12}$/.test(doc.token)) {
    if (fromUrl) {
      $set.token = fromUrl.token
      if (!doc.slug) $set.slug = fromUrl.slug
    } else {
      $set.token = newToken()
    }
  }
  if (!FAMILIES.includes(doc.family)) {
    $set.family = fromUrl?.family || familyFromLegacyType(doc.type)
  }
  const crawled = typeof doc.objectID === 'string' && doc.objectID !== ''
  if (crawled && doc.objectIDNum == null) {
    const num = Number(doc.objectID)
    if (Number.isSafeInteger(num)) $set.objectIDNum = num
  }
  if (!doc.source) {
    $set.source = crawled ? 'crawler' : 'upload'
  }
  return Object.keys($set).length > 0 ? $set : null
}

async function flush(col, ops) {
  if (ops.length === 0) return 0
  const res = await col.bulkWrite(ops.splice(0, ops.length), { ordered: false })
  return res?.modifiedCount || 0
}

async function backfillItems(col) {
  const cursor = col.find(
    {
      $or: [
        { token: { $not: { $type: 'string' } } },
        { family: { $nin: FAMILIES } },
        { source: { $exists: false } },
        { objectID: { $type: 'string' }, objectIDNum: { $exists: false } },
      ],
    },
    {
      projection: {
        token: 1,
        url: 1,
        slug: 1,
        type: 1,
        family: 1,
        objectID: 1,
        objectIDNum: 1,
        source: 1,
      },
    }
  )
  const ops = []
  let modified = 0
  for await (const doc of cursor) {
    const $set = legacyItemPatch(doc)
    if (!$set) continue
    ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set } } })
    if (ops.length >= BULK_CHUNK) modified += await flush(col, ops)
  }
  modified += await flush(col, ops)
  return modified
}

// Any duplicate token keeps the crawled (or oldest) doc; the others get a
// fresh random token so the unique index can be built.
async function dedupeTokens(col) {
  const duplicates = await col
    .aggregate([
      { $match: { token: { $type: 'string' } } },
      {
        $group: {
          _id: '$token',
          ids: { $push: { _id: '$_id', objectID: '$objectID' } },
          n: { $sum: 1 },
        },
      },
      { $match: { n: { $gt: 1 } } },
    ])
    .toArray()
  let reassigned = 0
  for (const group of duplicates) {
    const [, ...extras] = [...group.ids].sort(
      (a, b) =>
        Number(typeof b.objectID === 'string') -
          Number(typeof a.objectID === 'string') ||
        String(a._id).localeCompare(String(b._id))
    )
    for (const extra of extras) {
      await col.updateOne(
        { _id: extra._id },
        { $set: { token: generateToken() } }
      )
      reassigned++
    }
  }
  if (reassigned > 0) {
    logWarn('migration_duplicate_tokens_reassigned', { reassigned })
  }
  return reassigned
}

/**
 * Runs all item migrations. Never throws; returns what it changed.
 */
export async function migrateItems() {
  const result = { backfilled: 0, dedupedTokens: 0, error: null }
  try {
    const col = await itemsCol()
    result.backfilled = await backfillItems(col)
    result.dedupedTokens = await dedupeTokens(col)
    // the partition plan of the pre-mirror crawler is obsolete
    const state = await crawlerStateCol()
    await state.deleteOne({ _id: 'crawler_state' })
    if (result.backfilled || result.dedupedTokens) {
      logInfo('migration_items_done', result)
    }
  } catch (err) {
    result.error = err.message
    logWarn('migration_items_failed', { error: err.message })
  }
  return result
}

export default {
  generateToken,
  legacyItemPatch,
  migrateItems,
}
