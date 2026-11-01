// Local gallery search over the mirrored catalogue. Mirrors the official
// Algolia query the overleaf.com gallery widget sends (hitsPerPage 10,
// attributesToSnippet ["description:64"], 1000-hit pagination limit) using the
// Mongo `tg_text` index instead of Algolia.

import { itemsCol } from '../persistence/Collections.mjs'
import GalleryUrls from '../util/GalleryUrls.mjs'
import { logWarn } from '../observability/Log.mjs'

export const DEFAULT_HITS_PER_PAGE = 10
export const MAX_HITS_PER_PAGE = 50
export const MAX_QUERY_CHARS = 100
// Algolia `paginationLimitedTo`: hits beyond this rank are never served.
export const MAX_RESULTS = 1000
export const SNIPPET_WORDS = 64

const MAX_TERMS = 10
const SNIPPET_ELLIPSIS = '…'
const WORD_REGEX = /[\p{L}\p{M}\p{N}]+/gu
const MONGO_INDEX_NOT_FOUND = 27
// Upper bound for the unindexed regex fallback, which scans every item.
const FALLBACK_MAX_TIME_MS = 2_000

const PROJECTION = {
  token: 1,
  family: 1,
  slug: 1,
  title: 1,
  author: 1,
  description: 1,
  official: 1,
  tags: 1,
}

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => HTML_ESCAPES[char])
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Case and diacritic folding, matching the Mongo v3 text index behaviour.
function fold(value) {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

/**
 * Splits a raw query into folded, de-duplicated search terms. Terms are pure
 * letter/digit runs, so they can be quoted safely in a `$text` search and
 * never carry Mongo text operators (negation, phrases).
 */
export function parseQueryTerms(rawQuery) {
  const query = String(rawQuery ?? '').slice(0, MAX_QUERY_CHARS)
  const terms = []
  for (const [word] of query.matchAll(WORD_REGEX)) {
    const term = fold(word)
    if (term && !terms.includes(term)) terms.push(term)
    if (terms.length >= MAX_TERMS) break
  }
  return terms
}

function tokenize(text) {
  const words = []
  for (const match of text.matchAll(WORD_REGEX)) {
    words.push({
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      folded: fold(match[0]),
    })
  }
  return words
}

// Length (in original chars) of the shortest prefix of `word` whose folded
// form covers `foldedLength` chars. Handles decomposed accents.
function originalPrefixLength(word, foldedLength) {
  for (let i = 1; i <= word.length; i++) {
    if (fold(word.slice(0, i)).length >= foldedLength) return i
  }
  return word.length
}

// Number of leading chars of `word` to highlight, 0 when it does not match.
// Like Algolia's default `queryType: prefixLast`, only the last query term
// also matches as a word prefix.
function highlightLength(word, terms) {
  if (terms.includes(word.folded)) return word.text.length
  const last = terms[terms.length - 1]
  if (last && word.folded.startsWith(last)) {
    return originalPrefixLength(word.text, last.length)
  }
  return 0
}

function chooseWindowStart(matchIndexes, wordCount, size) {
  if (matchIndexes.length === 0) return 0
  const countFrom = start =>
    matchIndexes.filter(i => i >= start && i < start + size).length

  let bestCount = 0
  let bestFirst = 0
  for (const index of matchIndexes) {
    const count = countFrom(index)
    if (count > bestCount) {
      bestCount = count
      bestFirst = index
    }
  }
  if (countFrom(0) >= bestCount) return 0
  // Keep one word of leading context and fill the window up to the text end.
  return Math.max(0, Math.min(bestFirst - 1, wordCount - size))
}

/**
 * Builds the `description:64` snippet: a window of at most 64 words, chosen
 * to cover the most query matches, HTML-escaped, with matches wrapped in
 * <strong>, and an ellipsis on each truncated side.
 */
export function buildSnippetHtml(text, terms, size = SNIPPET_WORDS) {
  const source = String(text ?? '')
  const words = tokenize(source)
  if (words.length === 0) return escapeHtml(source)

  const highlights = words.map(word => highlightLength(word, terms))
  const matchIndexes = []
  highlights.forEach((length, index) => {
    if (length > 0) matchIndexes.push(index)
  })

  const first = chooseWindowStart(matchIndexes, words.length, size)
  const last = Math.min(words.length, first + size) - 1
  const truncatedStart = first > 0
  const truncatedEnd = last < words.length - 1

  let cursor = truncatedStart ? words[first].start : 0
  let html = truncatedStart ? `${SNIPPET_ELLIPSIS} ` : ''
  for (let i = first; i <= last; i++) {
    const word = words[i]
    html += escapeHtml(source.slice(cursor, word.start))
    const length = highlights[i]
    if (length > 0) {
      html += `<strong>${escapeHtml(word.text.slice(0, length))}</strong>`
      html += escapeHtml(word.text.slice(length))
    } else {
      html += escapeHtml(word.text)
    }
    cursor = word.end
  }
  if (truncatedEnd) {
    html += ` ${SNIPPET_ELLIPSIS}`
  } else {
    html += escapeHtml(source.slice(cursor))
  }
  return html
}

function clampInt(value, { min, max, fallback }) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function baseFilter() {
  return {
    state: 'published',
    token: { $type: 'string' },
    family: { $in: GalleryUrls.FAMILIES },
    'mirror.removedAt': null,
  }
}

function textFilter(terms) {
  // Quoting every term makes Mongo AND them (Algolia matches all words).
  const search = terms.map(term => `"${term}"`).join(' ')
  return { ...baseFilter(), $text: { $search: search } }
}

// Used only when the `tg_text` index is missing: every term must appear in
// one of the searchable fields.
function regexFilter(terms) {
  return {
    ...baseFilter(),
    $and: terms.map(term => {
      const regex = new RegExp(escapeRegex(term), 'i')
      return {
        $or: [
          { title: regex },
          { 'tags.title': regex },
          { author: regex },
          { description: regex },
        ],
      }
    }),
  }
}

function isMissingTextIndex(err) {
  return (
    err?.code === MONGO_INDEX_NOT_FOUND ||
    /text index required/i.test(String(err?.message || ''))
  )
}

// `bounded` is for the unindexed regex fallback: the time budget applies to the
// page and the count, and the count stops at MAX_RESULTS matches.
async function findPage(
  col,
  filter,
  sort,
  projection,
  skip,
  limit,
  bounded = false
) {
  const timing = bounded ? { maxTimeMS: FALLBACK_MAX_TIME_MS } : {}
  const [docs, nbHits] = await Promise.all([
    limit > 0
      ? col
          .find(filter, { projection, ...timing })
          .sort(sort)
          .skip(skip)
          .limit(limit)
          .toArray()
      : [],
    col.countDocuments(
      filter,
      bounded ? { limit: MAX_RESULTS, ...timing } : {}
    ),
  ])
  return { docs, nbHits }
}

async function runQuery(col, terms, skip, limit) {
  try {
    return await findPage(
      col,
      textFilter(terms),
      { score: { $meta: 'textScore' }, recentOrder: -1, objectIDNum: -1 },
      { ...PROJECTION, score: { $meta: 'textScore' } },
      skip,
      limit
    )
  } catch (err) {
    if (!isMissingTextIndex(err)) throw err
    logWarn('search text index missing, using regex fallback', {
      err: err.message,
    })
  }
  return await findPage(
    col,
    regexFilter(terms),
    { recentOrder: -1, objectIDNum: -1 },
    PROJECTION,
    skip,
    limit,
    true
  )
}

export function formatHit(item, terms) {
  const tags = Array.isArray(item.tags) ? item.tags : []
  return {
    token: item.token,
    family: item.family,
    href: GalleryUrls.itemHref(item),
    title: item.title || '',
    author: item.author || '',
    snippetHtml: buildSnippetHtml(item.description || '', terms),
    official: item.official === true,
    tags: tags
      .filter(tag => tag && typeof tag.name === 'string' && tag.name)
      .map(tag => ({
        name: tag.name,
        title: tag.title || tag.name,
        href: GalleryUrls.taggedHref('gallery', tag.name),
      })),
    thumbUrl: GalleryUrls.thumbHref(item),
  }
}

/**
 * Searches published gallery items.
 *
 * @param {object} params
 * @param {string} params.q - free text query (capped to 100 chars)
 * @param {number} [params.page] - 0-based page
 * @param {number} [params.hitsPerPage] - 1..50, default 10
 * @returns {Promise<{ hits: Array<object>, nbHits: number, page: number, nbPages: number, hitsPerPage: number, query: string }>}
 */
export async function search({ q, page, hitsPerPage } = {}) {
  const query = String(q ?? '')
    .trim()
    .slice(0, MAX_QUERY_CHARS)
  const perPage = clampInt(hitsPerPage, {
    min: 1,
    max: MAX_HITS_PER_PAGE,
    fallback: DEFAULT_HITS_PER_PAGE,
  })
  // Any page at or past MAX_RESULTS is out of the pagination limit anyway.
  const pageIndex = clampInt(page, { min: 0, max: MAX_RESULTS, fallback: 0 })
  const terms = parseQueryTerms(query)
  if (terms.length === 0) {
    return {
      hits: [],
      nbHits: 0,
      page: pageIndex,
      nbPages: 0,
      hitsPerPage: perPage,
      query,
    }
  }

  const skip = pageIndex * perPage
  // Beyond the pagination limit the total is still reported, with no hits.
  const limit = Math.max(0, Math.min(perPage, MAX_RESULTS - skip))
  const col = await itemsCol()
  const { docs, nbHits } = await runQuery(col, terms, skip, limit)

  return {
    hits: docs.map(item => formatHit(item, terms)),
    nbHits,
    page: pageIndex,
    nbPages: Math.ceil(Math.min(nbHits, MAX_RESULTS) / perPage),
    hitsPerPage: perPage,
    query,
  }
}

export default {
  search,
  formatHit,
  buildSnippetHtml,
  parseQueryTerms,
  escapeHtml,
  DEFAULT_HITS_PER_PAGE,
  MAX_HITS_PER_PAGE,
  MAX_QUERY_CHARS,
  MAX_RESULTS,
}
