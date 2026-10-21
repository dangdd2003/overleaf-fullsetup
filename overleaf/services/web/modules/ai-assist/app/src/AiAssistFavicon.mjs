import { isIP } from 'node:net'
import { sharedBrowserRoute } from './web-fetch/routes/browser.mjs'
import { fetchPublicUrl } from './web-fetch/transport.mjs'
import { connectorFetch as defaultConnectorFetch } from './connectors/ConnectorFetch.mjs'

/**
 * Site icons for the web result rows. The browser cannot find most of them on
 * its own: many sites keep the icon on a CDN and name it only in the home
 * page's <link rel="icon">, so /favicon.ico answers 404. The server asks for
 * /favicon.ico and the home page's head at once, then for the icons the page
 * declares and, when /favicon.ico is missing, the usual other paths, all
 * together; it keeps the first real image, drops the rest, and hands the
 * browser the image from Overleaf's own origin. The fetch goes
 * the way web_fetch's does (through the browser sidecar when it is
 * configured, else through the same public-address guard), and no
 * third-party icon service learns what the agent looked up.
 */

const PAGE_BYTES = 512 * 1024
const ICON_BYTES = 256 * 1024
const TIMEOUT_MS = 6000
/** Declared icons tried, best first, besides /favicon.ico. */
const MAX_DECLARED = 3
/** Where sites keep an icon they do not declare, when /favicon.ico is not one. */
const COMMON_PATHS = ['/favicon.svg', '/apple-touch-icon.png', '/favicon.png']
const MAX_CACHED = 512
const FOUND_TTL_MS = 24 * 60 * 60 * 1000
const MISSING_TTL_MS = 60 * 60 * 1000
/** A site whose icon could not be checked (busy sidecar, timeout) is retried. */
const UNSURE_TTL_MS = 60 * 1000

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,image/avif,image/webp,image/*;q=0.9,*/*;q=0.8',
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
  if (
    body[0] === 0 &&
    body[1] === 0 &&
    (body[2] === 1 || body[2] === 2) &&
    body[3] === 0
  ) {
    return 'image/x-icon'
  }
  if (ascii(0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png'
  if (ascii(0, 4) === 'GIF8') return 'image/gif'
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff)
    return 'image/jpeg'
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
    const size = parseInt(
      /(\d+)x\d+/i.exec(attribute(tag, 'sizes') || '')?.[1],
      10
    )
    icons.push({
      url: url.toString(),
      rank,
      fit: size ? Math.abs(size - 32) : 16,
    })
  }
  return icons
    .sort((a, b) => a.rank - b.rank || a.fit - b.fit)
    .map(icon => icon.url)
}

/**
 * Reads a stream up to maxBytes and stops there, so a large file is cut off
 * rather than buffered whole. Leaving the loop destroys the stream.
 */
async function readCapped(stream, maxBytes) {
  const chunks = []
  let size = 0
  let truncated = false
  for await (const chunk of stream) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    if (size + bytes.length > maxBytes) {
      chunks.push(bytes.subarray(0, maxBytes - size))
      size = maxBytes
      truncated = true
      break
    }
    chunks.push(bytes)
    size += bytes.length
  }
  return { body: Buffer.concat(chunks, size), truncated }
}

/** A refusal for the address itself, not a network or HTTP failure. */
function isBlockedAddress(err) {
  return (
    err?.code === 'EADDRBLOCKED' ||
    err?.message?.includes('blocked') ||
    err?.message?.includes('private') ||
    err?.message?.includes('not a public address')
  )
}

/**
 * The connector's answer for a private address the admin named, or null.
 * The connector refuses every other private host itself.
 */
async function viaConnector(
  url,
  { headers, timeoutMs, signal, maxBytes = ICON_BYTES },
  connectorFetch
) {
  const res = await connectorFetch(url, {
    method: 'GET',
    headers,
    timeoutMs,
    signal,
  })
  if (!res || res.status < 200 || res.status >= 400 || !res.body) return null
  const { body, truncated } = await readCapped(res.body, maxBytes)
  const contentType = res.headers?.get?.('content-type') || ''
  return { body, url: res.url || url, contentType, truncated }
}

/**
 * An icon request: through the browser sidecar's small-file route when it is
 * configured (plain HTTP through its egress, Chrome for a file a bot check
 * refuses, never queued behind page reads). Never directly while the browser
 * is configured: a failed sidecar request throws. Without it, the request
 * goes through the public-address guard; `allowPrivate` lets a request the
 * guard refused for its address retry through the connector, which still
 * refuses private hosts the admin did not name. `head` asks for a page only
 * up to its </head>; directly, the page's size cap stands in.
 */
export async function fetchIcon(
  url,
  {
    head = false,
    allowPrivate = false,
    fetchPublic = fetchPublicUrl,
    connectorFetch = defaultConnectorFetch,
    ...options
  } = {}
) {
  const browser = sharedBrowserRoute()
  if (browser) return browser.fetchFile(url, { ...options, head })
  try {
    return await fetchPublic(url, options)
  } catch (err) {
    if (allowPrivate && isBlockedAddress(err)) {
      const found = await viaConnector(url, options, connectorFetch).catch(
        () => null
      )
      if (found) return found
    }
    throw err
  }
}

/** The labels a country code registry sells names under, as in "co.uk". */
const SECOND_LEVEL_LABELS = new Set([
  'ac', 'co', 'com', 'edu', 'gov', 'net', 'org', 'ne', 'or', 'go', 'gob', 'mil',
])

/**
 * The registrable parent of an origin, on the same scheme:
 * https://mcp.notion.com -> https://notion.com. Country pairs such as
 * bbc.co.uk count as one domain, the way siteName() reads them. IP addresses,
 * localhost and a domain that is already registrable have no parent.
 */
export function parentOrigin(origin) {
  let parsed
  try {
    parsed = new URL(String(origin))
  } catch {
    return null
  }
  const host = parsed.hostname
  if (isIP(host) || host.startsWith('[') || !host.includes('.')) return null
  const parts = host.split('.').filter(Boolean)
  const last = parts[parts.length - 1]
  const second = parts[parts.length - 2]
  // "bbc.co.uk" is one site, but "foo.de" and "mcp.foo.de" are not a pair
  const countryPair =
    last.length === 2 && SECOND_LEVEL_LABELS.has(second) && parts.length >= 3
  const size = countryPair ? 3 : 2
  if (parts.length <= size) return null
  return `${parsed.protocol}//${parts.slice(-size).join('.')}`
}

export class FaviconResolver {
  constructor({ fetch = fetchIcon, now = Date.now } = {}) {
    this.fetch = fetch
    this.now = now
    this.cache = new Map()
    this.pending = new Map()
  }

  /** The origin's icon as { type, body }, or null when it has none. */
  async get(origin) {
    return (await this.find(origin)).icon
  }

  /**
   * { icon, sure }: the icon or null, and whether a null is the site having
   * none rather than a request that failed on the way (busy sidecar,
   * timeout), which is looked up again a minute later instead of an hour.
   */
  async find(origin) {
    const cached = this.cache.get(origin)
    if (cached && cached.expires > this.now()) return cached.found
    // A search lists several pages of one site at once: one lookup serves all.
    let pending = this.pending.get(origin)
    if (!pending) {
      pending = this._resolve(origin).finally(() => this.pending.delete(origin))
      this.pending.set(origin, pending)
    }
    const found = await pending
    const ttl = found.icon
      ? FOUND_TTL_MS
      : found.sure
        ? MISSING_TTL_MS
        : UNSURE_TTL_MS
    this.cache.delete(origin)
    this.cache.set(origin, { found, expires: this.now() + ttl })
    if (this.cache.size > MAX_CACHED) {
      this.cache.delete(this.cache.keys().next().value)
    }
    return found
  }

  /**
   * /favicon.ico and the home page's head at once; the icons the page
   * declares as soon as it is read, and the common paths as soon as
   * /favicon.ico turns out not to be an icon. The first real image wins and
   * the other requests are stopped.
   */
  _resolve(origin) {
    const stop = new AbortController()
    const { signal } = stop
    let sure = true
    const failed = err => {
      if (signal.aborted) return
      if (err?.kind === 'network' || err?.code === 'aborted') sure = false
    }

    return new Promise(resolve => {
      const tried = new Set()
      let open = 0
      let done = false
      const settle = icon => {
        if (done) return
        if (icon) {
          done = true
          stop.abort()
          resolve({ icon, sure: true })
        } else if (--open === 0) {
          done = true
          resolve({ icon: null, sure })
        }
      }
      const tryIcon = (url, { orElse } = {}) => {
        if (done || tried.has(url)) return
        tried.add(url)
        open++
        this.fetch(url, {
          maxBytes: ICON_BYTES,
          timeoutMs: TIMEOUT_MS,
          headers: HEADERS,
          signal,
        }).then(
          res => {
            const type = res.truncated ? null : sniffImageType(res.body)
            if (!type) orElse?.()
            settle(type ? { type, body: res.body } : null)
          },
          err => {
            failed(err)
            // Started before this one settles, so `open` never reaches 0 early
            orElse?.()
            settle(null)
          }
        )
      }

      open++
      tryIcon(`${origin}/favicon.ico`, {
        orElse: () => COMMON_PATHS.forEach(path => tryIcon(`${origin}${path}`)),
      })
      this.fetch(`${origin}/`, {
        maxBytes: PAGE_BYTES,
        timeoutMs: TIMEOUT_MS,
        headers: HEADERS,
        signal,
        head: true,
      }).then(
        page => {
          const declared = iconLinksIn(page.body.toString('utf8'), page.url)
          for (const url of declared.slice(0, MAX_DECLARED)) tryIcon(url)
          settle(null)
        },
        err => {
          failed(err)
          settle(null)
        }
      )
    })
  }
}

// One resolver, and so one cache, per allowPrivate: a result that reached a
// private address never answers a public lookup.
const resolvers = {
  public: new FaviconResolver(),
  private: new FaviconResolver({
    fetch: (url, options) => fetchIcon(url, { ...options, allowPrivate: true }),
  }),
}

/**
 * The icon an origin shows, as { icon, sure }. `allowPrivate` lets the
 * connector reach a private host the admin named. `parentFallback` tries the
 * registrable parent when the origin has no icon, sure or not; it is off for
 * web results, which want the site's own icon.
 */
export async function resolveOriginIcon(
  origin,
  { allowPrivate = false, parentFallback = false } = {}
) {
  const site = normalizeOrigin(origin)
  if (!site) return { icon: null, sure: false }
  const resolver = allowPrivate ? resolvers.private : resolvers.public
  const found = await resolver.find(site)
  if (found.icon || !parentFallback) return found
  const parent = parentOrigin(site)
  if (!parent) return found
  const parentFound = await resolver.find(parent)
  if (parentFound.icon) return parentFound
  return { icon: null, sure: found.sure && parentFound.sure }
}

function iconFrom(body) {
  const type = sniffImageType(body)
  return type ? { type, body } : null
}

/**
 * One explicit icon URL, as { type, body } or null when it is not a real
 * image. Accepts http(s) and base64 image data: URIs, under the same byte cap.
 */
export async function fetchIconBytes(url, { allowPrivate = false } = {}) {
  const text = String(url)
  const data = /^data:image\/[^;,]+;base64,([a-z0-9+/=]*)$/i.exec(text)
  if (data) {
    // Four base64 characters carry three bytes: refusing a longer string
    // before decoding keeps the decoded image under the cap
    if (data[1].length > (ICON_BYTES / 3) * 4) return null
    return iconFrom(Buffer.from(data[1], 'base64'))
  }
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  let res
  try {
    res = await fetchIcon(parsed.toString(), {
      allowPrivate,
      maxBytes: ICON_BYTES,
      timeoutMs: TIMEOUT_MS,
      headers: HEADERS,
    })
  } catch {
    return null
  }
  return res.truncated ? null : iconFrom(res.body)
}

/**
 * Writes an icon response: the image, or a 404 that says whether the site
 * has no icon (cached for an hour) or the lookup failed (not cached).
 */
export function sendIcon(res, { icon = null, sure = false } = {}) {
  // An SVG opened directly must not run as a page on Overleaf's origin.
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  })
  if (!icon) {
    res.set('Cache-Control', sure ? 'private, max-age=3600' : 'no-store')
    return res.sendStatus(404)
  }
  res.set({
    'Content-Type': icon.type,
    'Cache-Control': 'private, max-age=86400',
  })
  res.send(icon.body)
}

export default {
  /** GET /ai-assist/favicon?origin=https://example.com */
  async serve(req, res) {
    const origin = normalizeOrigin(req.query?.origin)
    if (!origin) return res.sendStatus(400)
    let found = { icon: null, sure: false }
    try {
      found = await resolveOriginIcon(origin)
    } catch {}
    sendIcon(res, found)
  },
}
