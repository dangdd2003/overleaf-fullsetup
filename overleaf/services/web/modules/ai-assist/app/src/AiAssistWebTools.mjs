import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import zlib from 'node:zlib'
import sanitizeHtml from 'sanitize-html'
import {
  ProviderError,
  fetchWithRetry,
  resolveDockerHostUrl,
  validateSafeProviderBaseUrl,
} from './AiAssistProviders.mjs'

/**
 * Web research for the agent: `web_search` and `web_fetch`.
 *
 * Two backends. Ollama's hosted web search API answers both tools. A
 * self-hosted SearXNG instance answers searches, and this server then reads
 * pages itself.
 *
 * Every request leaves from the Overleaf server, like the provider calls, so a
 * SearXNG instance on the internal network works behind a public domain. The
 * pages web_fetch reads are the opposite case: the model picks the URL, and a
 * page it read earlier can steer that pick, so a direct fetch may only connect
 * to public addresses. The check runs at connect time on the address actually
 * dialled, so a DNS answer that changes between check and connect cannot slip
 * through.
 */

export const WEB_SEARCH_PROVIDERS = ['ollama', 'searxng']
export const WEB_TOOL_NAMES = new Set(['web_search', 'web_fetch'])

export const WEB_SEARCH_DEFAULTS = {
  cacheHours: 24,
  maxCachedSearches: 256,
  maxCachedPages: 64,
  // How many results a search returns, and the most the model may ask for
  resultsPerSearch: 10,
}

const OLLAMA_API_BASE = 'https://ollama.com/api'
const MAX_SNIPPET_CHARS = 600
/** About 3k tokens: enough for a manual section, small enough to page through. */
export const PAGE_CHARS = 12_000
const MAX_DOCUMENT_CHARS = 400_000
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024
const MAX_REDIRECTS = 5
const REQUEST_TIMEOUT_MS = 20_000
const MAX_FIND_MATCHES = 12
const MAX_FIND_PASSAGE_CHARS = 1500
/**
 * Pages and search results are kept in this process's memory, per user, for
 * as long as the user's cacheHours allows (a day unless they change it), so
 * repeating a lookup costs no second API call or download. A search restricted
 * to recent results is the exception: it exists to see what changed, so it is
 * reused for an hour at most.
 */
const HOUR_MS = 60 * 60 * 1000
const RECENT_SEARCH_TTL_MS = HOUR_MS
const USER_AGENT = 'Mozilla/5.0 (compatible; OverleafAIAssist/1.0)'
/**
 * Many news and documentation sites answer an unfamiliar user agent with 401
 * or 403 but serve an ordinary browser. A refused page is asked for once more
 * the way a browser would ask.
 */
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Upgrade-Insecure-Requests': '1',
}
const REFUSED_STATUSES = new Set([401, 403, 406, 429, 451, 503])
const WAYBACK_LOOKUP = 'https://archive.org/wayback/available'
const RECENCY_VALUES = ['day', 'week', 'month', 'year']

/**
 * `kind` says whether another route to the same page could succeed: a page
 * that refused us or timed out might be readable from an archive, a PDF or a
 * private address never is.
 */
function webError(message, { status, hint, kind = 'content' } = {}) {
  const error = new ProviderError(message, { code: 'webToolError', status, hint })
  error.kind = kind
  return error
}

function isRetryableFailure(err) {
  return err?.kind === 'http' || err?.kind === 'network'
}

function describeStatus(status) {
  if (status === 401 || status === 403 || status === 451) {
    return 'the site refuses automated readers'
  }
  if (status === 404 || status === 410) return 'the page does not exist'
  if (status === 429) return 'the site is rate-limiting requests'
  if (status >= 500) return 'the site had a server error'
  return ''
}

function settingsError(message) {
  return new ProviderError(message, { code: 'invalidWebSearchSettings', status: 400 })
}

function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

function clampInt(value, min, max, fallback) {
  const parsed = typeof value === 'string' ? Number(value.trim()) : value
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

/** `YYYY-MM-DD` for anything Date can parse, else ''. */
export function isoDay(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  const raw = typeof value === 'string' ? value.trim() : value
  if (!raw) return ''
  // Wayback timestamps: 20260407153000
  const stamp = /^(\d{4})(\d{2})(\d{2})\d{0,6}$/.exec(String(raw))
  const date = stamp ? new Date(`${stamp[1]}-${stamp[2]}-${stamp[3]}T00:00:00Z`) : new Date(raw)
  if (Number.isNaN(date.getTime())) return ''
  const year = date.getUTCFullYear()
  if (year < 1990 || year > 2200) return ''
  return date.toISOString().slice(0, 10)
}

/** The same page under the spellings search engines and links give it. */
function sourceKey(url) {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    parsed.hostname = parsed.hostname.replace(/^www\./, '')
    return `${parsed.hostname}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`
  } catch {
    return String(url)
  }
}

/** A model's recency word, forgiving the obvious variants. */
function normalizeRecency(value) {
  if (typeof value !== 'string') return ''
  const word = value.trim().toLowerCase().replace(/^(past|last)\s+/, '')
  if (RECENCY_VALUES.includes(word)) return word
  return { today: 'day', '24h': 'day', '7d': 'week', '30d': 'month', '1y': 'year' }[word] || ''
}

const SNIPPET_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'about', 'how',
  'news', 'latest', 'today', 'current', 'recent',
])

/**
 * A search backend that returns the whole page as the "snippet" (Ollama does)
 * starts it with the site's boilerplate. Show the passage that actually
 * mentions what was searched for instead.
 */
export function bestSnippet(text, query, max = MAX_SNIPPET_CHARS) {
  const plain = collapse(
    String(text ?? '')
      .replace(/\{%[^%]*%\}/g, ' ')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
  )
  if (plain.length <= max) return plain
  const terms = [
    ...new Set(
      collapse(query)
        .toLowerCase()
        .split(/[^\p{L}\p{N}\\]+/u)
        .filter(term => term.length >= 3 && !SNIPPET_STOPWORDS.has(term))
    ),
  ]
  const sentences = plain.split(/(?<=[.!?])\s+/)
  let best = 0
  let bestScore = 0
  sentences.forEach((sentence, index) => {
    const lower = sentence.toLowerCase()
    const score = terms.filter(term => lower.includes(term)).length
    if (score > bestScore) {
      best = index
      bestScore = score
    }
  })
  return clip(sentences.slice(best).join(' '), max)
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * The SearXNG API lives at `<instance>/search`. People paste the address of a
 * results page as often as the instance root, so both are accepted.
 */
export function normalizeSearxngBaseUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return ''
  let value = raw.trim()
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `http://${value}`
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw settingsError('The SearXNG URL is not a valid URL.')
  }
  parsed.search = ''
  parsed.hash = ''
  parsed.pathname = parsed.pathname.replace(/\/search\/?$/, '').replace(/\/+$/, '')
  return parsed.toString().replace(/\/+$/, '')
}

/**
 * Validates the web search settings a client sent with a run. Returns null
 * when none were sent, which leaves the web tools out of the run.
 */
function clampCacheParam(value, min, max, defaultValue) {
  const num = typeof value === 'string' ? parseInt(value, 10) : typeof value === 'number' ? value : null
  if (num === null || Number.isNaN(num)) return defaultValue
  return Math.max(min, Math.min(max, num))
}

export function normalizeWebSearchSettings(raw) {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object') throw settingsError('Invalid web search settings.')

  const type = typeof raw.type === 'string' ? raw.type.trim() : ''
  if (!WEB_SEARCH_PROVIDERS.includes(type)) {
    throw settingsError(`Unknown web search provider '${type}'.`)
  }

  // Extract cache configuration parameters
  const cacheHours = clampCacheParam(raw.cacheHours, 0, 168, WEB_SEARCH_DEFAULTS.cacheHours)
  const maxCachedSearches = clampCacheParam(raw.maxCachedSearches, 0, 1000, WEB_SEARCH_DEFAULTS.maxCachedSearches)
  const maxCachedPages = clampCacheParam(raw.maxCachedPages, 0, 200, WEB_SEARCH_DEFAULTS.maxCachedPages)
  const resultsPerSearch = clampCacheParam(raw.resultsPerSearch, 1, 10, WEB_SEARCH_DEFAULTS.resultsPerSearch)

  const baseSettings = {
    type,
    cacheHours,
    maxCachedSearches,
    maxCachedPages,
    resultsPerSearch,
  }

  if (type === 'ollama') {
    const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : ''
    if (!apiKey) {
      throw settingsError(
        'Ollama web search needs an API key from https://ollama.com/settings/keys.'
      )
    }
    return { ...baseSettings, apiKey }
  }

  const baseUrl = normalizeSearxngBaseUrl(raw.baseUrl)
  if (!baseUrl) throw settingsError('SearXNG web search needs the URL of your instance.')
  validateSafeProviderBaseUrl(baseUrl)
  return { ...baseSettings, baseUrl }
}

// ---------------------------------------------------------------------------
// Tool specs
// ---------------------------------------------------------------------------

const WEB_FETCH_SPEC = {
  name: 'web_fetch',
  description: `Read a web page as Markdown. Long documents come in pages of about ${PAGE_CHARS} characters, and the result says which page you got and how many there are. Pass find to get only the passages that mention a command, option or phrase anywhere in the document, instead of paging through it. A page that refuses automated readers is read from its latest web archive copy when one exists.`,
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The http or https URL to read, usually one from web_search.',
      },
      page: {
        type: 'integer',
        description: 'Which page of a long document to return, starting at 1. Defaults to 1.',
      },
      find: {
        type: 'string',
        description:
          'Return only the passages containing this text (case-insensitive), each with the page it is on.',
      },
    },
    required: ['url'],
  },
}

/**
 * The search filters are offered only where the backend honours them: Ollama's
 * web search API takes a query and a count and nothing else, and a parameter
 * that is silently ignored would mislead the model about what it got.
 */
export function webToolSpecs(type, { resultsPerSearch = WEB_SEARCH_DEFAULTS.resultsPerSearch } = {}) {
  const filters =
    type === 'searxng'
      ? {
          recency: {
            type: 'string',
            enum: RECENCY_VALUES,
            description:
              'Only results published within this window. Use it when the answer must be current: news, recent events, latest releases.',
          },
          topic: {
            type: 'string',
            enum: ['general', 'news'],
            description:
              'news searches news sites, whose results carry publication dates. Defaults to general.',
          },
        }
      : {}
  return [
    {
      name: 'web_search',
      description:
        'Search the web. Returns the top results, each numbered as a source [n], with title, URL, publication date when known, and a snippet. Use it for anything outside this project that you cannot state reliably from memory: facts that change over time (news, people in office, releases, prices, events), package options and syntax, unfamiliar errors, journal or conference requirements. Snippets are pointers: read the page with web_fetch before relying on a detail.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'What to search for, in the words a page answering it would use. Include the year for time-sensitive questions, e.g. "Vietnam president 2026" or "siunitx range-phrase option".',
          },
          maxResults: {
            type: 'integer',
            minimum: 1,
            maximum: resultsPerSearch,
            description: `How many results to return, 1-${resultsPerSearch}. Defaults to ${resultsPerSearch}, the number set in the user's web search settings.`,
          },
          ...filters,
        },
        required: ['query'],
      },
    },
    WEB_FETCH_SPEC,
  ]
}

export const WEB_TOOL_SPECS = webToolSpecs('searxng')

// ---------------------------------------------------------------------------
// Public-address guard
// ---------------------------------------------------------------------------

const BLOCKED_ADDRESSES = new net.BlockList()
for (const [prefix, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  BLOCKED_ADDRESSES.addSubnet(prefix, bits, 'ipv4')
}
for (const [prefix, bits] of [
  ['::', 128],
  ['::1', 128],
  // NAT64, Teredo and 6to4 all embed an IPv4 address that may be private;
  // none of them is how a public documentation site is reached. IPv4-mapped
  // addresses are unwrapped in isPublicAddress instead: BlockList matches every
  // plain IPv4 address against a ::ffff:0:0/96 rule.
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
]) {
  BLOCKED_ADDRESSES.addSubnet(prefix, bits, 'ipv6')
}

/** True only for a globally routable unicast IP address. */
export function isPublicAddress(address) {
  const raw = String(address ?? '').replace(/^\[|\]$/g, '')
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw)
  if (mapped) return isPublicAddress(mapped[1])
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(raw)
  if (mappedHex) {
    const high = parseInt(mappedHex[1], 16)
    const low = parseInt(mappedHex[2], 16)
    return isPublicAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
  }
  try {
    const family = net.isIP(raw)
    if (family === 4) return !BLOCKED_ADDRESSES.check(raw, 'ipv4')
    if (family === 6) return !BLOCKED_ADDRESSES.check(raw, 'ipv6')
  } catch {
    // an address BlockList cannot parse (a zone id, say) is not public
  }
  return false
}

/**
 * A `dns.lookup` replacement that refuses to hand back a private address.
 * Used as the socket's own lookup, so the address it vets is the one dialled.
 */
export function guardedLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options
    options = {}
  } else if (typeof options === 'number') {
    options = { family: options }
  }
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err)
    const list = Array.isArray(addresses) ? addresses : []
    const blocked = list.find(entry => !isPublicAddress(entry.address))
    if (list.length === 0 || blocked) {
      const error = new Error(
        `${hostname} resolves to a private or reserved address${blocked ? ` (${blocked.address})` : ''}`
      )
      error.code = 'EADDRBLOCKED'
      return callback(error)
    }
    if (options?.all) return callback(null, list)
    callback(null, list[0].address, list[0].family)
  })
}

function parseFetchUrl(raw) {
  let parsed
  try {
    parsed = new URL(String(raw).trim())
  } catch {
    throw webError(`Not a valid URL: ${raw}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw webError(`Only http and https URLs can be fetched, not ${parsed.protocol}`)
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (
    (net.isIP(host) && !isPublicAddress(host)) ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local')
  ) {
    throw webError(`${host} is not a public address. Only public web pages can be fetched.`)
  }
  parsed.hash = ''
  return parsed
}

const DEFAULT_HEADERS = {
  'User-Agent': USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
  'Accept-Language': 'en;q=1.0, *;q=0.5',
}

function requestOnce(url, { signal, maxBytes, lookup, headers = DEFAULT_HEADERS }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http
    const req = transport.request(
      url,
      {
        method: 'GET',
        headers: { ...headers, 'Accept-Encoding': 'gzip, deflate, br' },
        lookup,
        signal,
        agent: false,
      },
      res => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume()
          resolve({ redirect: res.headers.location })
          return
        }
        if (status >= 400) {
          res.resume()
          const reason = describeStatus(status)
          reject(
            webError(`${url} returned HTTP ${status}${reason ? `: ${reason}` : ''}.`, {
              status,
              kind: 'http',
            })
          )
          return
        }

        let stream = res
        const encoding = String(res.headers['content-encoding'] || '').trim().toLowerCase()
        if (encoding === 'gzip' || encoding === 'x-gzip') stream = res.pipe(zlib.createGunzip())
        else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate())
        else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress())

        const chunks = []
        let size = 0
        let truncated = false
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          resolve({
            status,
            contentType: String(res.headers['content-type'] || ''),
            body: Buffer.concat(chunks),
            truncated,
          })
        }
        // The cap applies after decompression, so a small compressed bomb
        // cannot expand past it.
        stream.on('data', chunk => {
          if (truncated) return
          size += chunk.length
          if (size > maxBytes) {
            chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes)))
            truncated = true
            finish()
            res.destroy()
            return
          }
          chunks.push(chunk)
        })
        stream.on('end', finish)
        stream.on('error', err => {
          if (truncated) return
          if (settled) return
          settled = true
          reject(err)
        })
      }
    )
    req.on('error', reject)
    req.end()
  })
}

/**
 * GETs a public web page: http(s) only, public addresses only (checked on
 * every redirect hop and at connect time), bounded in size and time.
 */
export async function fetchPublicUrl(
  rawUrl,
  {
    signal,
    maxBytes = MAX_DOWNLOAD_BYTES,
    timeoutMs = REQUEST_TIMEOUT_MS,
    lookup = guardedLookup,
    headers,
  } = {}
) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = AbortSignal.any([signal, timeout].filter(Boolean))
  let current = parseFetchUrl(rawUrl)

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response
    try {
      response = await requestOnce(current, { signal: combined, maxBytes, lookup, headers })
    } catch (err) {
      if (signal?.aborted) throw new ProviderError('Request was cancelled', { code: 'aborted' })
      if (timeout.aborted) {
        throw webError(`${current} did not answer within ${Math.round(timeoutMs / 1000)}s.`, {
          kind: 'network',
        })
      }
      if (err instanceof ProviderError) throw err
      if (err?.code === 'EADDRBLOCKED') {
        throw webError(`${err.message}. Only public web pages can be fetched.`)
      }
      if (err?.code === 'ENOTFOUND' || err?.code === 'EAI_AGAIN') {
        throw webError(`Could not resolve ${current.hostname}. Check the URL.`)
      }
      throw webError(`Could not fetch ${current}: ${err?.message || 'network error'}`, {
        kind: 'network',
      })
    }
    if (response.redirect) {
      current = parseFetchUrl(new URL(response.redirect, current).toString())
      continue
    }
    return { ...response, url: current.toString() }
  }
  throw webError(`Too many redirects fetching ${rawUrl}.`)
}

// ---------------------------------------------------------------------------
// HTML to Markdown
// ---------------------------------------------------------------------------

/** Page chrome: removed with everything inside it. */
const DROPPED_ELEMENTS = new Set(['nav', 'footer', 'aside', 'form', 'button', 'select', 'dialog', 'menu'])

const MARKDOWN_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'div', 'section', 'article', 'main', 'header', 'blockquote',
  'figure', 'figcaption', 'details', 'summary',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'pre', 'code', 'kbd', 'samp', 'tt',
  'a', 'br', 'hr', 'math',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
  ...DROPPED_ELEMENTS,
]

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'main', 'header', 'blockquote',
  'figure', 'figcaption', 'details', 'summary', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'caption',
])

const INLINE_CODE_TAGS = new Set(['code', 'kbd', 'samp', 'tt'])

function unescapeHtml(text) {
  return text.replace(
    /&(lt|gt|quot|#39|amp);/g,
    (_match, entity) => ({ lt: '<', gt: '>', quot: '"', '#39': "'", amp: '&' })[entity]
  )
}

function attribute(attrs, name) {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs || '')
  return match ? unescapeHtml(match[1]) : undefined
}

/** Prefer the page's main content when it marks one, to skip site chrome. */
function pickMainHtml(html) {
  const main = /<main\b[^>]*>([\s\S]*)<\/main>/i.exec(html)
  if (main && main[1].length > 500) return main[1]
  if ((html.match(/<article\b/gi) || []).length === 1) {
    const article = /<article\b[^>]*>([\s\S]*)<\/article>/i.exec(html)
    if (article && article[1].length > 500) return article[1]
  }
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)
  return body ? body[1] : html
}

function sanitizeForMarkdown(html) {
  return sanitizeHtml(html, {
    allowedTags: MARKDOWN_TAGS,
    allowedAttributes: { a: ['href'], math: ['alttext', 'display'] },
    allowedSchemes: ['http', 'https'],
    nonTextTags: [
      'script', 'style', 'textarea', 'option', 'noscript', 'svg',
      'template', 'iframe', 'head', 'title', 'canvas', 'object',
    ],
    exclusiveFilter: frame => DROPPED_ELEMENTS.has(frame.tag),
    disallowedTagsMode: 'discard',
  })
}

function formatLink(inner, href, baseUrl) {
  const text = collapse(inner)
  if (!text) return ''
  if (!href) return inner
  let target
  try {
    target = new URL(href, baseUrl)
  } catch {
    return inner
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return inner
  // An anchor on the same page tells the reader nothing the text does not.
  if (target.hash) {
    const page = new URL(target)
    page.hash = ''
    const base = baseUrl ? new URL(baseUrl) : null
    if (base) base.hash = ''
    if (base && page.toString() === base.toString()) return inner
  }
  return `[${text}](${target.toString()})`
}

function tidyMarkdown(text) {
  const result = []
  let fenced = false
  for (const raw of text.split('\n')) {
    if (/^\s*```/.test(raw)) {
      fenced = !fenced
      result.push(raw.trim())
      continue
    }
    if (fenced) {
      result.push(raw.replace(/\s+$/, ''))
      continue
    }
    let line = raw.replace(/\s+$/, '')
    const listItem = /^(\s*)(- |\d+\. )\s*(.*)$/.exec(line)
    if (listItem) {
      if (!listItem[3]) continue
      line = `${listItem[1]}${listItem[2]}${listItem[3].replace(/ {2,}/g, ' ')}`
    } else {
      line = line.replace(/(\S) {2,}/g, '$1 ')
      line = line.trimStart().replace(/^(#{1,6} )\s+/, '$1')
      if (/^#{1,6}$/.test(line)) continue
    }
    result.push(line)
  }
  return result.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Converts HTML already narrowed by `sanitizeForMarkdown` to Markdown. */
function sanitizedHtmlToMarkdown(html, baseUrl) {
  const out = []
  const lists = []
  const links = []
  let preDepth = 0
  let skippingMath = false
  let row = null
  let tableRows = 0
  let inCell = false

  const blockBreak = () => out.push(inCell ? ' ' : '\n\n')

  for (const match of html.matchAll(/<(\/?)([a-z][a-z0-9]*)([^>]*)>|([^<]+)/gi)) {
    const [, closing, rawName, attrs, text] = match

    if (text !== undefined) {
      if (skippingMath) continue
      const decoded = unescapeHtml(text)
      out.push(preDepth ? decoded.replace(/ /g, ' ') : decoded.replace(/\s+/g, ' '))
      continue
    }

    const name = rawName.toLowerCase()

    // MathML carries the TeX source in alttext (Wikipedia, arXiv HTML), which
    // is exactly what a LaTeX assistant wants rather than the rendered glyphs.
    if (name === 'math') {
      if (closing) {
        skippingMath = false
        continue
      }
      const tex = attribute(attrs, 'alttext')
      if (tex && tex.trim()) {
        skippingMath = true
        out.push(attribute(attrs, 'display') === 'block' ? `\n\n$$${tex.trim()}$$\n\n` : ` $${tex.trim()}$ `)
      }
      continue
    }
    if (skippingMath) continue

    if (name === 'pre') {
      if (!closing) {
        preDepth++
        if (preDepth === 1) out.push('\n\n```\n')
      } else if (preDepth > 0) {
        preDepth--
        if (preDepth === 0) out.push('\n```\n\n')
      }
      continue
    }
    if (preDepth) {
      if (name === 'br') out.push('\n')
      continue
    }

    const heading = /^h([1-6])$/.exec(name)
    if (heading) {
      if (inCell) out.push(' ')
      else out.push(closing ? '\n\n' : `\n\n${'#'.repeat(Number(heading[1]))} `)
      continue
    }

    if (INLINE_CODE_TAGS.has(name)) {
      out.push('`')
      continue
    }

    switch (name) {
      case 'br':
        out.push(inCell ? ' ' : '\n')
        break
      case 'hr':
        out.push(inCell ? ' ' : '\n\n---\n\n')
        break
      case 'ul':
      case 'ol':
        if (!closing) {
          // A nested list starts on its first item's own line, not a blank one.
          if (lists.length === 0) out.push(inCell ? ' ' : '\n')
          lists.push({ ordered: name === 'ol', count: 0 })
        } else {
          lists.pop()
          out.push(inCell ? ' ' : lists.length ? '\n' : '\n\n')
        }
        break
      case 'li':
        if (!closing) {
          const list = lists.at(-1)
          const marker = list?.ordered ? `${++list.count}. ` : '- '
          out.push(inCell ? ' ' : `\n${'  '.repeat(Math.max(0, lists.length - 1))}${marker}`)
        }
        break
      case 'a':
        if (!closing) {
          links.push({ href: attribute(attrs, 'href'), at: out.length })
        } else {
          const link = links.pop()
          if (link) out.push(formatLink(out.splice(link.at).join(''), link.href, baseUrl))
        }
        break
      case 'table':
        tableRows = 0
        row = null
        inCell = false
        out.push('\n\n')
        break
      case 'tr':
        if (!closing) {
          row = { cells: 0 }
          out.push('\n| ')
        } else if (row) {
          out.push(' |')
          tableRows++
          if (tableRows === 1 && row.cells > 0) out.push(`\n|${' --- |'.repeat(row.cells)}`)
          row = null
        }
        break
      case 'th':
      case 'td':
        if (!closing) {
          if (row && row.cells > 0) out.push(' | ')
          if (row) row.cells++
          inCell = true
        } else {
          inCell = false
        }
        break
      default:
        if (BLOCK_TAGS.has(name)) blockBreak()
    }
  }

  return tidyMarkdown(out.join(''))
}

const PUBLISHED_META = [
  'article:published_time',
  'og:published_time',
  'datepublished',
  'publish-date',
  'publishdate',
  'pubdate',
  'date',
  'dc.date.issued',
  'dc.date',
  'citation_publication_date',
  'citation_date',
]
const MODIFIED_META = ['article:modified_time', 'og:updated_time', 'datemodified', 'last-modified']

function metaContent(html, names) {
  const found = new Map()
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const name = /\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase()
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]
    if (name && content && !found.has(name)) found.set(name, content)
  }
  for (const name of names) {
    const day = isoDay(found.get(name))
    if (day) return day
  }
  return ''
}

/**
 * When a page says it was published and last changed. How current a source
 * is decides whether it answers a question about the present, so the model
 * is told whenever the page says.
 */
export function extractPageDates(html) {
  const head = html.slice(0, 200_000)
  const jsonLd = key => isoDay(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`).exec(head)?.[1])
  const published =
    metaContent(head, PUBLISHED_META) ||
    jsonLd('datePublished') ||
    isoDay(/<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/i.exec(head)?.[1])
  const modified = metaContent(head, MODIFIED_META) || jsonLd('dateModified')
  return {
    ...(published ? { published } : {}),
    ...(modified && modified !== published ? { modified } : {}),
  }
}

/** Title and Markdown body of an HTML page, and its dates when it has them. */
export function htmlToMarkdown(html, baseUrl) {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const title = titleMatch
    ? collapse(unescapeHtml(sanitizeHtml(titleMatch[1], { allowedTags: [], allowedAttributes: {} })))
    : ''
  const markdown = sanitizedHtmlToMarkdown(sanitizeForMarkdown(pickMainHtml(html)), baseUrl)
  return { title, markdown, ...extractPageDates(html) }
}

// ---------------------------------------------------------------------------
// Documents, pages and find
// ---------------------------------------------------------------------------

/**
 * Start offsets of each page. Pages break at a paragraph, else a line, near
 * the size limit, so a page does not end mid-sentence where it can help it.
 */
export function splitPages(text, size = PAGE_CHARS) {
  const starts = [0]
  let pos = 0
  while (text.length - pos > size) {
    const limit = pos + size
    const earliest = pos + Math.floor(size * 0.6)
    let cut = text.lastIndexOf('\n\n', limit)
    if (cut < earliest) cut = text.lastIndexOf('\n', limit)
    if (cut < earliest) cut = limit
    pos = cut
    while (text[pos] === '\n') pos++
    if (pos >= text.length) break
    starts.push(pos)
  }
  return starts
}

function pageText(doc, page) {
  return doc.text.slice(doc.pages[page - 1], doc.pages[page] ?? doc.text.length).trimEnd()
}

function pageOf(pages, offset) {
  let page = 1
  for (let i = 0; i < pages.length; i++) {
    if (pages[i] <= offset) page = i + 1
  }
  return page
}

function makeDocument({ url, title, text, truncated = false, published, modified }) {
  let body = String(text ?? '').trim()
  let cut = truncated
  if (body.length > MAX_DOCUMENT_CHARS) {
    body = body.slice(0, MAX_DOCUMENT_CHARS)
    cut = true
  }
  if (!body) {
    throw webError(
      `${url} has no readable text. It may need JavaScript to render; try another source.`
    )
  }
  return {
    url,
    title: clip(collapse(title), 200),
    text: body,
    pages: splitPages(body),
    truncated: cut,
    ...(published ? { published } : {}),
    ...(modified ? { modified } : {}),
  }
}

function findPassagesFor(doc, term) {
  const needle = term.toLowerCase()
  const matches = []
  let total = 0
  let budget = PAGE_CHARS
  let heading = ''
  let offset = 0
  for (const block of doc.text.split(/\n{2,}/)) {
    const at = doc.text.indexOf(block, offset)
    offset = at + block.length
    const firstLine = block.split('\n', 1)[0]
    if (/^#{1,6} /.test(firstLine)) heading = firstLine
    if (!block.toLowerCase().includes(needle)) continue
    total++
    if (matches.length >= MAX_FIND_MATCHES || budget <= 0) continue
    const passage = clip(block, MAX_FIND_PASSAGE_CHARS)
    budget -= passage.length
    matches.push({
      page: pageOf(doc.pages, at),
      ...(heading && heading !== firstLine ? { heading } : {}),
      text: passage,
    })
  }
  return { matches, total }
}

/**
 * Passages mentioning `find`. A model often over-escapes a command name
 * (`\\qty`) or includes a backslash the page drops, so fall back through
 * those spellings before reporting nothing.
 */
export function findPassages(doc, find) {
  const term = collapse(find)
  const candidates = [...new Set([term, term.replace(/\\\\/g, '\\'), term.replace(/^\\+/, '')])]
    .filter(Boolean)
  for (const candidate of candidates) {
    const found = findPassagesFor(doc, candidate)
    if (found.total > 0) return { ...found, term: candidate }
  }
  return { matches: [], total: 0, term }
}

function mediaType(contentType) {
  return String(contentType || '').split(';')[0].trim().toLowerCase()
}

function charsetOf(contentType, body) {
  const header = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType || '')?.[1]
  if (header) return header
  const head = body.subarray(0, 4096).toString('latin1')
  return /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1] || 'utf-8'
}

function decodeBody(body, charset) {
  try {
    return new TextDecoder(charset).decode(body)
  } catch {
    return new TextDecoder('utf-8').decode(body)
  }
}

function isTextualType(type) {
  return (
    type.startsWith('text/') ||
    /(json|xml|javascript|x-tex|x-latex|x-bibtex|yaml|toml)/.test(type)
  )
}

/** Turns a fetched response into a paged document, or explains why it can't. */
export function documentFromResponse({ url, contentType = '', body, truncated = false }) {
  const type = mediaType(contentType)
  if (type === 'application/pdf' || body.subarray(0, 5).toString('latin1') === '%PDF-') {
    throw webError(
      `${url} is a PDF, which web_fetch cannot read. Look for an HTML version of the same document, such as the package's CTAN page or its documentation site.`
    )
  }

  const text = decodeBody(body, charsetOf(contentType, body))
  const looksLikeHtml = /^\s*<(!doctype html|html|head|body)\b/i.test(text)
  if (type === 'text/html' || type === 'application/xhtml+xml' || (!type && looksLikeHtml)) {
    const { markdown, ...page } = htmlToMarkdown(text, url)
    return makeDocument({ url, ...page, text: markdown, truncated })
  }

  if ((type && !isTextualType(type)) || text.includes('\u0000')) {
    throw webError(`${url} is ${type || 'binary data'}, not a text page, so web_fetch cannot read it.`)
  }
  let content = text.replace(/\r\n?/g, '\n')
  if (type.includes('json')) {
    try {
      content = JSON.stringify(JSON.parse(content), null, 2)
    } catch {
      // keep the raw text
    }
  }
  return makeDocument({ url, title: '', text: content, truncated })
}

/** Least-recently-used entries go first once the cache is full. */
class TtlCache {
  constructor(maxEntries) {
    this.maxEntries = maxEntries
    this.entries = new Map()
  }

  /**
   * The value if it was stored less than `maxAgeMs` ago. The age limit is
   * checked on read, not fixed on write, so shortening it in the settings
   * also retires what is already cached.
   */
  get(key, maxAgeMs) {
    const entry = this.entries.get(key)
    if (!entry) return null
    if (Date.now() - entry.at >= maxAgeMs) {
      this.entries.delete(key)
      return null
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key, value) {
    this.entries.delete(key)
    this.entries.set(key, { at: Date.now(), value })
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value)
    }
  }

  clear() {
    this.entries.clear()
  }
}

// Per-user caches: owner -> { searches: TtlCache, documents: TtlCache, maxCached: {...} }
const MAX_OWNER_CACHE_COUNT = 100
const ownerCaches = new Map()

function getOwnerCaches(owner = 'default') {
  if (!ownerCaches.has(owner)) {
    ownerCaches.set(owner, {
      searches: new TtlCache(WEB_SEARCH_DEFAULTS.maxCachedSearches),
      documents: new TtlCache(WEB_SEARCH_DEFAULTS.maxCachedPages),
      maxCached: { searches: WEB_SEARCH_DEFAULTS.maxCachedSearches, pages: WEB_SEARCH_DEFAULTS.maxCachedPages },
    })
    // Drop least recently used owner when exceeding capacity
    if (ownerCaches.size > MAX_OWNER_CACHE_COUNT) {
      const firstKey = ownerCaches.keys().next().value
      ownerCaches.delete(firstKey)
    }
  }
  const caches = ownerCaches.get(owner)
  // Move to end (most recently used)
  ownerCaches.delete(owner)
  ownerCaches.set(owner, caches)
  return caches
}

function updateOwnerCacheCapacity(owner, maxCachedSearches, maxCachedPages) {
  const caches = getOwnerCaches(owner)
  const changed = caches.maxCached.searches !== maxCachedSearches || caches.maxCached.pages !== maxCachedPages
  if (!changed) return

  caches.maxCached.searches = maxCachedSearches
  caches.maxCached.pages = maxCachedPages

  // Trim caches to new capacity
  caches.searches.maxEntries = maxCachedSearches
  caches.documents.maxEntries = maxCachedPages
  while (caches.searches.entries.size > maxCachedSearches) {
    caches.searches.entries.delete(caches.searches.entries.keys().next().value)
  }
  while (caches.documents.entries.size > maxCachedPages) {
    caches.documents.entries.delete(caches.documents.entries.keys().next().value)
  }
}

export function clearWebDocumentCache() {
  for (const caches of ownerCaches.values()) {
    caches.searches.clear()
    caches.documents.clear()
  }
}

// ---------------------------------------------------------------------------
// Search results
// ---------------------------------------------------------------------------

function normalizeResults(list, max, query) {
  const seen = new Set()
  const results = []
  for (const entry of Array.isArray(list) ? list : []) {
    const url = typeof entry?.url === 'string' ? entry.url.trim() : ''
    if (!/^https?:\/\//i.test(url)) continue
    // Engines behind one SearXNG query list the same page with and without
    // www or a trailing slash
    const key = sourceKey(url)
    if (seen.has(key)) continue
    seen.add(key)
    const published = isoDay(entry.publishedDate ?? entry.published_date ?? entry.pubdate)
    results.push({
      title: clip(collapse(entry.title || url), 200),
      url,
      ...(published ? { published } : {}),
      snippet: bestSnippet(entry.content || entry.snippet || '', query),
    })
    if (results.length >= max) break
  }
  return results
}

async function upstreamError(res, label, type) {
  const raw = await res.text().catch(() => '')
  let detail = /<html|<!doctype/i.test(raw) ? '' : raw.slice(0, 300).trim()
  try {
    const parsed = JSON.parse(raw)
    const candidate = parsed?.error?.message ?? parsed?.error ?? parsed?.message
    if (typeof candidate === 'string') detail = candidate
  } catch {
    // keep the raw text
  }
  let hint = ''
  if (type === 'searxng' && res.status === 403) {
    hint = 'SearXNG refuses JSON requests until "json" is added to search.formats in its settings.yml.'
  } else if (type === 'searxng' && res.status === 429) {
    hint = "SearXNG's bot limiter blocked the request; allow this server's address or turn the limiter off for it."
  } else if (res.status === 401 || res.status === 403) {
    hint = 'The Ollama API key was rejected. Create one at https://ollama.com/settings/keys and update it in Account Settings.'
  } else if (res.status === 429) {
    hint = 'The web search rate limit was reached. Wait a moment before searching again.'
  }
  const message = `${label} returned HTTP ${res.status}${detail ? `: ${detail}` : ''}.${hint ? ` ${hint}` : ''}`
  return webError(message, { status: res.status, hint })
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

export class AiAssistWebTools {
  /**
   * @param {{ type: 'ollama', apiKey: string } | { type: 'searxng', baseUrl: string },
   *          cacheHours, maxCachedSearches, maxCachedPages, resultsPerSearch } settings
   *   Already validated by `normalizeWebSearchSettings`.
   */
  constructor(settings, { fetchFn = fetch, fetchPage = fetchPublicUrl, cacheOwner = 'default' } = {}) {
    this.settings = settings
    this.fetchFn = fetchFn
    this.fetchPage = fetchPage
    this.cacheOwner = cacheOwner

    // Initialize per-user caches with configured capacity limits
    updateOwnerCacheCapacity(
      cacheOwner,
      settings.maxCachedSearches ?? WEB_SEARCH_DEFAULTS.maxCachedSearches,
      settings.maxCachedPages ?? WEB_SEARCH_DEFAULTS.maxCachedPages
    )

    // Every page the conversation has seen gets a number, [n], that the model
    // cites it by and the chat turns into a link. Numbers carry over from
    // earlier turns (see rememberSources), so [2] names one page throughout.
    this.sources = new Map()
    this.nextSource = 1
  }

  getToolSpecs() {
    return webToolSpecs(this.settings.type, { resultsPerSearch: this.settings.resultsPerSearch })
  }

  /** Picks up the source numbers earlier turns of the conversation handed out. */
  rememberSources(transcript) {
    for (const entry of Array.isArray(transcript) ? transcript : []) {
      for (const call of Array.isArray(entry?.toolCalls) ? entry.toolCalls : []) {
        const result = call?.result
        if (!result || typeof result !== 'object') continue
        const items =
          call.name === 'web_search' && Array.isArray(result.results)
            ? result.results
            : call.name === 'web_fetch'
              ? [result]
              : []
        for (const item of items) {
          if (Number.isInteger(item?.source) && typeof item.url === 'string') {
            this._source(item.url, item, item.source)
          }
        }
      }
    }
  }

  _source(url, info = {}, number) {
    const key = sourceKey(url)
    let source = this.sources.get(key)
    if (!source) {
      const n = Number.isInteger(number) && number > 0 ? number : this.nextSource
      source = { n, url }
      this.sources.set(key, source)
      this.nextSource = Math.max(this.nextSource, n + 1)
    }
    for (const field of ['title', 'snippet', 'published']) {
      if (info[field] && !source[field]) source[field] = info[field]
    }
    return source
  }

  /** Tool failures come back as `{ error }` for the model, like project tools. */
  async execute(name, args = {}, { signal } = {}) {
    try {
      if (name === 'web_search') return await this.search(args, { signal })
      if (name === 'web_fetch') return await this.fetch(args, { signal })
      return { error: `Unknown tool: ${name}` }
    } catch (err) {
      const error = err?.message || 'The web request failed.'
      if (name !== 'web_fetch' || err?.code === 'aborted') return { error }
      return this._fetchFailure(args, error)
    }
  }

  /**
   * A page that cannot be read is not a dead end when a search already
   * returned it: hand back what the search said about it, so the model can
   * answer from that or move on to the next result.
   */
  _fetchFailure(args, error) {
    const url = typeof args?.url === 'string' ? args.url.trim() : ''
    const known = url ? this.sources.get(sourceKey(/^https?:/i.test(url) ? url : `https://${url}`)) : null
    if (!known) return { error, ...(url ? { url } : {}) }
    return {
      error: `${error} ${known.snippet ? 'Its search snippet is included; rely on it only for what it states, or read another result.' : 'Read another result instead.'}`,
      source: known.n,
      url: known.url,
      ...(known.title ? { title: known.title } : {}),
      ...(known.published ? { published: known.published } : {}),
      ...(known.snippet ? { snippet: known.snippet } : {}),
    }
  }

  async search(args, { signal, useCache = true } = {}) {
    const query = collapse(typeof args?.query === 'string' ? args.query : '')
    if (!query) return { error: 'web_search needs a query.' }
    const limit = this.settings.resultsPerSearch ?? WEB_SEARCH_DEFAULTS.resultsPerSearch
    const maxResults = clampInt(args?.maxResults, 1, limit, limit)
    const searxng = this.settings.type === 'searxng'
    const recency = searxng ? normalizeRecency(args?.recency) : ''
    const topic =
      searxng && String(args?.topic ?? '').trim().toLowerCase() === 'news' ? 'news' : ''

    const cacheKey = JSON.stringify([
      this.settings.type,
      this.settings.baseUrl ?? '',
      query.toLowerCase(),
      maxResults,
      recency,
      topic,
    ])

    const ownerCaches = getOwnerCaches(this.cacheOwner)
    const cacheHours = this.settings.cacheHours ?? WEB_SEARCH_DEFAULTS.cacheHours
    const shouldUseCache = useCache && cacheHours > 0

    const maxAgeMs =
      recency || topic
        ? Math.min(cacheHours * HOUR_MS, RECENT_SEARCH_TTL_MS)
        : cacheHours * HOUR_MS
    let found = shouldUseCache ? ownerCaches.searches.get(cacheKey, maxAgeMs) : null
    if (!found) {
      found = searxng
        ? await this._searxngSearch(query, maxResults, { recency, topic }, signal)
        : await this._ollamaSearch(query, maxResults, signal)
      // An empty answer is as likely a flaky engine as a real miss
      if (found.results.length > 0 && shouldUseCache) {
        ownerCaches.searches.set(cacheKey, found)
      }
    }

    return {
      provider: this.settings.type,
      query,
      ...(recency ? { recency } : {}),
      ...(topic ? { topic } : {}),
      ...(found.relaxed ? { relaxed: true } : {}),
      results: found.results.map(result => ({
        source: this._source(result.url, result).n,
        ...result,
      })),
      ...(found.answers?.length ? { answers: found.answers } : {}),
    }
  }

  async fetch(args, { signal } = {}) {
    const rawUrl = typeof args?.url === 'string' ? args.url.trim() : ''
    if (!rawUrl) return { error: 'web_fetch needs a url.' }
    let url
    try {
      // "ctan.org/pkg/siunitx" is a URL to anyone reading it; accept it.
      url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(rawUrl) ? rawUrl : `https://${rawUrl}`)
    } catch {
      return { error: `Not a valid URL: ${rawUrl}` }
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { error: `Only http and https URLs can be fetched, not ${url.protocol}` }
    }
    url.hash = ''

    const doc = await this._document(url.toString(), signal)
    const source = this._source(url.toString(), doc)
    // A redirect lands on another address for the same page
    if (!this.sources.has(sourceKey(doc.url))) this.sources.set(sourceKey(doc.url), source)
    const totalPages = doc.pages.length
    const base = {
      source: source.n,
      url: doc.url,
      ...(doc.title ? { title: doc.title } : {}),
      ...(doc.published ? { published: doc.published } : {}),
      ...(doc.modified ? { modified: doc.modified } : {}),
      ...(doc.archived ? { archived: doc.archived, archiveUrl: doc.archiveUrl } : {}),
      totalPages,
      ...(doc.truncated ? { truncated: true } : {}),
    }

    const find = typeof args?.find === 'string' ? args.find.trim() : ''
    if (find) {
      const { matches, total, term } = findPassages(doc, find)
      return { ...base, find: term, matches, totalMatches: total }
    }

    const page = clampInt(args?.page, 1, Number.MAX_SAFE_INTEGER, 1)
    if (page > totalPages) {
      return {
        error: `${doc.url} has ${totalPages} page${totalPages === 1 ? '' : 's'}; there is no page ${page}.`,
      }
    }
    return { ...base, page, content: pageText(doc, page) }
  }

  async _document(url, signal) {
    const key = `${this.settings.type}:${url}`
    const cacheHours = this.settings.cacheHours ?? WEB_SEARCH_DEFAULTS.cacheHours
    const ownerCaches = getOwnerCaches(this.cacheOwner)

    if (cacheHours > 0) {
      const cached = ownerCaches.documents.get(key, cacheHours * HOUR_MS)
      if (cached) return cached
    }

    const doc = await this._read(url, signal)
    if (cacheHours > 0) {
      ownerCaches.documents.set(key, doc)
    }
    return doc
  }

  /**
   * The page by the first route that works: the configured reader, then (for
   * Ollama) this server reading it directly, then the page's latest copy in
   * the Internet Archive. Only a refusal, an HTTP error or a network failure
   * moves on to the next route; a PDF or a private address would fail the same
   * way everywhere.
   */
  async _read(url, signal) {
    const routes = [
      ...(this.settings.type === 'ollama' ? [() => this._ollamaDocument(url, signal)] : []),
      () => this._directDocument(url, signal),
      () => this._archivedDocument(url, signal),
    ]
    let first
    for (const route of routes) {
      try {
        return await route()
      } catch (err) {
        if (err?.code === 'aborted' || !isRetryableFailure(err)) throw err
        first ??= err
      }
    }
    throw webError(`${first.message.replace(/\.$/, '')}, and no archived copy could be read.`, {
      status: first.status,
      kind: first.kind,
    })
  }

  async _ollamaDocument(url, signal) {
    try {
      const body = await this._postOllama('web_fetch', { url }, signal)
      return makeDocument({
        url,
        title: typeof body?.title === 'string' ? body.title : '',
        text: typeof body?.content === 'string' ? body.content : '',
      })
    } catch (err) {
      // A rejected key or the rate limit is Ollama's own problem and would
      // fail the same way again; anything else is about the page.
      if (![401, 403, 429].includes(err?.status) && err?.code !== 'aborted') err.kind = 'http'
      throw err
    }
  }

  async _directDocument(url, signal) {
    let response
    try {
      response = await this.fetchPage(url, { signal })
    } catch (err) {
      if (!REFUSED_STATUSES.has(err?.status)) throw err
      response = await this.fetchPage(url, { signal, headers: BROWSER_HEADERS })
    }
    return documentFromResponse(response)
  }

  async _archivedDocument(url, signal) {
    try {
      const lookup = new URL(WAYBACK_LOOKUP)
      lookup.searchParams.set('url', url)
      const answer = await this.fetchPage(lookup.toString(), { signal, maxBytes: 64 * 1024 })
      const closest = JSON.parse(answer.body.toString('utf8'))?.archived_snapshots?.closest
      const stamp =
        closest?.available && String(closest.status ?? '200') === '200'
          ? /^\d{14}$/.exec(String(closest.timestamp ?? ''))?.[0]
          : null
      if (!stamp) throw webError(`${url} has no archived copy.`)
      // id_ asks for the page as it was captured, without the archive's toolbar
      const snapshot = await this.fetchPage(`https://web.archive.org/web/${stamp}id_/${url}`, {
        signal,
      })
      return {
        ...documentFromResponse({ ...snapshot, url }),
        archived: isoDay(stamp),
        archiveUrl: `https://web.archive.org/web/${stamp}/${url}`,
      }
    } catch (err) {
      if (err?.code === 'aborted') throw err
      throw webError(err?.message || `${url} has no archived copy.`, { kind: 'network' })
    }
  }

  async _request(url, init, signal, label) {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const combined = AbortSignal.any([signal, timeout].filter(Boolean))
    let res
    try {
      res = await fetchWithRetry(
        url,
        { ...init, signal: combined },
        { maxRetries: 2, fetchFn: this.fetchFn }
      )
    } catch (err) {
      if (signal?.aborted) throw new ProviderError('Request was cancelled', { code: 'aborted' })
      if (timeout.aborted) {
        throw webError(`${label} did not answer within ${REQUEST_TIMEOUT_MS / 1000}s.`, {
          kind: 'network',
        })
      }
      throw webError(
        `Could not reach ${label}: ${err?.cause?.code || err?.message || 'network error'}.`,
        { kind: 'network' }
      )
    }
    if (!res.ok) throw await upstreamError(res, label, this.settings.type)
    return res
  }

  async _postOllama(endpoint, payload, signal) {
    const res = await this._request(
      `${OLLAMA_API_BASE}/${endpoint}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.settings.apiKey}`,
        },
        body: JSON.stringify(payload),
      },
      signal,
      'Ollama web search'
    )
    try {
      return await res.json()
    } catch {
      throw webError('Ollama web search returned a response that is not JSON.')
    }
  }

  async _ollamaSearch(query, maxResults, signal) {
    const body = await this._postOllama('web_search', { query, max_results: maxResults }, signal)
    return { results: normalizeResults(body?.results, maxResults, query) }
  }

  async _searxngSearch(query, maxResults, { recency = '', topic = '' } = {}, signal) {
    const url = new URL(`${resolveDockerHostUrl(this.settings.baseUrl)}/search`)
    url.searchParams.set('q', query)
    url.searchParams.set('format', 'json')
    if (recency) url.searchParams.set('time_range', recency)
    if (topic === 'news') url.searchParams.set('categories', 'news')
    const res = await this._request(
      url.toString(),
      { headers: { Accept: 'application/json' } },
      signal,
      'SearXNG'
    )
    let body
    try {
      body = await res.json()
    } catch {
      throw webError(
        'SearXNG did not return JSON. Add "json" to search.formats in its settings.yml.'
      )
    }
    const results = normalizeResults(body?.results, maxResults, query)
    // Not every engine supports a time range or has a news index, and one
    // that does not answers with nothing. Nothing is not an answer to a
    // question about the present, so fall back to the plain search.
    if (results.length === 0 && (recency || topic)) {
      return { ...(await this._searxngSearch(query, maxResults, {}, signal)), relaxed: true }
    }
    const answers = (Array.isArray(body?.answers) ? body.answers : [])
      .map(answer => (typeof answer === 'string' ? answer : answer?.answer))
      .filter(answer => typeof answer === 'string' && answer.trim())
      .slice(0, 3)
      .map(answer => clip(collapse(answer), 500))
    return { results, answers }
  }
}

/** Runs one small search, for the settings form's connection test. */
export async function testWebSearch(settings, { signal, fetchFn } = {}) {
  const tools = new AiAssistWebTools(settings, fetchFn ? { fetchFn } : {})
  const startedAt = Date.now()
  const result = await tools.search({ query: 'LaTeX', maxResults: 1 }, { signal, useCache: false })
  return { latencyMs: Date.now() - startedAt, resultCount: result.results.length }
}
