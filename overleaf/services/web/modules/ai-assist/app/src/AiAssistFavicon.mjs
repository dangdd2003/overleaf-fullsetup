import { fetchPublicUrl } from './AiAssistWebTools.mjs'

/**
 * Site icons for the web result rows. The browser cannot find most of them on
 * its own: many sites keep the icon on a CDN and name it only in the home
 * page's <link rel="icon">, so /favicon.ico answers 404. The server reads the
 * home page, tries the icons it declares, then /favicon.ico, and hands the
 * browser the image from Overleaf's own origin. The fetch goes through the
 * same public-address guard as web_fetch, and no third-party icon service
 * learns what the agent looked up.
 */

const PAGE_BYTES = 512 * 1024
const ICON_BYTES = 256 * 1024
const TIMEOUT_MS = 8000
const MAX_CANDIDATES = 4
const MAX_CACHED = 512
const FOUND_TTL_MS = 24 * 60 * 60 * 1000
const MISSING_TTL_MS = 60 * 60 * 1000

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,image/avif,image/webp,image/*;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
}

/** The http(s) origin of a URL, or null. */
export function normalizeOrigin(raw) {
  try {
    const parsed = new URL(String(raw))
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.origin
  } catch {
    return null
  }
}

/**
 * The image type read from the bytes themselves. Servers often label an icon
 * wrongly, and an HTML error page served as favicon.ico must not pass.
 */
export function sniffImageType(body) {
  if (!body || body.length < 4) return null
  const ascii = (from, to) => body.subarray(from, to).toString('latin1')
  if (body[0] === 0 && body[1] === 0 && (body[2] === 1 || body[2] === 2) && body[3] === 0) {
    return 'image/x-icon'
  }
  if (ascii(0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png'
  if (ascii(0, 4) === 'GIF8') return 'image/gif'
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image/jpeg'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  if (ascii(4, 12) === 'ftypavif') return 'image/avif'
  const head = body.subarray(0, 2048).toString('utf8').trimStart()
  if (head.startsWith('<') && /<svg\b/i.test(head) && !/<html\b/i.test(head)) {
    return 'image/svg+xml'
  }
  return null
}

function attribute(tag, name) {
  const match = new RegExp(
    `\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    'i'
  ).exec(tag)
  if (!match) return undefined
  return (match[1] ?? match[2] ?? match[3]).replace(/&amp;/g, '&').trim()
}

/**
 * The icons a page declares, best first: rel="icon" before apple-touch-icon,
 * and among those the size nearest the 32px a row needs.
 */
export function iconLinksIn(html, baseUrl) {
  const icons = []
  for (const [tag] of String(html).matchAll(/<link\b[^>]*>/gi)) {
    const rel = (attribute(tag, 'rel') || '').toLowerCase().split(/\s+/)
    const rank = rel.includes('icon')
      ? 0
      : rel.some(token => token.startsWith('apple-touch-icon'))
        ? 1
        : -1
    const href = attribute(tag, 'href')
    if (rank < 0 || !href) continue
    let url
    try {
      url = new URL(href, baseUrl)
    } catch {
      continue
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
    const size = parseInt(/(\d+)x\d+/i.exec(attribute(tag, 'sizes') || '')?.[1], 10)
    icons.push({ url: url.toString(), rank, fit: size ? Math.abs(size - 32) : 16 })
  }
  return icons
    .sort((a, b) => a.rank - b.rank || a.fit - b.fit)
    .map(icon => icon.url)
}

export class FaviconResolver {
  constructor({ fetch = fetchPublicUrl, now = Date.now } = {}) {
    this.fetch = fetch
    this.now = now
    this.cache = new Map()
    this.pending = new Map()
  }

  /** The origin's icon as { type, body }, or null when it has none. */
  async get(origin) {
    const cached = this.cache.get(origin)
    if (cached && cached.expires > this.now()) return cached.icon
    // A search lists several pages of one site at once: one lookup serves all.
    let pending = this.pending.get(origin)
    if (!pending) {
      pending = this._resolve(origin).finally(() => this.pending.delete(origin))
      this.pending.set(origin, pending)
    }
    const icon = await pending
    this.cache.delete(origin)
    this.cache.set(origin, {
      icon,
      expires: this.now() + (icon ? FOUND_TTL_MS : MISSING_TTL_MS),
    })
    if (this.cache.size > MAX_CACHED) {
      this.cache.delete(this.cache.keys().next().value)
    }
    return icon
  }

  async _resolve(origin) {
    let declared = []
    try {
      const page = await this.fetch(`${origin}/`, {
        maxBytes: PAGE_BYTES,
        timeoutMs: TIMEOUT_MS,
        headers: HEADERS,
      })
      declared = iconLinksIn(page.body.toString('utf8'), page.url)
    } catch {}
    const candidates = [...new Set([...declared, `${origin}/favicon.ico`])]
    for (const url of candidates.slice(0, MAX_CANDIDATES)) {
      try {
        const res = await this.fetch(url, {
          maxBytes: ICON_BYTES,
          timeoutMs: TIMEOUT_MS,
          headers: HEADERS,
        })
        const type = res.truncated ? null : sniffImageType(res.body)
        if (type) return { type, body: res.body }
      } catch {}
    }
    return null
  }
}

const resolver = new FaviconResolver()

export default {
  /** GET /ai-assist/favicon?origin=https://example.com */
  async serve(req, res) {
    const origin = normalizeOrigin(req.query?.origin)
    if (!origin) return res.sendStatus(400)
    let icon = null
    try {
      icon = await resolver.get(origin)
    } catch {}
    // An SVG opened directly must not run as a page on Overleaf's origin.
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    })
    if (!icon) {
      res.set('Cache-Control', 'private, max-age=3600')
      return res.sendStatus(404)
    }
    res.set({ 'Content-Type': icon.type, 'Cache-Control': 'private, max-age=86400' })
    res.send(icon.body)
  },
}
