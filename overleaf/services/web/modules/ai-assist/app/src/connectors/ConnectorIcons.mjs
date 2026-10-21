import { createHash } from 'node:crypto'

/**
 * MCP servers may declare icons in their initialize result (spec 2025-11-25,
 * `serverInfo.icons`). Each one is an https URL or a data:image URI. Only what
 * passes sanitizeServerIcons is saved on the connector, so the icon route
 * never fetches anything the spec did not allow, and the list payload never
 * carries a data URI. The route tries the declared icons, best first, and
 * falls back to the site's own icon when none of them loads.
 */

const MAX_ICONS = 8
const MAX_SRC_CHARS = 2048
/** Longest data URI kept, in characters (about 192 KB of image bytes). */
const MAX_DATA_CHARS = 256 * 1024
const MAX_SIZES = 8
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp|svg\+xml)[;,]/i
const MIME_TYPE = /^image\/[\w.+-]{1,60}$/i
const SIZE = /^(\d{1,4}x\d{1,4}|any)$/i
/** Declared icons tried per request, the best first. */
const MAX_TRIED = 3
/** Icon size the browser draws in a list row. */
const WANTED_PX = 32
const MAX_CACHED = 256
const FOUND_TTL_MS = 24 * 60 * 60 * 1000
const MISSING_TTL_MS = 60 * 60 * 1000
/** An icon that could not be checked (busy sidecar, timeout) is retried soon. */
const UNSURE_TTL_MS = 60 * 1000

function isHttpsUrl(raw) {
  try {
    return new URL(raw).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * The icons a server declared, checked and trimmed. Anything malformed is
 * dropped rather than failing the connection: an icon is decoration.
 */
export function sanitizeServerIcons(icons) {
  if (!Array.isArray(icons)) return []
  const kept = []
  for (const icon of icons) {
    if (kept.length >= MAX_ICONS) break
    const src = typeof icon?.src === 'string' ? icon.src.trim() : ''
    if (!src) continue
    if (src.startsWith('data:')) {
      if (src.length > MAX_DATA_CHARS || !DATA_IMAGE.test(src)) continue
    } else if (src.length > MAX_SRC_CHARS || !isHttpsUrl(src)) {
      continue
    }
    const mimeType =
      typeof icon.mimeType === 'string' && MIME_TYPE.test(icon.mimeType.trim())
        ? icon.mimeType.trim().toLowerCase()
        : undefined
    const sizes = (Array.isArray(icon.sizes) ? icon.sizes : [])
      .filter(size => typeof size === 'string' && SIZE.test(size.trim()))
      .map(size => size.trim().toLowerCase())
      .slice(0, MAX_SIZES)
    const theme =
      icon.theme === 'light' || icon.theme === 'dark' ? icon.theme : undefined
    kept.push({ src, mimeType, sizes, theme })
  }
  return kept
}

/** 0 for a vector, then PNG, then anything else. */
function formatRank(icon) {
  const type = (icon.mimeType || '').toLowerCase()
  const src = icon.src.toLowerCase()
  if (type === 'image/svg+xml' || /^data:image\/svg\+xml[;,]/.test(src)) {
    return 0
  }
  if (type === 'image/png' || /^data:image\/png[;,]/.test(src)) return 1
  if (!type && /\.svg(\?|$)/.test(src)) return 0
  if (!type && /\.png(\?|$)/.test(src)) return 1
  return 2
}

/** How far the icon's nearest declared size is from 32px; `any` is ideal. */
function sizeDistance(icon) {
  if (icon.sizes.length === 0) return Number.MAX_SAFE_INTEGER / 2
  let best = Number.MAX_SAFE_INTEGER
  for (const size of icon.sizes) {
    if (size === 'any') return 0
    const [width, height] = size.split('x').map(Number)
    best = Math.min(best, Math.abs(Math.max(width, height) - WANTED_PX))
  }
  return best
}

/**
 * The declared icon sources to try, best first: a light or unmarked icon
 * before a dark one, then the size nearest 32px, then SVG, then PNG.
 */
export function bestIconSources(icons, limit = MAX_TRIED) {
  return sanitizeServerIcons(icons)
    .map(icon => ({
      icon,
      theme: icon.theme === 'dark' ? 1 : 0,
      size: sizeDistance(icon),
      format: formatRank(icon),
    }))
    .sort(
      (a, b) =>
        a.theme - b.theme || a.size - b.size || a.format - b.format
    )
    .slice(0, limit)
    .map(({ icon }) => icon.src)
}

/** Stable key for the icons a connector declared, so a change refetches. */
export function iconCacheKey(connectorId, url, icons) {
  const digest = createHash('sha1')
    .update(JSON.stringify([url, sanitizeServerIcons(icons)]))
    .digest('hex')
  return `${connectorId}|${digest}`
}

/** An LRU of icon results: the oldest entry goes once the cache is full. */
export class IconCache {
  constructor(max = MAX_CACHED) {
    this.max = max
    this.entries = new Map()
  }

  get(key) {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    if (entry.expires <= Date.now()) return undefined
    this.entries.set(key, entry)
    return entry.value
  }

  set(key, value, ttlMs) {
    this.entries.delete(key)
    this.entries.set(key, { value, expires: Date.now() + ttlMs })
    while (this.entries.size > this.max) {
      this.entries.delete(this.entries.keys().next().value)
    }
  }
}

/** How long a result is kept: found, known missing, or not checked yet. */
export function cacheTtl(found) {
  if (found.icon) return FOUND_TTL_MS
  return found.sure ? MISSING_TTL_MS : UNSURE_TTL_MS
}

const defaultCache = new IconCache()

function originOf(url) {
  try {
    return new URL(String(url)).origin
  } catch {
    return null
  }
}

function notFound(res) {
  res.setHeader('Cache-Control', 'no-store')
  res.status(404).end()
}

/**
 * The icon route's handler. Dependencies are injectable for tests; the
 * defaults come from AiAssistFavicon.mjs, loaded on the first request so a
 * disabled instance loads no icon code.
 *
 * loadConnector(connectorId, userId) resolves { url, serverIcons } for a
 * connector the user may see, and throws (status 404) when there is none.
 */
export function createConnectorIconHandler({
  loadConnector,
  resolveOriginIcon,
  fetchIconBytes,
  sendIcon,
  cache = defaultCache,
} = {}) {
  async function favicon() {
    if (resolveOriginIcon && fetchIconBytes && sendIcon) {
      return { resolveOriginIcon, fetchIconBytes, sendIcon }
    }
    const module = await import('../AiAssistFavicon.mjs')
    return {
      resolveOriginIcon: resolveOriginIcon || module.resolveOriginIcon,
      fetchIconBytes: fetchIconBytes || module.fetchIconBytes,
      sendIcon: sendIcon || module.sendIcon,
    }
  }

  async function findIcon(connector, deps) {
    for (const src of bestIconSources(connector.serverIcons)) {
      const icon = await deps
        .fetchIconBytes(src, { allowPrivate: true })
        .catch(() => null)
      if (icon) return { icon, sure: true }
    }
    const origin = originOf(connector.url)
    if (!origin) return { icon: null, sure: true }
    return deps
      .resolveOriginIcon(new URL(connector.url).origin, {
        allowPrivate: true,
        parentFallback: true,
      })
      .catch(() => ({ icon: null, sure: false }))
  }

  return async function connectorIcon(req, res, next) {
    let connector
    try {
      connector = await loadConnector(req.params.connectorId, req.user._id)
    } catch (err) {
      // An id that is not an ObjectId cannot name a connector either
      if (err?.status === 404 || err?.name === 'CastError') {
        return notFound(res)
      }
      return next(err)
    }
    if (!connector) return notFound(res)

    try {
      const deps = await favicon()
      const key = iconCacheKey(
        String(req.params.connectorId),
        connector.url,
        connector.serverIcons
      )
      let found = cache.get(key)
      if (!found) {
        found = await findIcon(connector, deps)
        cache.set(key, found, cacheTtl(found))
      }
      return deps.sendIcon(res, found)
    } catch (err) {
      return next(err)
    }
  }
}
