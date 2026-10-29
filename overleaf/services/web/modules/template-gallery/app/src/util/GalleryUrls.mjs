// Single source of truth for gallery URL shapes, mirroring the official
// overleaf.com gallery routes on this instance.

export const PAGE_SIZE = 9

export const FAMILIES = Object.freeze(['template', 'example', 'article'])

// Listing scopes: the three item families plus the union gallery.
export const SCOPES = Object.freeze(['templates', 'examples', 'articles', 'gallery'])

const SCOPE_BASE = Object.freeze({
  templates: '/latex/templates',
  examples: '/latex/examples',
  articles: '/articles',
  gallery: '/gallery',
})

const FAMILY_SCOPE = Object.freeze({
  template: 'templates',
  example: 'examples',
  article: 'articles',
})

export const TOKEN_REGEX = /^[a-z]{12}$/

export function isValidToken(token) {
  return typeof token === 'string' && TOKEN_REGEX.test(token)
}

export function scopeForFamily(family) {
  return FAMILY_SCOPE[family] || 'templates'
}

export function familyForScope(scope) {
  for (const [family, s] of Object.entries(FAMILY_SCOPE)) {
    if (s === scope) return family
  }
  return null // 'gallery' spans all families
}

export function scopeBase(scope) {
  return SCOPE_BASE[scope] || SCOPE_BASE.templates
}

function seg(value) {
  return encodeURIComponent(String(value ?? ''))
}

export function itemHref(item) {
  const base = scopeBase(scopeForFamily(item?.family))
  return `${base}/${seg(item?.slug || 'template')}/${item?.token}`
}

export function itemPdfHref(item) {
  return `${itemHref(item)}.pdf`
}

export function itemOpenHref(item) {
  return `${itemHref(item)}/open`
}

export function thumbHref(item) {
  return `/gallery/_media/${item?.token}/thumb.jpg`
}

export function previewHref(item) {
  return `/gallery/_media/${item?.token}/preview.jpg`
}

export function recentHref(scope, page = 1) {
  const base = scopeBase(scope)
  return page > 1 ? `${base}/recent/page/${page}` : base
}

export function taggedHref(scope, tagName, page = 1) {
  const base = `${scopeBase(scope)}/tagged/${seg(tagName)}`
  return page > 1 ? `${base}/page/${page}` : base
}

// Rewrites an absolute overleaf.com gallery URL (Algolia hit url, abstract
// link) to the matching path on this instance. Returns null for anything that
// is not a gallery item/listing URL.
export function localizeGalleryUrl(url) {
  let parsed
  try {
    parsed = new URL(url, 'https://www.overleaf.com')
  } catch {
    return null
  }
  if (!/(^|\.)overleaf\.com$/i.test(parsed.hostname)) return null
  const match =
    /^\/(latex\/templates|latex\/examples|articles|gallery)(\/.*)?$/.exec(
      parsed.pathname
    )
  if (!match) return null
  return `${parsed.pathname}${parsed.search}${parsed.hash}`
}

export function parseItemUrl(url) {
  let pathname = url
  try {
    pathname = new URL(url, 'https://www.overleaf.com').pathname
  } catch {}
  const match =
    /^\/(latex\/templates|latex\/examples|articles)\/([^/]+)\/([a-z]{12})\/?$/.exec(
      pathname || ''
    )
  if (!match) return null
  const family =
    match[1] === 'latex/templates'
      ? 'template'
      : match[1] === 'latex/examples'
        ? 'example'
        : 'article'
  let slug = match[2]
  try {
    slug = decodeURIComponent(slug)
  } catch {}
  return { family, slug, token: match[3] }
}

export default {
  PAGE_SIZE,
  FAMILIES,
  SCOPES,
  TOKEN_REGEX,
  isValidToken,
  scopeForFamily,
  familyForScope,
  scopeBase,
  itemHref,
  itemPdfHref,
  itemOpenHref,
  thumbHref,
  previewHref,
  recentHref,
  taggedHref,
  localizeGalleryUrl,
  parseItemUrl,
}
