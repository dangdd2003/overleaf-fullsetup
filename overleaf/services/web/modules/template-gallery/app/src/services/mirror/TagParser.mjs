import * as cheerio from 'cheerio'
import { parseListingPage } from './ListingParser.mjs'

// Parses page 1 of an official tag page (/latex/<family>/tagged/<name>,
// /articles/tagged/<name>, /gallery/tagged/<name>): the h1 title, the curated
// summary, the related-tags order and the staff top picks. None of these can
// be derived from Algolia (MASTER-SPEC C8, C9, C11, C12).

// h1 is "<family copy> — <Tag title>" (em dash).
const TITLE_SEPARATOR = ' — '

function cleanText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Tag name from a `.../tagged/<name>[/page/<n>]` href, or null.
 */
export function tagNameFromHref(href) {
  let pathname
  try {
    pathname = new URL(String(href ?? ''), 'https://www.overleaf.com').pathname
  } catch {
    return null
  }
  const match = /\/tagged\/([^/]+)(?:\/page\/\d+)?\/?$/.exec(pathname)
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

/**
 * Title suffix of a tag page h1 ("LaTeX templates — CVs and résumés" ->
 * "CVs and résumés"), or null when the h1 has no tag part.
 */
export function tagTitleFromHeading(heading) {
  const text = cleanText(heading)
  const index = text.lastIndexOf(TITLE_SEPARATOR)
  if (index < 0) return null
  return text.slice(index + TITLE_SEPARATOR.length).trim() || null
}

/**
 * Parses an official tag page. `known` is false when overleaf.com served its
 * fallback copy for a tag it does not know (it then renders the
 * academic-journal header, so the active filter links to another tag).
 */
export function parseTagPage(html, name) {
  const $ = cheerio.load(html || '')
  const heading = $('h1.gallery-title').first().text()
  const title = tagTitleFromHeading(heading)

  const activeHref = $('.gallery-filters a.active').first().attr('href')
  const activeName = activeHref ? tagNameFromHref(activeHref) : null
  const known = Boolean(title) && (activeName == null || activeName === name)

  const related = []
  const seen = new Set()
  $('ul#related-tags > li > a').each((_, anchor) => {
    const relatedName = tagNameFromHref($(anchor).attr('href'))
    if (!relatedName || seen.has(relatedName)) return
    seen.add(relatedName)
    const label = cleanText($(anchor).find('.badge-content').first().text())
    related.push({ name: relatedName, title: label || relatedName })
  })

  const listing = parseListingPage(html)

  return {
    known,
    title: known ? title : null,
    summary: known ? cleanText($('p.gallery-summary').first().text()) : '',
    related: known ? related : [],
    topPicks: known ? listing.topPicks : [],
    cards: known ? listing.recent : [],
    lastPage: known ? listing.lastPage : null,
  }
}

export default {
  tagNameFromHref,
  tagTitleFromHeading,
  parseTagPage,
}
