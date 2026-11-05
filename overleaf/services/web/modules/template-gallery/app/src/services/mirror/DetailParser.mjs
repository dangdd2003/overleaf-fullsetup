import crypto from 'node:crypto'
import * as cheerio from 'cheerio'
import { parsePublishedImage } from './ListingParser.mjs'
import { tagNameFromHref } from './TagParser.mjs'
import { sanitizeAbstractHtml } from './AbstractSanitizer.mjs'

// Parses an official item detail page (/latex/templates/<slug>/<token>,
// /latex/examples/..., /articles/...) per MASTER-SPEC 4.7 / 7.3.

const OPEN_TEMPLATE_PATH = /^\/project\/new\/template\/(\d+)\/?$/

function cleanText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

function positiveInt(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

function nonEmpty(value) {
  const text = String(value ?? '').trim()
  return text || null
}

/**
 * Parameters of the official "Open as Template" link
 * (/project/new/template/<publishedId>?[brandVariationId=]&id=&[latexEngine=]&mainFile=&templateName=&texImage=).
 */
export function parseOpenTemplateHref(href) {
  if (!href) return null
  let url
  try {
    url = new URL(String(href), 'https://www.overleaf.com')
  } catch {
    return null
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'www.overleaf.com' ||
    url.port ||
    url.username ||
    url.password
  )
    return null
  const match = OPEN_TEMPLATE_PATH.exec(url.pathname)
  if (!match) return null
  const params = url.searchParams
  return {
    publishedId: positiveInt(match[1]),
    objectID: nonEmpty(params.get('id')),
    brandVariationId: positiveInt(params.get('brandVariationId')),
    templateName: nonEmpty(params.get('templateName')),
    mainFile: nonEmpty(params.get('mainFile')),
    latexEngine: nonEmpty(params.get('latexEngine')),
    texImage: nonEmpty(params.get('texImage')),
  }
}

// `.template-detail` rows: <div><b>Label:</b></div><div>value</div>.
function detailRows($) {
  const rows = new Map()
  $('.template-detail').each((_, row) => {
    const label = cleanText($(row).find('b, strong').first().text())
      .replace(/:$/, '')
      .toLowerCase()
    if (label && !rows.has(label))
      rows.set(label, $(row).children('div').last())
  })
  // Definition lists and tables carry the same labels without depending on
  // the presentation classes used by one version of the gallery.
  $('.template-details-container dt, main dt, article dt').each((_, row) => {
    const label = cleanText($(row).text()).replace(/:$/, '').toLowerCase()
    const value = $(row).next('dd')
    if (label && value.length && !rows.has(label)) rows.set(label, value)
  })
  return rows
}

/**
 * Stable digest of the parsed fields; changes when the item is republished
 * or edited upstream (the page itself embeds per-request tokens, so neither
 * ETag nor a raw HTML hash is usable).
 */
export function computeDetailHash(detail) {
  const stable = {
    title: detail.title,
    author: detail.author,
    official: detail.official,
    lastUpdatedAt: detail.lastUpdatedAt ? detail.lastUpdatedAt.getTime() : null,
    licenseLabel: detail.licenseLabel,
    abstractHtml: detail.abstractHtml,
    tags: detail.tags,
    cta: detail.cta,
    mainText: detail.mainText,
  }
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stable))
    .digest('hex')
}

/**
 * Parses an official detail page. Returns null when the page does not look
 * like a gallery item (layout change, interstitial, error page).
 */
export function parseDetailPage(html, { throwOnError = false } = {}) {
  const $ = cheerio.load(html || '')
  const titleBlock = $('.gallery-item-title').first()
  const title =
    cleanText(titleBlock.find('h1').first().text()) ||
    cleanText($('main h1, article h1, h1').first().text()) ||
    cleanText(
      $('meta[name="og:title"], meta[property="og:title"]')
        .first()
        .attr('content')
    )
  let cta = null
  // Skip malformed/foreign links instead of letting the first match hide a
  // valid CTA. Some layouts submit the same URL through a GET form.
  $(
    'a[href*="/project/new/template/"], form[action*="/project/new/template/"]'
  ).each((_, el) => {
    if (cta) return
    const node = $(el)
    let href = node.attr('href') || node.attr('action')
    if (el.tagName === 'form') {
      if ((node.attr('method') || 'get').toLowerCase() !== 'get') return
      try {
        const url = new URL(href, 'https://www.overleaf.com')
        node.find('input[name]').each((_, input) => {
          const field = $(input)
          if (!field.is('[disabled]'))
            url.searchParams.set(field.attr('name'), field.attr('value') || '')
        })
        href = url.href
      } catch {
        return
      }
    }
    const parsed = parseOpenTemplateHref(href)
    if (parsed?.publishedId) cta = parsed
  })
  if (!title || !cta?.publishedId) {
    if (!throwOnError) return null
    const missing = [
      !title && 'template title',
      !cta?.publishedId && 'valid Open as Template link',
    ].filter(Boolean)
    const err = new Error(
      `Template refresh could not find ${missing.join(' and ')} in the upstream page. Cached template content was kept.`
    )
    err.code = 'detail_unparseable'
    throw err
  }

  const rows = detailRows($)

  let lastUpdatedAt = null
  const timestamp = positiveInt(
    $('[data-timestamp-for-title]').first().attr('data-timestamp-for-title')
  )
  if (timestamp) lastUpdatedAt = new Date(timestamp * 1000) // unix seconds

  const tags = []
  const seenTags = new Set()
  const tagRow = rows.get('tags') || $('.template-detail.tags')
  tagRow.find('a[href*="/tagged/"]').each((_, anchor) => {
    const name = tagNameFromHref($(anchor).attr('href'))
    if (!name || seenTags.has(name)) return
    seenTags.add(name)
    const label = $(anchor).find('.badge-content').first()
    const tagTitle = cleanText(label.attr('data-bs-title') || label.text())
    tags.push({ name, title: tagTitle || name })
  })

  const previewImage =
    parsePublishedImage(
      $('.gallery-large-pdf-preview img').first().attr('src')
    ) ||
    parsePublishedImage($('meta[itemprop="image"]').first().attr('content'))
  const codeBlock = $(
    '#modalViewSource pre code, #modalViewSource pre, #modalViewSource textarea'
  ).first()
  const mainText = codeBlock.length > 0 ? codeBlock.text() : null

  const detail = {
    title,
    official:
      titleBlock.find('.gallery-item-title-badge-container .badge-content')
        .length > 0,
    author: cleanText(rows.get('author')?.text()) || null,
    lastUpdatedAt,
    licenseLabel: cleanText(rows.get('license')?.text()) || null,
    abstractHtml:
      sanitizeAbstractHtml($('.gallery-abstract').first().html() || '') || null,
    tags,
    cta,
    mainText: mainText && mainText.trim() ? mainText : null,
    preview: previewImage, // { publishedId, url } (signed for 4 h) or null
    pdfHref:
      $('.cta-links a[href$=".pdf"]').first().attr('href') ||
      $('a.cta-link[href$=".pdf"]').first().attr('href') ||
      null,
  }
  detail.detailHash = computeDetailHash(detail)
  return detail
}

export default {
  parseOpenTemplateHref,
  computeDetailHash,
  parseDetailPage,
}
