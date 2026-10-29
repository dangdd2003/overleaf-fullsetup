import * as cheerio from 'cheerio'
import { parseItemUrl } from '../../util/GalleryUrls.mjs'

// Parses the server-rendered gallery listings on overleaf.com (root, recent
// pages and tag pages). Every item card has the same markup wherever it
// appears; the block it sits in (Recent, Featured, Top picks) decides its role.

const S3_IMAGE_HOST = 'writelatex.s3.amazonaws.com'
const PUBLISHED_IMAGE_REGEX = /^\/published_ver\/(\d+)\.jpe?g$/i

function cleanText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Extracts the published version id and the (signed, short-lived) S3 URL of
 * an official gallery image. Returns null for anything else.
 */
export function parsePublishedImage(src) {
  if (!src) return null
  let url
  try {
    url = new URL(String(src).trim(), 'https://www.overleaf.com')
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.hostname !== S3_IMAGE_HOST) return null
  const match = PUBLISHED_IMAGE_REGEX.exec(url.pathname)
  if (!match) return null
  return { publishedId: Number(match[1]), url: url.href }
}

/**
 * Parses one `.gallery-thumbnail` item card. Category tiles (which link to a
 * tag page, not an item) yield null.
 */
export function parseCard($, element) {
  const card = $(element)
  const anchor = card.children('a').first()
  const href = anchor.attr('href') || ''
  const parsed = parseItemUrl(href)
  if (!parsed) return null

  const img = anchor.find('.thumbnail img').first()
  const image = parsePublishedImage(img.attr('src'))
  const badges = []
  anchor.find('.badge-container .badge-content').each((_, badge) => {
    const label = cleanText($(badge).text()).toLowerCase()
    if (label) badges.push(label === 'top pick' ? 'top-pick' : label)
  })

  return {
    family: parsed.family,
    slug: parsed.slug,
    token: parsed.token,
    title: cleanText(anchor.find('.caption-title').first().text()) || cleanText(img.attr('alt')),
    author: cleanText(card.find('.caption .author-name').first().text()),
    description: String(card.find('.caption .caption-description').first().text() ?? '').trim(),
    publishedId: image?.publishedId ?? null,
    imageUrl: image?.url ?? null,
    badges,
  }
}

function lastPageFromPagination($) {
  const pagination = $('ul.pagination').first()
  if (pagination.length === 0) return null
  const lastHref = pagination.find('a[aria-label="Go to last page"]').attr('href')
  const lastMatch = /\/page\/(\d+)\/?$/.exec(lastHref || '')
  if (lastMatch) return Number(lastMatch[1])
  // On the last page there is no "Last" link: the active entry is the end.
  const active = Number.parseInt(cleanText(pagination.find('li.active').text()), 10)
  return Number.isInteger(active) && active > 0 ? active : null
}

/**
 * Parses a listing page into its card blocks:
 *   recent   - the paginated grid (Recent / tag grid), in page order
 *   featured - the Featured block (root pages only)
 *   topPicks - the "Selected by Overleaf staff" banner (tag page 1 only)
 * `lastPage` comes from the pagination nav (null when there is none).
 */
export function parseListingPage(html) {
  const $ = cheerio.load(html || '')
  const recent = []
  const featured = []
  const topPicks = []
  const seen = new Set()

  $('.gallery-thumbnail').each((_, element) => {
    const card = parseCard($, element)
    if (!card) return
    const node = $(element)
    let target = recent
    let block = 'recent'
    if (node.closest('.featured-docs').length > 0) {
      target = featured
      block = 'featured'
    } else if (node.closest('.top-picks-banner').length > 0) {
      target = topPicks
      block = 'topPicks'
    }
    const key = `${block}:${card.token}`
    if (seen.has(key)) return
    seen.add(key)
    target.push(card)
  })

  return {
    recent,
    featured,
    topPicks,
    lastPage: lastPageFromPagination($),
    noResults: $('.no-articles-matching').length > 0,
  }
}

export default {
  parsePublishedImage,
  parseCard,
  parseListingPage,
}
