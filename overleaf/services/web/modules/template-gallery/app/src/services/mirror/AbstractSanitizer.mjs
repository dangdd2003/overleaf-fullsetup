import * as cheerio from 'cheerio'
import { localizeGalleryUrl } from '../../util/GalleryUrls.mjs'

// Abstracts on overleaf.com are author-supplied HTML. We re-serialise them
// from the parsed tree through a strict allow-list instead of trusting any
// markup verbatim.

const OVERLEAF_ORIGIN = 'https://www.overleaf.com'

const ALLOWED_TAGS = new Set([
  'a',
  'abbr',
  'b',
  'blockquote',
  'br',
  'code',
  'dd',
  'del',
  'div',
  'dl',
  'dt',
  'em',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'ins',
  'kbd',
  'li',
  'ol',
  'p',
  'pre',
  's',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
])

// Dropped together with everything inside them.
const DROPPED_TAGS = new Set([
  'applet',
  'audio',
  'base',
  'button',
  'canvas',
  'embed',
  'form',
  'frame',
  'frameset',
  'head',
  'iframe',
  'img',
  'input',
  'link',
  'math',
  'meta',
  'noscript',
  'object',
  'option',
  'picture',
  'script',
  'select',
  'source',
  'style',
  'svg',
  'template',
  'textarea',
  'title',
  'video',
])

const VOID_TAGS = new Set(['br', 'hr'])

const ALLOWED_ATTRIBUTES = {
  a: ['href', 'title'],
  abbr: ['title'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan', 'scope'],
  ol: ['start'],
}

const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

function escapeText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeAttribute(value) {
  return escapeText(value).replace(/"/g, '&quot;')
}

/**
 * Resolves an abstract link: gallery URLs on overleaf.com become local paths,
 * other http(s)/mailto URLs stay absolute, anything else is rejected (null).
 */
export function resolveAbstractHref(href) {
  const raw = String(href ?? '').trim()
  if (!raw) return null
  let url
  try {
    url = new URL(raw, OVERLEAF_ORIGIN)
  } catch {
    return null
  }
  if (!SAFE_LINK_PROTOCOLS.has(url.protocol)) return null
  if (url.username || url.password) return null
  const local = localizeGalleryUrl(url.href)
  if (local) return { href: local, external: false }
  return { href: url.href, external: true }
}

function renderAttributes(tagName, attribs) {
  const allowed = ALLOWED_ATTRIBUTES[tagName] || []
  const out = []
  for (const name of allowed) {
    const value = attribs?.[name]
    if (value == null) continue
    if (name === 'href') {
      const resolved = resolveAbstractHref(value)
      if (!resolved) continue
      out.push(`href="${escapeAttribute(resolved.href)}"`)
      if (resolved.external) out.push('rel="nofollow noopener"')
      continue
    }
    if (['colspan', 'rowspan', 'start'].includes(name)) {
      const n = Number.parseInt(value, 10)
      if (Number.isInteger(n) && n > 0 && n < 1000) out.push(`${name}="${n}"`)
      continue
    }
    out.push(`${name}="${escapeAttribute(value)}"`)
  }
  return out.length > 0 ? ` ${out.join(' ')}` : ''
}

function renderNodes(nodes) {
  let html = ''
  for (const node of nodes || []) {
    if (node.type === 'text') {
      html += escapeText(node.data)
      continue
    }
    if (node.type !== 'tag') continue // comments, scripts, styles, cdata, directives

    const tagName = String(node.name || '').toLowerCase()
    if (DROPPED_TAGS.has(tagName)) continue
    if (!ALLOWED_TAGS.has(tagName)) {
      // Unknown wrappers are unwrapped so their text survives.
      html += renderNodes(node.children)
      continue
    }
    if (tagName === 'a' && !resolveAbstractHref(node.attribs?.href)) {
      html += renderNodes(node.children)
      continue
    }
    const attributes = renderAttributes(tagName, node.attribs)
    if (VOID_TAGS.has(tagName)) {
      html += `<${tagName}${attributes}>`
      continue
    }
    html += `<${tagName}${attributes}>${renderNodes(node.children)}</${tagName}>`
  }
  return html
}

/**
 * Returns sanitised abstract HTML, or '' when nothing displayable remains.
 */
export function sanitizeAbstractHtml(html) {
  if (!html || typeof html !== 'string') return ''
  const $ = cheerio.load(html, null, false)
  const rendered = renderNodes($.root()[0]?.children).trim()
  // Text is escaped, so stripping tags leaves only the visible text.
  if (!rendered.replace(/<[^>]*>/g, '').trim()) return ''
  return rendered
}

export default {
  sanitizeAbstractHtml,
  resolveAbstractHref,
}
