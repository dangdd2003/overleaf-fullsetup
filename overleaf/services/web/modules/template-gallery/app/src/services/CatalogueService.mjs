import { itemsCol } from '../persistence/Collections.mjs'
import { FAMILIES, isValidToken } from '../util/GalleryUrls.mjs'

// Listing order of the official gallery: scraped recency first, Algolia
// objectID as the tie-break for items not yet seen on a recent page.
export const RECENT_SORT = Object.freeze({ recentOrder: -1, objectIDNum: -1, _id: -1 })

// Heavy fields that list views never need.
const LIST_PROJECTION = Object.freeze({
  thumbDataUri: 0,
  mainText: 0,
  abstractHtml: 0,
})

/**
 * Escapes regex special characters to safely use user input in $regex queries.
 *
 * @param {string} str
 * @returns {string}
 */
export function escapeRegex(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function pageParams(page, pageSize, defaultSize) {
  const p = Math.max(1, Number(page) || 1)
  const ps = Math.max(1, Math.min(100, Number(pageSize) || defaultSize))
  return { p, ps, skip: (p - 1) * ps }
}

async function findPage(col, filter, sort, { p, ps, skip }, projection) {
  const [items, total] = await Promise.all([
    col.find(filter, { projection }).sort(sort).skip(skip).limit(ps).toArray(),
    col.countDocuments(filter),
  ])
  return { items, total, page: p, pageSize: ps, totalPages: Math.ceil(total / ps) || 1 }
}

/**
 * Lists items for administrative management.
 *
 * @param {object} options
 * @param {string} [options.state] - 'all' or a state value
 * @param {string | number} [options.tier] - 'all' | 1 | 2 | 3 | 4
 * @param {string} [options.family] - family filter
 * @param {string} [options.q] - token, objectID, or text in title/author/slug
 * @param {number} [options.page=1]
 * @param {number} [options.pageSize=25]
 */
export async function listAdmin({
  state = 'all',
  tier = 'all',
  family = '',
  q = '',
  page = 1,
  pageSize = 25,
} = {}) {
  const col = await itemsCol()
  const filter = {}
  if (state && state !== 'all') filter.state = state
  if (tier !== undefined && tier !== null && tier !== 'all' && tier !== '') {
    filter.acquisitionTier = Number(tier)
  }
  if (FAMILIES.includes(family)) filter.family = family

  const query = typeof q === 'string' ? q.trim() : ''
  if (isValidToken(query)) {
    filter.token = query
  } else if (/^\d+$/.test(query)) {
    filter.objectID = query
  } else if (query) {
    const regex = new RegExp(escapeRegex(query), 'i')
    filter.$or = [{ title: regex }, { author: regex }, { slug: regex }]
  }

  return findPage(
    col,
    filter,
    { updatedAt: -1, _id: -1 },
    pageParams(page, pageSize, 25),
    { ...LIST_PROJECTION, description: 0 }
  )
}

export default {
  RECENT_SORT,
  escapeRegex,
  listAdmin,
}
