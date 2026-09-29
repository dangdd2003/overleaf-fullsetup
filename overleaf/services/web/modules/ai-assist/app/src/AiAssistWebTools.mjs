import {
  ProviderError,
  resolveDockerHostUrl,
  validateSafeProviderBaseUrl,
} from './AiAssistProviders.mjs'
import {
  HOUR_MS,
  clampInt,
  clip,
  collapse,
  isoDay,
  webError,
} from './web-fetch/util.mjs'
import { apiRequest } from './web-fetch/api.mjs'
import { pageCharsFor, pageText } from './web-fetch/document.mjs'
import { documentIndex } from './web-fetch/doc-index.mjs'
import { findPassages } from './web-fetch/find.mjs'
import { REQUEST_TIMEOUT_MS, fetchPublicUrl } from './web-fetch/transport.mjs'
import { WebFetcher } from './web-fetch/WebFetcher.mjs'
import { sharedBrowserRoute } from './web-fetch/routes/browser.mjs'
import {
  JINA_SEARCH_BASE,
  OLLAMA_API_BASE,
  TAVILY_API_BASE,
  WEBSEARCHAPI_BASE,
  exaTimeoutMs,
  firecrawlRequest,
  firecrawlScrapeOptions,
  firecrawlTimeoutMs,
  jinaTimeoutMs,
  tavilyHeaders,
} from './web-fetch/routes/readers.mjs'
import { WebRouter, clearEndpointHealth } from './web-fetch/routing.mjs'
import { clearWebCacheStore, ownerWebCaches } from './web-fetch/cache-store.mjs'
import { JINA_COUNTRIES, JINA_LANGUAGES } from './web-fetch/jina-codes.mjs'
import { cacheKeyFor } from './web-fetch/urls.mjs'

export { openWebCache } from './web-fetch/cache-store.mjs'
export {
  WebRouter,
  WebRouter as EndpointRotator,
  clearEndpointHealth,
} from './web-fetch/routing.mjs'
export {
  PAGE_CHARS,
  documentFromResponse,
  splitPages,
} from './web-fetch/document.mjs'
export { findPassages } from './web-fetch/find.mjs'
export { extractPageDates, htmlToMarkdown } from './web-fetch/extract/html.mjs'
export {
  fetchPublicUrl,
  guardedLookup,
  isPublicAddress,
} from './web-fetch/transport.mjs'
export { isoDay } from './web-fetch/util.mjs'

/**
 * Web research for the agent: `web_search` and `web_fetch`.
 *
 * Ollama's, WebSearchAPI.ai's, Tavily's, Firecrawl's and Jina's hosted APIs
 * each answer both tools, as does a self-hosted Firecrawl instance. A self-hosted
 * SearXNG instance answers searches, and this server then reads pages itself.
 *
 * Every request leaves from the Overleaf server, like the provider calls, so a
 * SearXNG instance on the internal network works behind a public domain. The
 * pages web_fetch reads are the opposite case: the model picks the URL, and a
 * page it read earlier can steer that pick, so a direct fetch may only connect
 * to public addresses. The check runs at connect time on the address actually
 * dialled, so a DNS answer that changes between check and connect cannot slip
 * through.
 */

export const WEB_SEARCH_PROVIDERS = [
  'searxng',
  'ollama',
  'websearchapi',
  'tavily',
  'firecrawl',
  'firecrawlSelfHosted',
  'jina',
  'langsearch',
  'exa',
]
export const WEB_TOOL_NAMES = new Set(['web_search', 'web_fetch'])
export const WEB_SEARCH_ROTATION_STRATEGIES = [
  'round-robin',
  'provider-priority',
  'sticky',
]
export const WEB_SEARCH_PRIMARY_PROVIDERS = [
  'searxng',
  'ollama',
  'websearchapi',
  'tavily',
  'firecrawl',
  'firecrawlSelfHosted',
  'jina',
  'langsearch',
  'exa',
]
/** Providers that answer web_search. */
export const SEARCH_PROVIDERS = new Set([
  'searxng',
  'ollama',
  'websearchapi',
  'tavily',
  'firecrawl',
  'firecrawlSelfHosted',
  'jina',
  'langsearch',
  'exa',
])

export const WEB_SEARCH_DEFAULTS = {
  cacheHours: 24,
  maxCachedSearches: 256,
  maxCachedPages: 64,
}

export const LANGSEARCH_API_BASE = 'https://api.langsearch.com'
export const EXA_API_BASE = 'https://api.exa.ai'

/** Settings for a run with no search backend: web_fetch only, default caching. */
export function fetchOnlyWebSettings() {
  return { providers: {}, ...WEB_SEARCH_DEFAULTS }
}

/** Ollama's web search returns at most 10 results. */
const OLLAMA_MAX_RESULTS = 10
/**
 * How many results a provider that takes a count is asked for when the user
 * has not set one. SearXNG takes no count and keeps all it finds.
 */
const DEFAULT_RESULTS = 10
/** The Search API answers 1 to 20 results per request. */
const WEBSEARCHAPI_MAX_RESULTS = 20
const WEBSEARCHAPI_LENGTHS = ['short', 'medium', 'long']
const WEBSEARCHAPI_ENGINES = ['direct', 'browser', 'cf-browser-rendering']
/** Tavily's Search API answers 0 to 20 results per request. */
const TAVILY_MAX_RESULTS = 20
const TAVILY_DEPTHS = ['basic', 'advanced', 'fast', 'ultra-fast']
const TAVILY_TOPICS = ['general', 'news', 'finance']
/** Firecrawl's Search API answers 1 to 100 results per request. */
const FIRECRAWL_MAX_RESULTS = 100
// Not research: from 2026-11-16 it answers paper records outside data.web
const FIRECRAWL_CATEGORIES = ['developer', 'pdf']
/** Each one's initial is its `qdr:` code in Firecrawl's tbs parameter. */
const FIRECRAWL_TIME_RANGES = ['hour', 'day', 'week', 'month', 'year']
const FIRECRAWL_PROXIES = ['basic', 'enhanced', 'auto']
const FIRECRAWL_SOURCES = ['web', 'news']
const FIRECRAWL_PDF_MODES = ['fast', 'auto', 'ocr']
/** Jina's Search API answers 0 to 20 results per request. */
const JINA_MAX_RESULTS = 20
const JINA_ENGINES = ['browser', 'direct', 'cf-browser-rendering']
/** LangSearch's Search API answers 1 to 50 results per request. */
const LANGSEARCH_MAX_RESULTS = 50
const LANGSEARCH_FRESHNESS = [
  'noLimit',
  'oneDay',
  'oneWeek',
  'oneMonth',
  'oneYear',
]
/** Exa's Search API answers 1 to 100 results per request. */
const EXA_MAX_RESULTS = 100
const EXA_SEARCH_TYPES = ['auto', 'neural', 'keyword', 'fast', 'deep']
const EXA_SEARCH_CATEGORIES = [
  'company',
  'research paper',
  'news',
  'pdf',
  'github',
  'tweet',
  'personal site',
  'linkedin profile',
  'financial report',
]
const EXA_LIVECRAWL_MODES = ['always', 'fallback', 'never', 'auto']
const MAX_SNIPPET_CHARS = 600
const RECENCY_VALUES = ['day', 'week', 'month', 'year']

function settingsError(message) {
  return new ProviderError(message, {
    code: 'invalidWebSearchSettings',
    status: 400,
  })
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

/**
 * A query as the search cache keys it. Case, spacing, the hyphen or
 * underscore joining two words and trailing punctuation do not change what an
 * engine returns; quotes, a leading minus, site: and symbols like C++ do, so
 * they stay.
 */
export function searchCacheText(query) {
  return collapse(
    String(query ?? '')
      .toLowerCase()
      .replace(/(?<=[\p{L}\p{N}])[-_]+(?=[\p{L}\p{N}])/gu, ' ')
      .replace(/[,;!?]+|\.+(?=\s|$)/gu, ' ')
  )
}

const SNIPPET_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'what',
  'about',
  'how',
  'news',
  'latest',
  'today',
  'current',
  'recent',
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
  parsed.pathname = parsed.pathname
    .replace(/\/search\/?$/, '')
    .replace(/\/+$/, '')
  return parsed.toString().replace(/\/+$/, '')
}

/**
 * A self-hosted Firecrawl's API lives at `<instance>/v2`. The address is
 * accepted with or without the version path.
 */
export function normalizeFirecrawlBaseUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return ''
  let value = raw.trim()
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `http://${value}`
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw settingsError('The Firecrawl URL is not a valid URL.')
  }
  parsed.search = ''
  parsed.hash = ''
  parsed.pathname = parsed.pathname
    .replace(/\/v[12](\/.*)?$/, '')
    .replace(/\/+$/, '')
  return parsed.toString().replace(/\/+$/, '')
}

/**
 * Validates the web search settings a client sent with a run. Returns null
 * when none were sent, which leaves the web tools out of the run.
 */
function clampCacheParam(value, min, max, defaultValue) {
  const num =
    typeof value === 'string'
      ? parseInt(value, 10)
      : typeof value === 'number'
        ? value
        : null
  if (num === null || Number.isNaN(num)) return defaultValue
  return Math.max(min, Math.min(max, num))
}

function optionalChoice(value, choices) {
  return choices.includes(value) ? value : undefined
}

function optionalFlag(value) {
  return typeof value === 'boolean' ? value : undefined
}

function optionalText(value, pattern, max = 200) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text && text.length <= max && (!pattern || pattern.test(text))
    ? text
    : undefined
}

/** "https://www.arxiv.org/abs" and "arxiv.org" both name the domain arxiv.org. */
function domainList(value, max = 50) {
  if (!Array.isArray(value)) return undefined
  const domains = new Set()
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const domain = entry
      .trim()
      .toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
      .replace(/[/?#].*$/, '')
    if (/^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/.test(domain)) {
      domains.add(domain)
    }
    if (domains.size >= max) break
  }
  return domains.size > 0 ? [...domains] : undefined
}

function withoutUndefined(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined)
  )
}

/**
 * The WebSearchAPI.ai request options a user chose, keeping only valid values.
 * An option left out is left to the API's own default.
 */
export function normalizeWebsearchapiOptions(raw = {}) {
  const rawSearch =
    raw?.search && typeof raw.search === 'object' ? raw.search : {}
  const rawScrape =
    raw?.scrape && typeof raw.scrape === 'object' ? raw.scrape : {}
  const timeout = Number.isInteger(rawScrape.timeout)
    ? Math.min(120, Math.max(1, rawScrape.timeout))
    : undefined
  const search = withoutUndefined({
    maxResults: Number.isInteger(rawSearch.maxResults)
      ? Math.min(WEBSEARCHAPI_MAX_RESULTS, Math.max(1, rawSearch.maxResults))
      : undefined,
    country: optionalText(rawSearch.country, /^[a-z]{2}$/i)?.toLowerCase(),
    language: optionalText(rawSearch.language, /^[a-z]{2}$/i)?.toLowerCase(),
    sortBy: optionalChoice(rawSearch.sortBy, ['relevance', 'date']),
    safeSearch: optionalFlag(rawSearch.safeSearch),
    includeDomains: domainList(rawSearch.includeDomains),
    excludeDomains: domainList(rawSearch.excludeDomains),
    includeContent: optionalFlag(rawSearch.includeContent),
    contentLength: optionalChoice(
      rawSearch.contentLength,
      WEBSEARCHAPI_LENGTHS
    ),
    includeAnswer: optionalFlag(rawSearch.includeAnswer),
    answerLength: optionalChoice(rawSearch.answerLength, WEBSEARCHAPI_LENGTHS),
    timeframe: optionalChoice(rawSearch.timeframe, RECENCY_VALUES),
    siteSearch: domainList([rawSearch.siteSearch], 1)?.[0],
    exactTerms: optionalText(rawSearch.exactTerms),
    excludeTerms: optionalText(rawSearch.excludeTerms),
    fileType: optionalText(
      rawSearch.fileType,
      /^[a-z0-9]{1,10}$/i
    )?.toLowerCase(),
  })
  const scrape = withoutUndefined({
    engine: optionalChoice(rawScrape.engine, WEBSEARCHAPI_ENGINES),
    timeout,
    tokenBudget: Number.isInteger(rawScrape.tokenBudget)
      ? Math.min(1_000_000, Math.max(100, rawScrape.tokenBudget))
      : undefined,
    retainImages: optionalChoice(rawScrape.retainImages, ['all', 'none']),
    targetSelector: optionalText(rawScrape.targetSelector, null, 500),
    removeSelector: optionalText(rawScrape.removeSelector, null, 500),
    respondWith: optionalChoice(rawScrape.respondWith, [
      'default',
      'readerlm-v2',
    ]),
    proxy: optionalText(
      rawScrape.proxy,
      /^(auto|none|[a-z]{2})$/i
    )?.toLowerCase(),
    locale: optionalText(rawScrape.locale, /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i),
    withGeneratedAlt: optionalFlag(rawScrape.withGeneratedAlt),
    withIframe: optionalFlag(rawScrape.withIframe),
    withShadowDom: optionalFlag(rawScrape.withShadowDom),
    noCache: optionalFlag(rawScrape.noCache),
    dnt: optionalFlag(rawScrape.dnt),
  })
  return {
    ...(Object.keys(search).length > 0 ? { search } : {}),
    ...(Object.keys(scrape).length > 0 ? { scrape } : {}),
  }
}

/**
 * The Tavily request options a user chose, keeping only valid values and
 * dropping combinations the API refuses. An option left out is left to the
 * API's own default.
 */
export function normalizeTavilyOptions(raw = {}) {
  const rawSearch =
    raw?.search && typeof raw.search === 'object' ? raw.search : {}
  const rawExtract =
    raw?.extract && typeof raw.extract === 'object' ? raw.extract : {}
  const depth = optionalChoice(rawSearch.searchDepth, TAVILY_DEPTHS)
  const quick = depth === 'fast' || depth === 'ultra-fast'
  const topic = optionalChoice(rawSearch.topic, TAVILY_TOPICS)
  const includeDomains = domainList(rawSearch.includeDomains, 300)
  const language = optionalText(
    rawSearch.language,
    /^[a-z][a-z -]{1,30}$/i
  )?.toLowerCase()
  const day = value => optionalText(value, /^\d{4}-\d{2}-\d{2}$/)
  const search = withoutUndefined({
    maxResults: Number.isInteger(rawSearch.maxResults)
      ? Math.min(TAVILY_MAX_RESULTS, Math.max(1, rawSearch.maxResults))
      : undefined,
    searchDepth: depth,
    // Snippets come as one summary per page at ultra-fast
    chunksPerSource:
      Number.isInteger(rawSearch.chunksPerSource) && depth !== 'ultra-fast'
        ? Math.min(3, Math.max(1, rawSearch.chunksPerSource))
        : undefined,
    topic,
    timeRange: optionalChoice(rawSearch.timeRange, RECENCY_VALUES),
    startDate: day(rawSearch.startDate),
    endDate: day(rawSearch.endDate),
    includePublishedDate: optionalFlag(rawSearch.includePublishedDate),
    filterByPublishedDate: optionalFlag(rawSearch.filterByPublishedDate),
    includeAnswer: optionalChoice(rawSearch.includeAnswer, [
      'basic',
      'advanced',
    ]),
    includeRawContent: optionalChoice(rawSearch.includeRawContent, [
      'markdown',
      'text',
    ]),
    includeDomains,
    excludeDomains: domainList(rawSearch.excludeDomains, 150),
    includeDomainsMode: includeDomains
      ? optionalChoice(rawSearch.includeDomainsMode, ['restrict', 'prefer'])
      : undefined,
    // Tavily boosts a country only for general searches
    country:
      !topic || topic === 'general'
        ? optionalText(rawSearch.country, /^[a-z][a-z ]{1,40}$/i)?.toLowerCase()
        : undefined,
    language,
    filterByLanguage: language
      ? optionalFlag(rawSearch.filterByLanguage)
      : undefined,
    autoParameters: optionalFlag(rawSearch.autoParameters),
    exactMatch: optionalFlag(rawSearch.exactMatch),
    safeSearch: quick ? undefined : optionalFlag(rawSearch.safeSearch),
  })
  const extract = withoutUndefined({
    extractDepth: optionalChoice(rawExtract.extractDepth, [
      'basic',
      'advanced',
    ]),
    format: optionalChoice(rawExtract.format, ['markdown', 'text']),
    timeout:
      typeof rawExtract.timeout === 'number' &&
      Number.isFinite(rawExtract.timeout)
        ? Math.min(60, Math.max(1, rawExtract.timeout))
        : undefined,
  })
  const projectId = optionalText(raw?.projectId, /^[\x21-\x7e]+$/)
  return {
    ...(projectId ? { projectId } : {}),
    ...(Object.keys(search).length > 0 ? { search } : {}),
    ...(Object.keys(extract).length > 0 ? { extract } : {}),
  }
}

/** HTML tags or selectors, such as "article" or ".sidebar". */
function selectorList(value, max = 50) {
  if (!Array.isArray(value)) return undefined
  const selectors = [
    ...new Set(
      value
        .map(entry => (typeof entry === 'string' ? entry.trim() : ''))
        .filter(entry => entry && entry.length <= 200)
    ),
  ].slice(0, max)
  return selectors.length > 0 ? selectors : undefined
}

/**
 * The Firecrawl request options a user chose, keeping only valid values and
 * dropping combinations the API refuses. An option left out is left to the
 * API's own default. Proxies are a Firecrawl Cloud service, so a self-hosted
 * instance is never asked for one.
 */
export function normalizeFirecrawlOptions(raw = {}, { cloud = true } = {}) {
  const rawSearch =
    raw?.search && typeof raw.search === 'object' ? raw.search : {}
  const rawScrape =
    raw?.scrape && typeof raw.scrape === 'object' ? raw.scrape : {}
  const timeout = value =>
    Number.isInteger(value)
      ? Math.min(300_000, Math.max(1000, value))
      : undefined
  const categories = Array.isArray(rawSearch.categories)
    ? [...new Set(rawSearch.categories)].filter(category =>
        FIRECRAWL_CATEGORIES.includes(category)
      )
    : []
  const includeDomains = domainList(rawSearch.includeDomains)
  const sources = Array.isArray(rawSearch.sources)
    ? [...new Set(rawSearch.sources)].filter(source =>
        FIRECRAWL_SOURCES.includes(source)
      )
    : []
  const search = withoutUndefined({
    maxResults: Number.isInteger(rawSearch.maxResults)
      ? Math.min(FIRECRAWL_MAX_RESULTS, Math.max(1, rawSearch.maxResults))
      : undefined,
    categories: categories.length > 0 ? categories : undefined,
    timeRange: optionalChoice(rawSearch.timeRange, FIRECRAWL_TIME_RANGES),
    sortByDate: optionalFlag(rawSearch.sortByDate),
    includeDomains,
    // Firecrawl refuses both lists in one search
    excludeDomains: includeDomains
      ? undefined
      : domainList(rawSearch.excludeDomains),
    country: optionalText(rawSearch.country, /^[a-z]{2}$/i)?.toUpperCase(),
    location: optionalText(rawSearch.location),
    safeSearch: optionalFlag(rawSearch.safeSearch),
    scrapeResults: optionalFlag(rawSearch.scrapeResults),
    timeout: timeout(rawSearch.timeout),
    sources: sources.length > 0 ? sources : undefined,
    highlights: optionalFlag(rawSearch.highlights),
  })
  const languages = Array.isArray(rawScrape.languages)
    ? [
        ...new Set(
          rawScrape.languages
            .map(language =>
              optionalText(language, /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i)
            )
            .filter(Boolean)
        ),
      ].slice(0, 10)
    : []
  const scrape = withoutUndefined({
    onlyMainContent: optionalFlag(rawScrape.onlyMainContent),
    onlyCleanContent: optionalFlag(rawScrape.onlyCleanContent),
    maxAge: Number.isInteger(rawScrape.maxAge)
      ? Math.max(0, rawScrape.maxAge)
      : undefined,
    pdfMode: optionalChoice(rawScrape.pdfMode, FIRECRAWL_PDF_MODES),
    country: optionalText(rawScrape.country, /^[a-z]{2}$/i)?.toUpperCase(),
    languages: languages.length > 0 ? languages : undefined,
    includeTags: selectorList(rawScrape.includeTags),
    excludeTags: selectorList(rawScrape.excludeTags),
    waitFor: Number.isInteger(rawScrape.waitFor)
      ? Math.min(60_000, Math.max(0, rawScrape.waitFor))
      : undefined,
    timeout: timeout(rawScrape.timeout),
    mobile: optionalFlag(rawScrape.mobile),
    blockAds: optionalFlag(rawScrape.blockAds),
    proxy: cloud
      ? optionalChoice(rawScrape.proxy, FIRECRAWL_PROXIES)
      : undefined,
    zeroDataRetention: cloud
      ? optionalFlag(rawScrape.zeroDataRetention)
      : undefined,
  })
  return {
    ...(Object.keys(search).length > 0 ? { search } : {}),
    ...(Object.keys(scrape).length > 0 ? { scrape } : {}),
  }
}

/**
 * The Jina request options a user chose, keeping only valid values. An option
 * left out is left to the API's own default. Reader options travel as HTTP
 * headers, so their text must be printable ASCII.
 */
export function normalizeJinaOptions(raw = {}) {
  const rawSearch =
    raw?.search && typeof raw.search === 'object' ? raw.search : {}
  const rawRead = raw?.read && typeof raw.read === 'object' ? raw.read : {}
  const headerText = value => optionalText(value, /^[\x20-\x7e]+$/, 500)
  const country = optionalText(rawSearch.country)?.toLowerCase()
  const language = optionalText(rawSearch.language)?.toLowerCase()
  const respondWith = optionalChoice(rawRead.respondWith, ['readerlm-v2'])
  const search = withoutUndefined({
    maxResults: Number.isInteger(rawSearch.maxResults)
      ? Math.min(JINA_MAX_RESULTS, Math.max(1, rawSearch.maxResults))
      : undefined,
    includeContent: optionalFlag(rawSearch.includeContent),
    type: optionalChoice(rawSearch.type, ['news']),
    country: JINA_COUNTRIES.has(country) ? country : undefined,
    language: JINA_LANGUAGES.get(language),
    location: optionalText(rawSearch.location),
    includeDomains: domainList(rawSearch.includeDomains),
  })
  const read = withoutUndefined({
    engine: optionalChoice(rawRead.engine, JINA_ENGINES),
    timeout: Number.isInteger(rawRead.timeout)
      ? Math.min(180, Math.max(1, rawRead.timeout))
      : undefined,
    targetSelector: headerText(rawRead.targetSelector),
    removeSelector: headerText(rawRead.removeSelector),
    retainImages: optionalChoice(rawRead.retainImages, ['none', 'alt']),
    // Jina ignores it once X-Respond-With is set
    withGeneratedAlt: respondWith
      ? undefined
      : optionalFlag(rawRead.withGeneratedAlt),
    withIframe: optionalFlag(rawRead.withIframe),
    withShadowDom: optionalFlag(rawRead.withShadowDom),
    respondWith,
    proxy: optionalText(
      rawRead.proxy,
      /^(auto|none|[a-z]{2})$/i
    )?.toLowerCase(),
    locale: optionalText(rawRead.locale, /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i),
    noCache: optionalFlag(rawRead.noCache),
    dnt: optionalFlag(rawRead.dnt),
    tokenBudget: Number.isInteger(rawRead.tokenBudget)
      ? Math.max(1, rawRead.tokenBudget)
      : undefined,
    waitForSelector: headerText(rawRead.waitForSelector),
    cacheTolerance: Number.isInteger(rawRead.cacheTolerance)
      ? Math.max(0, rawRead.cacheTolerance)
      : undefined,
  })
  return {
    ...(Object.keys(search).length > 0 ? { search } : {}),
    ...(Object.keys(read).length > 0 ? { read } : {}),
  }
}

/**
 * The LangSearch request options a user chose, keeping only valid values.
 * An option left out is left to the API's own default.
 */
export function normalizeLangsearchOptions(raw = {}) {
  const rawSearch =
    raw?.search && typeof raw.search === 'object' ? raw.search : raw
  const includeDomains = domainList(rawSearch.includeDomains)
  const excludeDomains = domainList(rawSearch.excludeDomains)
  const search = withoutUndefined({
    maxResults: Number.isInteger(rawSearch.maxResults)
      ? Math.min(LANGSEARCH_MAX_RESULTS, Math.max(1, rawSearch.maxResults))
      : undefined,
    freshness: optionalChoice(rawSearch.freshness, LANGSEARCH_FRESHNESS),
    includeDomains,
    excludeDomains,
    includeContent: optionalFlag(rawSearch.includeContent),
    maxCharacters: Number.isInteger(rawSearch.maxCharacters)
      ? Math.min(100_000, Math.max(100, rawSearch.maxCharacters))
      : undefined,
  })
  return Object.keys(search).length > 0 ? { search } : {}
}

/**
 * The Exa request options a user chose, keeping only valid values.
 * An option left out is left to the API's own default.
 */
export function normalizeExaOptions(raw = {}) {
  const rawSearch =
    raw?.search && typeof raw.search === 'object' ? raw.search : {}
  const rawRead =
    raw?.read && typeof raw.read === 'object'
      ? raw.read
      : raw?.contents && typeof raw.contents === 'object'
        ? raw.contents
        : {}

  const stringArray = val => {
    if (Array.isArray(val)) {
      const filtered = val
        .map(t => (typeof t === 'string' ? t.trim() : ''))
        .filter(Boolean)
      return filtered.length > 0 ? filtered : undefined
    }
    if (typeof val === 'string' && val.trim()) {
      const filtered = val
        .split(/[\n,]+/)
        .map(t => t.trim())
        .filter(Boolean)
      return filtered.length > 0 ? filtered : undefined
    }
    return undefined
  }

  const search = withoutUndefined({
    maxResults: Number.isInteger(rawSearch.maxResults)
      ? Math.min(EXA_MAX_RESULTS, Math.max(1, rawSearch.maxResults))
      : undefined,
    type: optionalChoice(rawSearch.type, EXA_SEARCH_TYPES),
    category: optionalChoice(rawSearch.category, EXA_SEARCH_CATEGORIES),
    includeDomains: domainList(rawSearch.includeDomains),
    excludeDomains: domainList(rawSearch.excludeDomains),
    startPublishedDate: optionalText(rawSearch.startPublishedDate),
    endPublishedDate: optionalText(rawSearch.endPublishedDate),
    includeText: stringArray(rawSearch.includeText),
    excludeText: stringArray(rawSearch.excludeText),
    moderation: optionalFlag(rawSearch.moderation),
    includeContent: optionalFlag(rawSearch.includeContent),
    maxCharacters: Number.isInteger(rawSearch.maxCharacters)
      ? Math.min(100_000, Math.max(100, rawSearch.maxCharacters))
      : undefined,
    includeHtmlTags: optionalFlag(rawSearch.includeHtmlTags),
    highlights: optionalFlag(rawSearch.highlights),
    numSentences: Number.isInteger(rawSearch.numSentences)
      ? Math.min(10, Math.max(1, rawSearch.numSentences))
      : undefined,
    highlightsPerUrl: Number.isInteger(rawSearch.highlightsPerUrl)
      ? Math.min(10, Math.max(1, rawSearch.highlightsPerUrl))
      : undefined,
    highlightsQuery: optionalText(rawSearch.highlightsQuery),
    summary: optionalFlag(rawSearch.summary),
    summaryQuery: optionalText(rawSearch.summaryQuery),
    livecrawl: optionalChoice(rawSearch.livecrawl, EXA_LIVECRAWL_MODES),
    livecrawlTimeout: Number.isInteger(rawSearch.livecrawlTimeout)
      ? Math.min(60_000, Math.max(1000, rawSearch.livecrawlTimeout))
      : undefined,
    subpages: Number.isInteger(rawSearch.subpages)
      ? Math.min(10, Math.max(1, rawSearch.subpages))
      : undefined,
    subpageTarget: optionalText(rawSearch.subpageTarget),
  })

  const read = withoutUndefined({
    maxCharacters: Number.isInteger(rawRead.maxCharacters)
      ? Math.min(100_000, Math.max(100, rawRead.maxCharacters))
      : undefined,
    includeHtmlTags: optionalFlag(rawRead.includeHtmlTags),
    highlights: optionalFlag(rawRead.highlights),
    numSentences: Number.isInteger(rawRead.numSentences)
      ? Math.min(10, Math.max(1, rawRead.numSentences))
      : undefined,
    highlightsPerUrl: Number.isInteger(rawRead.highlightsPerUrl)
      ? Math.min(10, Math.max(1, rawRead.highlightsPerUrl))
      : undefined,
    highlightsQuery: optionalText(rawRead.highlightsQuery),
    summary: optionalFlag(rawRead.summary),
    summaryQuery: optionalText(rawRead.summaryQuery),
    livecrawl: optionalChoice(rawRead.livecrawl, EXA_LIVECRAWL_MODES),
    livecrawlTimeout: Number.isInteger(rawRead.livecrawlTimeout)
      ? Math.min(60_000, Math.max(1000, rawRead.livecrawlTimeout))
      : undefined,
    subpages: Number.isInteger(rawRead.subpages)
      ? Math.min(10, Math.max(1, rawRead.subpages))
      : undefined,
    subpageTarget: optionalText(rawRead.subpageTarget),
  })

  return {
    ...(Object.keys(search).length > 0 ? { search } : {}),
    ...(Object.keys(read).length > 0 ? { read } : {}),
  }
}

export function normalizeWebSearchSettings(raw) {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object')
    throw settingsError('Invalid web search settings.')

  // Extract cache configuration parameters
  const cacheHours = clampCacheParam(
    raw.cacheHours,
    0,
    168,
    WEB_SEARCH_DEFAULTS.cacheHours
  )
  const maxCachedSearches = clampCacheParam(
    raw.maxCachedSearches,
    0,
    1000,
    WEB_SEARCH_DEFAULTS.maxCachedSearches
  )
  const maxCachedPages = clampCacheParam(
    raw.maxCachedPages,
    0,
    200,
    WEB_SEARCH_DEFAULTS.maxCachedPages
  )
  const preferences = {
    cacheHours,
    maxCachedSearches,
    maxCachedPages,
  }

  // Legacy single-provider format
  if (typeof raw.type === 'string') {
    const type = raw.type.trim()
    if (!WEB_SEARCH_PROVIDERS.includes(type)) {
      throw settingsError(`Unknown web search provider '${type}'.`)
    }

    if (type === 'searxng') {
      const baseUrl = normalizeSearxngBaseUrl(raw.baseUrl)
      if (!baseUrl)
        throw settingsError(
          'SearXNG web search needs the URL of your instance.'
        )
      validateSafeProviderBaseUrl(baseUrl)
      return {
        type: 'searxng',
        baseUrl,
        ...preferences,
      }
    }

    if (type === 'firecrawlSelfHosted') {
      const baseUrl = normalizeFirecrawlBaseUrl(raw.baseUrl)
      if (!baseUrl)
        throw settingsError(
          'Firecrawl web search needs the URL of your instance.'
        )
      validateSafeProviderBaseUrl(baseUrl)
      return {
        type: 'firecrawlSelfHosted',
        baseUrl,
        ...preferences,
      }
    }

    const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : ''
    if (!apiKey) {
      const label =
        type === 'ollama'
          ? 'Ollama'
          : type === 'websearchapi'
            ? 'WebSearchAPI.ai'
            : type === 'tavily'
              ? 'Tavily'
              : type === 'firecrawl'
                ? 'Firecrawl'
                : type === 'jina'
                  ? 'Jina AI'
                  : type === 'langsearch'
                    ? 'LangSearch'
                    : type === 'exa'
                      ? 'Exa'
                      : type
      const help =
        type === 'ollama' ? ' from https://ollama.com/settings/keys.' : '.'
      throw settingsError(`${label} web search needs an API key${help}`)
    }
    return {
      type,
      apiKey,
      ...preferences,
    }
  }

  // Multi-provider format
  if (raw.providers && typeof raw.providers === 'object') {
    const rawOllama = raw.providers.ollama
    const rawSearxng = raw.providers.searxng
    const rawWebsearchapi = raw.providers.websearchapi
    const rawTavily = raw.providers.tavily
    const rawJina = raw.providers.jina
    const rawFirecrawl = raw.providers.firecrawl
    const rawLangsearch = raw.providers.langsearch
    const rawExa = raw.providers.exa
    const readerKeys = raw =>
      Array.isArray(raw?.apiKeys)
        ? raw.apiKeys
            .map(k => (typeof k === 'string' ? k.trim() : ''))
            .filter(Boolean)
        : []
    const jinaKeys = readerKeys(rawJina)
    const firecrawlKeys = readerKeys(rawFirecrawl)
    const langsearchKeys = readerKeys(rawLangsearch)
    const exaKeys = readerKeys(rawExa)

    const ollamaKeys = Array.isArray(rawOllama?.apiKeys)
      ? rawOllama.apiKeys
          .map(k => (typeof k === 'string' ? k.trim() : ''))
          .filter(Boolean)
      : []
    const websearchapiKeys = Array.isArray(rawWebsearchapi?.apiKeys)
      ? rawWebsearchapi.apiKeys
          .map(k => (typeof k === 'string' ? k.trim() : ''))
          .filter(Boolean)
      : []

    const tavilyKeys = readerKeys(rawTavily)

    const rawUrls = Array.isArray(rawSearxng?.baseUrls)
      ? rawSearxng.baseUrls
      : []

    const searxngUrls = rawUrls
      .map(u => normalizeSearxngBaseUrl(u))
      .filter(Boolean)

    // Validate safe URL for every SearXNG baseUrl
    for (const url of searxngUrls) {
      validateSafeProviderBaseUrl(url)
    }

    const rawFirecrawlSelfHosted = raw.providers.firecrawlSelfHosted
    const firecrawlSelfHostedUrls = (
      Array.isArray(rawFirecrawlSelfHosted?.baseUrls)
        ? rawFirecrawlSelfHosted.baseUrls
        : []
    )
      .map(u => normalizeFirecrawlBaseUrl(u))
      .filter(Boolean)
    for (const url of firecrawlSelfHostedUrls) {
      validateSafeProviderBaseUrl(url)
    }

    const ollamaEnabled = Boolean(rawOllama?.enabled && ollamaKeys.length > 0)
    const ollamaMaxResults = Number.isInteger(rawOllama?.maxResults)
      ? Math.min(OLLAMA_MAX_RESULTS, Math.max(1, rawOllama.maxResults))
      : undefined
    const searxngEnabled = Boolean(
      rawSearxng?.enabled && searxngUrls.length > 0
    )
    const websearchapiEnabled = Boolean(
      rawWebsearchapi?.enabled && websearchapiKeys.length > 0
    )

    const tavilyEnabled = Boolean(rawTavily?.enabled && tavilyKeys.length > 0)
    const firecrawlEnabled = Boolean(
      rawFirecrawl?.enabled && firecrawlKeys.length > 0
    )
    const firecrawlSelfHostedEnabled = Boolean(
      rawFirecrawlSelfHosted?.enabled && firecrawlSelfHostedUrls.length > 0
    )
    const jinaEnabled = Boolean(rawJina?.enabled && jinaKeys.length > 0)
    const langsearchEnabled = Boolean(
      rawLangsearch?.enabled && langsearchKeys.length > 0
    )
    const exaEnabled = Boolean(rawExa?.enabled && exaKeys.length > 0)

    if (
      !ollamaEnabled &&
      !searxngEnabled &&
      !websearchapiEnabled &&
      !tavilyEnabled &&
      !firecrawlEnabled &&
      !firecrawlSelfHostedEnabled &&
      !jinaEnabled &&
      !langsearchEnabled &&
      !exaEnabled
    ) {
      return null
    }

    const rotationStrategy = WEB_SEARCH_ROTATION_STRATEGIES.includes(
      raw.rotationStrategy
    )
      ? raw.rotationStrategy
      : 'round-robin'

    const primaryProvider = WEB_SEARCH_PRIMARY_PROVIDERS.includes(
      raw.primaryProvider
    )
      ? raw.primaryProvider
      : 'searxng'

    return {
      type: searxngEnabled
        ? 'searxng'
        : ollamaEnabled
          ? 'ollama'
          : websearchapiEnabled
            ? 'websearchapi'
            : tavilyEnabled
              ? 'tavily'
              : firecrawlEnabled
                ? 'firecrawl'
                : firecrawlSelfHostedEnabled
                  ? 'firecrawlSelfHosted'
                  : jinaEnabled
                    ? 'jina'
                    : langsearchEnabled
                      ? 'langsearch'
                      : 'exa',
      providers: {
        ollama: {
          enabled: ollamaEnabled,
          apiKeys: ollamaKeys,
          ...(ollamaMaxResults ? { maxResults: ollamaMaxResults } : {}),
        },
        websearchapi: {
          enabled: websearchapiEnabled,
          apiKeys: websearchapiKeys,
          ...normalizeWebsearchapiOptions(rawWebsearchapi),
        },
        tavily: {
          enabled: tavilyEnabled,
          apiKeys: tavilyKeys,
          ...normalizeTavilyOptions(rawTavily),
        },
        firecrawl: {
          enabled: firecrawlEnabled,
          apiKeys: firecrawlKeys,
          ...normalizeFirecrawlOptions(rawFirecrawl),
        },
        firecrawlSelfHosted: {
          enabled: firecrawlSelfHostedEnabled,
          baseUrls: firecrawlSelfHostedUrls,
          ...normalizeFirecrawlOptions(rawFirecrawlSelfHosted, {
            cloud: false,
          }),
        },
        jina: {
          enabled: jinaEnabled,
          apiKeys: jinaKeys,
          ...normalizeJinaOptions(rawJina),
        },
        langsearch: {
          enabled: langsearchEnabled,
          apiKeys: langsearchKeys,
          ...normalizeLangsearchOptions(rawLangsearch),
        },
        exa: {
          enabled: exaEnabled,
          apiKeys: exaKeys,
          ...normalizeExaOptions(rawExa),
        },
        searxng: {
          enabled: searxngEnabled,
          baseUrls: searxngUrls,
          ...(typeof rawSearxng?.defaultCategories === 'string' &&
          rawSearxng.defaultCategories.trim()
            ? { defaultCategories: rawSearxng.defaultCategories.trim() }
            : {}),
          ...(typeof rawSearxng?.defaultLanguage === 'string' &&
          rawSearxng.defaultLanguage.trim()
            ? { defaultLanguage: rawSearxng.defaultLanguage.trim() }
            : {}),
          ...withoutUndefined({
            timeRange: optionalChoice(rawSearxng?.timeRange, RECENCY_VALUES),
            safeSearch: optionalChoice(rawSearxng?.safeSearch, [0, 1, 2]),
          }),
        },
      },
      rotationStrategy,
      primaryProvider,
      ...preferences,
    }
  }

  throw settingsError('Invalid web search settings.')
}

export function buildEndpointPool(settings) {
  const pool = []
  if (settings?.providers?.searxng?.enabled) {
    const urls = settings.providers.searxng.baseUrls || []
    urls.forEach((baseUrl, index) => {
      pool.push({
        id: `searxng:${index}`,
        provider: 'searxng',
        baseUrl,
        defaultCategories: settings.providers.searxng.defaultCategories,
        defaultLanguage: settings.providers.searxng.defaultLanguage,
        timeRange: settings.providers.searxng.timeRange,
        safeSearch: settings.providers.searxng.safeSearch,
      })
    })
  }
  if (settings?.providers?.ollama?.enabled) {
    const keys = settings.providers.ollama.apiKeys || []
    keys.forEach((apiKey, index) => {
      pool.push({
        id: `ollama:${index}`,
        provider: 'ollama',
        apiKey,
        maxResults: settings.providers.ollama.maxResults,
      })
    })
  }
  if (settings?.providers?.websearchapi?.enabled) {
    const keys = settings.providers.websearchapi.apiKeys || []
    keys.forEach((apiKey, index) => {
      pool.push({
        id: `websearchapi:${index}`,
        provider: 'websearchapi',
        apiKey,
        search: settings.providers.websearchapi.search,
        scrape: settings.providers.websearchapi.scrape,
      })
    })
  }
  if (settings?.providers?.tavily?.enabled) {
    const {
      apiKeys = [],
      projectId,
      search,
      extract,
    } = settings.providers.tavily
    apiKeys.forEach((apiKey, index) => {
      pool.push({
        id: `tavily:${index}`,
        provider: 'tavily',
        apiKey,
        projectId,
        search,
        extract,
      })
    })
  }
  if (settings?.providers?.firecrawl?.enabled) {
    const { apiKeys = [], search, scrape } = settings.providers.firecrawl
    apiKeys.forEach((apiKey, index) => {
      pool.push({
        id: `firecrawl:${index}`,
        provider: 'firecrawl',
        apiKey,
        search,
        scrape,
      })
    })
  }
  if (settings?.providers?.firecrawlSelfHosted?.enabled) {
    const {
      baseUrls = [],
      search,
      scrape,
    } = settings.providers.firecrawlSelfHosted
    baseUrls.forEach((baseUrl, index) => {
      pool.push({
        id: `firecrawlSelfHosted:${index}`,
        provider: 'firecrawlSelfHosted',
        baseUrl,
        search,
        scrape,
      })
    })
  }
  if (settings?.providers?.jina?.enabled) {
    const { apiKeys = [], search, read } = settings.providers.jina
    apiKeys.forEach((apiKey, index) => {
      pool.push({ id: `jina:${index}`, provider: 'jina', apiKey, search, read })
    })
  }
  if (settings?.providers?.langsearch?.enabled) {
    const { apiKeys = [], search } = settings.providers.langsearch
    apiKeys.forEach((apiKey, index) => {
      pool.push({
        id: `langsearch:${index}`,
        provider: 'langsearch',
        apiKey,
        search,
      })
    })
  }
  if (settings?.providers?.exa?.enabled) {
    const { apiKeys = [], search, read } = settings.providers.exa
    apiKeys.forEach((apiKey, index) => {
      pool.push({
        id: `exa:${index}`,
        provider: 'exa',
        apiKey,
        search,
        read,
      })
    })
  }
  if (pool.length === 0) {
    if (settings?.type === 'searxng' && settings.baseUrl) {
      pool.push({
        id: 'searxng:0',
        provider: 'searxng',
        baseUrl: settings.baseUrl,
      })
    } else if (settings?.type === 'firecrawlSelfHosted' && settings.baseUrl) {
      pool.push({
        id: 'firecrawlSelfHosted:0',
        provider: 'firecrawlSelfHosted',
        baseUrl: settings.baseUrl,
      })
    } else if (
      settings?.type &&
      settings.apiKey &&
      SEARCH_PROVIDERS.has(settings.type)
    ) {
      pool.push({
        id: `${settings.type}:0`,
        provider: settings.type,
        apiKey: settings.apiKey,
      })
    }
  }
  return pool
}

// ---------------------------------------------------------------------------
// Tool specs
// ---------------------------------------------------------------------------

/**
 * The model says what it wants and nothing else. How to get it (categories,
 * language, safe search, result counts, caching) is the user's backend
 * settings, so every provider is offered the same small schema.
 */
const WEB_SEARCH_SPEC = {
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
    },
    required: ['query'],
  },
}

const WEB_FETCH_SPEC = {
  name: 'web_fetch',
  description: `Read a web page, PDF or text file as Markdown. Long documents come in pages, and the result says which page you got and how many there are. Pass find to jump to the passages about a command, option or phrase anywhere in the document, most relevant first, instead of paging through it. A page that blocks automated readers is retried through other routes automatically.`,
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description:
          'The http or https URL to read, usually one from web_search.',
      },
      page: {
        type: 'integer',
        description: 'Which page of a long document to return. Defaults to 1.',
      },
      find: {
        type: 'string',
        description:
          'Words or a phrase to look for. Case, Markdown formatting and hyphens versus spaces do not matter; when no passage has the exact phrase, passages with all its words come back, marked as such. Separate alternatives with " | ", e.g. "range-phrase | range-units".',
      },
    },
    required: ['url'],
  },
}

export const WEB_TOOL_SPECS = [WEB_SEARCH_SPEC, WEB_FETCH_SPEC]

export const MAX_DOCUMENT_CACHE_BYTES = Infinity

/**
 * A user's search and page caches, at the limits the user set. They live in
 * SQLite on the data volume (see web-fetch/cache-store.mjs).
 */
export function getOwnerCaches(
  owner = 'default',
  {
    maxCachedSearches = WEB_SEARCH_DEFAULTS.maxCachedSearches,
    maxCachedPages = WEB_SEARCH_DEFAULTS.maxCachedPages,
  } = {}
) {
  return ownerWebCaches(owner, {
    searches: maxCachedSearches,
    pages: maxCachedPages,
    pageBytes: MAX_DOCUMENT_CACHE_BYTES,
  })
}

export function clearWebDocumentCache() {
  clearWebCacheStore()
  clearEndpointHealth()
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
    const published = isoDay(
      entry.publishedDate ?? entry.published_date ?? entry.pubdate
    )
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

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

export class AiAssistWebTools {
  /**
   * @param {{ type: 'ollama', apiKey: string } | { type: 'searxng', baseUrl: string },
   *          cacheHours, maxCachedSearches, maxCachedPages } settings
   *   Already validated by `normalizeWebSearchSettings`.
   */
  constructor(
    settings,
    {
      fetchFn = fetch,
      fetchPage = fetchPublicUrl,
      cacheOwner = 'default',
      browser = sharedBrowserRoute(),
      contextWindow,
      runJob,
    } = {}
  ) {
    this.settings = settings
    // Extraction-worker jobs, such as indexing a long document
    this.runJob = runJob
    this.fetchFn = fetchFn
    this.fetchPage = fetchPage
    this.cacheOwner = cacheOwner
    // Pages are cut per run, for the model it serves
    this.pageChars = pageCharsFor(contextWindow)
    this.rotator = new WebRouter(settings, { cacheOwner })

    this.caches = getOwnerCaches(cacheOwner, settings)

    this.fetcher = new WebFetcher({
      fetchPage,
      fetchFn,
      rotator: this.rotator,
      browser,
      cache: this.caches.documents,
      cacheHours: settings.cacheHours ?? WEB_SEARCH_DEFAULTS.cacheHours,
    })

    // Every page the conversation has seen gets a number, [n], that the model
    // cites it by and the chat turns into a link. Numbers carry over from
    // earlier turns (see rememberSources), so [2] names one page throughout.
    this.sources = new Map()
    this.nextSource = 1
    // searchCacheText(query) -> the search in flight for it
    this.pending = new Map()
  }

  /** Whether a search backend is configured; page readers alone only read pages. */
  canSearch() {
    return this.rotator.pool.some(e => SEARCH_PROVIDERS.has(e.provider))
  }

  getToolSpecs() {
    return this.canSearch() ? WEB_TOOL_SPECS : [WEB_FETCH_SPEC]
  }

  /** Picks up the source numbers earlier turns of the conversation handed out. */
  rememberSources(transcript) {
    for (const entry of Array.isArray(transcript) ? transcript : []) {
      for (const call of Array.isArray(entry?.toolCalls)
        ? entry.toolCalls
        : []) {
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
      const n =
        Number.isInteger(number) && number > 0 ? number : this.nextSource
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
      if (name === 'web_search') {
        if (!this.canSearch()) {
          return {
            error:
              'Web search is not set up. Read pages with web_fetch instead.',
          }
        }
        return await this._shared(
          searchCacheText(typeof args?.query === 'string' ? args.query : ''),
          () => this.search(args, { signal })
        )
      }
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
    const known = url
      ? this.sources.get(
          sourceKey(/^https?:/i.test(url) ? url : `https://${url}`)
        )
      : null
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

  /**
   * Calls that ask the same thing at the same time, as a model's parallel
   * tool calls can, share one request. Each gets its own copy of the result.
   */
  async _shared(key, run) {
    let pending = this.pending.get(key)
    if (!pending) {
      pending = run().finally(() => this.pending.delete(key))
      this.pending.set(key, pending)
    }
    return structuredClone(await pending)
  }

  async search(args, { signal, useCache = true } = {}) {
    const query = collapse(typeof args?.query === 'string' ? args.query : '')
    if (!query) return { error: 'web_search needs a query.' }

    const cacheKey = JSON.stringify([
      this.settings.type ?? this.settings.rotationStrategy ?? 'round-robin',
      this.settings.baseUrl ?? '',
      this.settings.providers?.websearchapi?.search ?? null,
      this.settings.providers?.tavily?.search ?? null,
      this.settings.providers?.firecrawl?.search ?? null,
      this.settings.providers?.firecrawlSelfHosted?.search ?? null,
      this.settings.providers?.jina?.search ?? null,
      this.settings.providers?.langsearch?.search ?? null,
      this.settings.providers?.exa?.search ?? null,
      this.settings.providers?.ollama?.maxResults ?? null,
      this.settings.providers?.searxng?.timeRange ?? null,
      this.settings.providers?.searxng?.safeSearch ?? null,
      searchCacheText(query),
    ])

    const cacheHours =
      this.settings.cacheHours ?? WEB_SEARCH_DEFAULTS.cacheHours
    const shouldUseCache = useCache && cacheHours > 0

    let found = shouldUseCache
      ? this.caches.searches.get(cacheKey, cacheHours * HOUR_MS)
      : null
    // Pages this user already read that contain every word of the query
    const readPages = shouldUseCache
      ? this.caches.documents.search(query, { maxAgeMs: cacheHours * HOUR_MS })
      : []

    let providerUsed = this.settings.type || 'searxng'

    if (!found) {
      const plan = this.rotator.plan('search')
      const errors = []
      let zeroResultAnswer = null

      outer: for (const { provider, endpoints } of plan) {
        for (const endpoint of endpoints) {
          try {
            let res
            if (provider === 'searxng') {
              res = await this._searxngSearch(query, signal, endpoint)
            } else if (provider === 'websearchapi') {
              res = await this._websearchapiSearch(query, signal, endpoint)
            } else if (provider === 'tavily') {
              res = await this._tavilySearch(query, signal, endpoint)
            } else if (
              provider === 'firecrawl' ||
              provider === 'firecrawlSelfHosted'
            ) {
              res = await this._firecrawlSearch(query, signal, endpoint)
            } else if (provider === 'jina') {
              res = await this._jinaSearch(query, signal, endpoint)
            } else if (provider === 'langsearch') {
              res = await this._langsearchSearch(query, signal, endpoint)
            } else if (provider === 'exa') {
              res = await this._exaSearch(query, signal, endpoint)
            } else {
              res = await this._ollamaSearch(query, signal, endpoint)
            }

            if (res && res.results && res.results.length > 0) {
              this.rotator.success(endpoint, 'search')
              providerUsed = provider
              found = res
              break outer
            }

            // Provider returned zero results: record it and fall through to NEXT PROVIDER (without pausing endpoint)
            zeroResultAnswer = res || { results: [] }
            providerUsed = provider
            break // move to next provider in outer loop
          } catch (err) {
            const failure = this.rotator.failure(endpoint, err)
            errors.push({
              endpoint: endpoint.id,
              message: err?.message || String(err),
            })
            if (failure.class === 'aborted') throw err
            if (failure.skipProvider && !endpoint.baseUrl) {
              // A hosted API's outage: skip remaining keys of this provider.
              // A self-hosted instance's leaves the user's other instances.
              break
            }
            // Key/rate error: try next key of this provider
          }
        }
      }

      if (!found) {
        if (zeroResultAnswer) {
          found = zeroResultAnswer
        } else if (readPages.length > 0) {
          // Every endpoint failed, but pages already read still answer it
          found = { results: [] }
        } else {
          throw webError(
            errors.length > 0
              ? `All web search endpoints failed: ${errors.map(e => `[${e.endpoint}]: ${e.message}`).join('; ')}`
              : 'No web search endpoints available.'
          )
        }
      }

      if (found.results.length > 0 && shouldUseCache) {
        this.caches.searches.set(cacheKey, found)
      }
    }

    // Results this user already read: web_fetch returns them from the cache
    const held = shouldUseCache
      ? this.caches.documents.held(
          found.results.map(result => cacheKeyFor(result.url)),
          cacheHours * HOUR_MS
        )
      : new Set()
    // A page is listed once, even when the cache holds it under two addresses
    const listed = new Set(found.results.map(result => sourceKey(result.url)))
    const results = [
      ...found.results.map(result =>
        held.has(cacheKeyFor(result.url)) ? { ...result, cached: true } : result
      ),
      ...readPages
        .filter(page => {
          const key = sourceKey(page.url)
          if (listed.has(key)) return false
          listed.add(key)
          return true
        })
        .map(page => ({
          title: clip(collapse(page.title || page.url), 200),
          url: page.url,
          ...(page.published ? { published: page.published } : {}),
          snippet: bestSnippet(page.snippet, query),
          cached: true,
        })),
    ]

    return {
      provider: providerUsed,
      query,
      results: results.map(result => ({
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
      url = new URL(
        /^[a-z][a-z0-9+.-]*:/i.test(rawUrl) ? rawUrl : `https://${rawUrl}`
      )
    } catch {
      return { error: `Not a valid URL: ${rawUrl}` }
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return {
        error: `Only http and https URLs can be fetched, not ${url.protocol}`,
      }
    }
    url.hash = ''

    const doc = await this.fetcher.read(url.toString(), { signal })
    const source = this._source(url.toString(), doc)
    // A redirect lands on another address for the same page
    if (!this.sources.has(sourceKey(doc.url)))
      this.sources.set(sourceKey(doc.url), source)
    // A cached document serves any model: its pages are cut for this one.
    // A long document is indexed once, so paging and find stay fast at any size.
    const index = await documentIndex(doc, this.pageChars, {
      runJob: this.runJob,
    })
    const pages = index.map.starts
    const totalPages = pages.length
    const base = {
      source: source.n,
      url: doc.url,
      ...(doc.title ? { title: doc.title } : {}),
      ...(doc.published ? { published: doc.published } : {}),
      ...(doc.modified ? { modified: doc.modified } : {}),
      ...(doc.archiveUrl
        ? {
            ...(doc.archived ? { archived: doc.archived } : {}),
            archiveUrl: doc.archiveUrl,
          }
        : {}),
      totalPages,
      ...(doc.truncated ? { truncated: true } : {}),
      ...(doc.via ? { via: doc.via } : {}),
      ...(doc.fetchedAt ? { fetchedAt: doc.fetchedAt } : {}),
      ...(doc.partial ? { partial: true } : {}),
    }

    const find = typeof args?.find === 'string' ? args.find.trim() : ''
    if (find) {
      // Passages fill at most a page, the size this model reads at once
      const found = findPassages(doc, find, {
        budget: this.pageChars,
        source: index.source,
        pages,
      })
      return {
        ...base,
        find: found.term,
        matches: found.matches,
        totalMatches: found.total,
        ...(found.pages.length > 0 ? { matchPages: found.pages } : {}),
      }
    }

    const page = clampInt(args?.page, 1, Number.MAX_SAFE_INTEGER, 1)
    if (page > totalPages) {
      return {
        error: `${doc.url} has ${totalPages} page${totalPages === 1 ? '' : 's'}; there is no page ${page}.`,
      }
    }
    return {
      ...base,
      page,
      content: pageText({ text: doc.text, pages, open: index.map.open }, page),
      ...(page === 1 && totalPages > 1 ? { outline: index.map.outline } : {}),
    }
  }

  async _request(
    url,
    init,
    signal,
    label,
    providerType = this.settings.type,
    timeoutMs = REQUEST_TIMEOUT_MS
  ) {
    return apiRequest(url, init, {
      signal,
      label,
      providerType,
      timeoutMs,
      fetchFn: this.fetchFn,
    })
  }

  async _postOllama(endpoint, payload, signal, apiKey = null) {
    const key = apiKey || this.settings.apiKey
    const res = await this._request(
      `${OLLAMA_API_BASE}/${endpoint}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(payload),
      },
      signal,
      'Ollama web search',
      'ollama'
    )
    try {
      return await res.json()
    } catch {
      throw webError('Ollama web search returned a response that is not JSON.')
    }
  }

  async _ollamaSearch(query, signal, endpoint = null) {
    const apiKey = endpoint?.apiKey || this.settings.apiKey
    const limit = endpoint?.maxResults ?? DEFAULT_RESULTS
    const body = await this._postOllama(
      'web_search',
      { query, max_results: limit },
      signal,
      apiKey
    )
    return { results: normalizeResults(body?.results, limit, query) }
  }

  async _postWebsearchapi(
    path,
    payload,
    signal,
    apiKey,
    timeoutMs = REQUEST_TIMEOUT_MS
  ) {
    const res = await this._request(
      `${WEBSEARCHAPI_BASE}/${path}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      },
      signal,
      'WebSearchAPI.ai',
      'websearchapi',
      timeoutMs
    )
    try {
      return await res.json()
    } catch {
      throw webError('WebSearchAPI.ai returned a response that is not JSON.')
    }
  }

  /**
   * WebSearchAPI.ai's Search API with the user's chosen options. Page content
   * is fetched only when the user turned it on (two credits a search); snippets
   * are then chosen from the page text instead of the result description.
   */
  async _websearchapiSearch(query, signal, endpoint) {
    const options = endpoint.search ?? {}
    const limit = options.maxResults ?? DEFAULT_RESULTS
    const body = await this._postWebsearchapi(
      'ai-search',
      {
        query,
        ...options,
        maxResults: limit,
        ...(options.includeContent ? { contentFormat: 'text' } : {}),
      },
      signal,
      endpoint.apiKey
    )
    const organic = (Array.isArray(body?.organic) ? body.organic : []).map(
      entry => ({ ...entry, content: entry?.content || entry?.description })
    )
    const answer =
      typeof body?.answer === 'string' && body.answer.trim()
        ? [clip(collapse(body.answer), 500)]
        : []
    return {
      results: normalizeResults(organic, limit, query),
      answers: answer,
    }
  }

  /**
   * Tavily's Search API with the user's chosen options. With raw content on,
   * snippets are chosen from the page text.
   */
  async _tavilySearch(query, signal, endpoint) {
    const options = endpoint.search ?? {}
    const limit = options.maxResults ?? DEFAULT_RESULTS
    const res = await this._request(
      `${TAVILY_API_BASE}/search`,
      {
        method: 'POST',
        headers: tavilyHeaders(endpoint),
        body: JSON.stringify(
          withoutUndefined({
            query,
            max_results: limit,
            search_depth: options.searchDepth,
            chunks_per_source: options.chunksPerSource,
            topic: options.topic,
            time_range: options.timeRange,
            start_date: options.startDate,
            end_date: options.endDate,
            include_published_date: options.includePublishedDate,
            filter_by_published_date: options.filterByPublishedDate,
            include_answer: options.includeAnswer,
            include_raw_content: options.includeRawContent,
            include_domains: options.includeDomains,
            exclude_domains: options.excludeDomains,
            include_domains_mode: options.includeDomainsMode,
            country: options.country,
            language: options.language,
            filter_by_language: options.filterByLanguage,
            auto_parameters: options.autoParameters,
            exact_match: options.exactMatch,
            safe_search: options.safeSearch,
          })
        ),
      },
      signal,
      'Tavily',
      'tavily'
    )
    let body
    try {
      body = await res.json()
    } catch {
      throw webError('Tavily returned a response that is not JSON.')
    }
    const results = (Array.isArray(body?.results) ? body.results : []).map(
      entry => ({ ...entry, content: entry?.raw_content || entry?.content })
    )
    const answer =
      typeof body?.answer === 'string' && body.answer.trim()
        ? [clip(collapse(body.answer), 500)]
        : []
    return {
      results: normalizeResults(results, limit, query),
      answers: answer,
    }
  }

  /**
   * Firecrawl's Search API, on Firecrawl Cloud or a self-hosted instance, with
   * the user's chosen options. With page content on, snippets are chosen from
   * each result's Markdown.
   */
  async _firecrawlSearch(query, signal, endpoint) {
    const options = endpoint.search ?? {}
    const limit = options.maxResults ?? DEFAULT_RESULTS
    const selfHosted = endpoint.provider === 'firecrawlSelfHosted'
    const label = selfHosted ? 'Firecrawl (self-hosted)' : 'Firecrawl'
    const tbs = [
      options.sortByDate ? 'sbd:1' : null,
      options.timeRange ? `qdr:${options.timeRange[0]}` : null,
    ]
      .filter(Boolean)
      .join(',')
    // Search refuses zeroDataRetention inside its scrape options
    const scrape = { ...endpoint.scrape }
    delete scrape.zeroDataRetention
    const request = firecrawlRequest(endpoint, 'search')
    let res
    try {
      res = await this._request(
        request.url,
        {
          method: 'POST',
          headers: request.headers,
          body: JSON.stringify(
            withoutUndefined({
              query,
              limit,
              categories: options.categories?.map(type => ({ type })),
              tbs: tbs || undefined,
              includeDomains: options.includeDomains,
              excludeDomains: options.excludeDomains,
              country: options.country,
              location: options.location,
              safe: options.safeSearch,
              timeout: options.timeout,
              sources: options.sources,
              highlights: options.highlights,
              scrapeOptions: options.scrapeResults
                ? firecrawlScrapeOptions(scrape)
                : undefined,
            })
          ),
        },
        signal,
        label,
        endpoint.provider,
        firecrawlTimeoutMs(options.timeout)
      )
    } catch (err) {
      // A self-hosted instance with no search engine behind it fails searches
      if (selfHosted && err?.status >= 500) {
        throw webError(
          `${err.message} Search backend not configured on self-hosted instance: set SEARXNG_ENDPOINT in its .env.`,
          { status: err.status, hint: err.hint, kind: err.kind }
        )
      }
      throw err
    }
    let body
    try {
      body = await res.json()
    } catch {
      throw webError(`${label} returned a response that is not JSON.`)
    }
    // v2 answers { data: { web: [...], news: [...] } }; older instances a plain list
    const list = Array.isArray(body?.data)
      ? body.data
      : ['web', 'news'].flatMap(source =>
          Array.isArray(body?.data?.[source]) ? body.data[source] : []
        )
    const results = list.map(entry => ({
      ...entry,
      title: entry?.title || entry?.metadata?.title,
      content: entry?.markdown || entry?.description || entry?.snippet,
      publishedDate: entry?.date,
    }))
    // The limit applies to each source
    const max = limit * Math.max(1, options.sources?.length ?? 1)
    return { results: normalizeResults(results, max, query) }
  }

  /**
   * Jina's Search API with the user's chosen options. Without page content it
   * returns only each result's title, URL, description and date; with it, Jina
   * reads every result and snippets are chosen from the page text.
   */
  async _jinaSearch(query, signal, endpoint) {
    const options = endpoint.search ?? {}
    const limit = options.maxResults ?? DEFAULT_RESULTS
    const res = await this._request(
      `${JINA_SEARCH_BASE}/`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${endpoint.apiKey}`,
          ...(options.includeContent ? {} : { 'X-Respond-With': 'no-content' }),
        },
        body: JSON.stringify(
          withoutUndefined({
            q: query,
            num: limit,
            type: options.type,
            gl: options.country,
            hl: options.language,
            location: options.location,
            site: options.includeDomains,
          })
        ),
      },
      signal,
      'Jina Search',
      'jina',
      options.includeContent ? jinaTimeoutMs() : REQUEST_TIMEOUT_MS
    )
    let body
    try {
      body = await res.json()
    } catch {
      throw webError('Jina Search returned a response that is not JSON.')
    }
    // `date` is the search engine's; publishedTime can be a Last-Modified header
    const results = (Array.isArray(body?.data) ? body.data : []).map(entry => ({
      ...entry,
      content: entry?.content || entry?.description,
      publishedDate: entry?.date,
    }))
    return { results: normalizeResults(results, limit, query) }
  }

  /**
   * LangSearch's Search API with the user's chosen options. With page content
   * on, LangSearch extracts full webpage text and snippets are chosen from it.
   */
  async _langsearchSearch(query, signal, endpoint) {
    const options = endpoint.search ?? {}
    const limit = options.maxResults ?? DEFAULT_RESULTS
    const payload = withoutUndefined({
      query,
      count: limit,
      freshness: options.freshness,
      includeDomains: options.includeDomains,
      excludeDomains: options.excludeDomains,
      contents: options.includeContent
        ? {
            text: options.maxCharacters
              ? { maxCharacters: options.maxCharacters }
              : true,
          }
        : undefined,
    })
    const res = await this._request(
      `${LANGSEARCH_API_BASE}/v1/web-search`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${endpoint.apiKey}`,
        },
        body: JSON.stringify(payload),
      },
      signal,
      'LangSearch',
      'langsearch'
    )
    let body
    try {
      body = await res.json()
    } catch {
      throw webError('LangSearch returned a response that is not JSON.')
    }
    const rawResults =
      body?.data?.webPages?.value || body?.data?.results || body?.results || []
    const results = rawResults.map(entry => ({
      title: entry?.name || entry?.title,
      url: entry?.url,
      content:
        entry?.text || entry?.summary || entry?.snippet || entry?.description,
      publishedDate:
        entry?.datePublished || entry?.dateLastCrawled || entry?.publishedDate,
    }))
    return { results: normalizeResults(results, limit, query) }
  }

  /**
   * Exa's Search API with the user's chosen options. Exa supports neural,
   * keyword, fast, deep search, category filtering, domain inclusion/exclusion,
   * date ranges, text filtering, moderation, and full contents retrieval
   * (text, highlights, summary, livecrawl, subpages).
   */
  async _exaSearch(query, signal, endpoint) {
    const options = endpoint.search ?? {}
    const limit = options.maxResults ?? DEFAULT_RESULTS

    let contents
    if (
      options.includeContent ||
      options.highlights ||
      options.summary ||
      options.maxCharacters ||
      options.includeHtmlTags ||
      options.livecrawl ||
      options.subpages
    ) {
      const textOption = options.maxCharacters
        ? {
            maxCharacters: options.maxCharacters,
            ...(options.includeHtmlTags ? { includeHtmlTags: true } : {}),
          }
        : options.includeHtmlTags
          ? { includeHtmlTags: true }
          : true

      const highlightsOption = options.highlights
        ? options.numSentences ||
          options.highlightsPerUrl ||
          options.highlightsQuery
          ? {
              ...(options.numSentences
                ? { numSentences: options.numSentences }
                : {}),
              ...(options.highlightsPerUrl
                ? { highlightsPerUrl: options.highlightsPerUrl }
                : {}),
              ...(options.highlightsQuery
                ? { query: options.highlightsQuery }
                : {}),
            }
          : true
        : undefined

      const summaryOption = options.summary
        ? options.summaryQuery
          ? { query: options.summaryQuery }
          : true
        : undefined

      contents = withoutUndefined({
        text: textOption,
        highlights: highlightsOption,
        summary: summaryOption,
        livecrawl: options.livecrawl,
        livecrawlTimeout: options.livecrawlTimeout,
        subpages: options.subpages,
        subpageTarget: options.subpageTarget,
      })
    }

    const payload = withoutUndefined({
      query,
      numResults: limit,
      type: options.type,
      category: options.category,
      includeDomains: options.includeDomains,
      excludeDomains: options.excludeDomains,
      startPublishedDate: options.startPublishedDate,
      endPublishedDate: options.endPublishedDate,
      includeText: options.includeText,
      excludeText: options.excludeText,
      moderation: options.moderation,
      contents,
    })

    const res = await this._request(
      `${EXA_API_BASE}/search`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': endpoint.apiKey,
        },
        body: JSON.stringify(payload),
      },
      signal,
      'Exa',
      'exa',
      exaTimeoutMs(options.livecrawlTimeout)
    )

    let body
    try {
      body = await res.json()
    } catch {
      throw webError('Exa returned a response that is not JSON.')
    }

    const rawResults = Array.isArray(body?.results) ? body.results : []
    const results = rawResults.map(entry => ({
      title: entry?.title,
      url: entry?.url,
      content:
        entry?.text ||
        (Array.isArray(entry?.highlights)
          ? entry.highlights.join('\n\n')
          : '') ||
        entry?.summary ||
        entry?.snippet ||
        entry?.description,
      publishedDate: entry?.publishedDate,
    }))
    return { results: normalizeResults(results, limit, query) }
  }

  /** SearXNG has no result count: every result the instance sends is kept. */
  async _searxngSearch(query, signal, endpoint = null) {
    const baseUrl = endpoint?.baseUrl || this.settings.baseUrl
    const url = new URL(`${resolveDockerHostUrl(baseUrl)}/search`)
    url.searchParams.set('q', query)
    url.searchParams.set('format', 'json')
    if (endpoint?.defaultCategories)
      url.searchParams.set('categories', endpoint.defaultCategories)
    if (endpoint?.defaultLanguage)
      url.searchParams.set('language', endpoint.defaultLanguage)
    if (endpoint?.timeRange)
      url.searchParams.set('time_range', endpoint.timeRange)
    if (endpoint?.safeSearch !== undefined)
      url.searchParams.set('safesearch', String(endpoint.safeSearch))

    const res = await this._request(
      url.toString(),
      { headers: { Accept: 'application/json' } },
      signal,
      'SearXNG',
      'searxng'
    )
    let body
    try {
      body = await res.json()
    } catch {
      throw webError(
        'SearXNG did not return JSON. Add "json" to search.formats in its settings.yml.'
      )
    }
    const results = normalizeResults(
      body?.results,
      Number.MAX_SAFE_INTEGER,
      query
    )
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
  const result = await tools.search(
    { query: 'LaTeX' },
    { signal, useCache: false }
  )
  return {
    latencyMs: Date.now() - startedAt,
    resultCount: result.results.length,
    activeEndpoints: tools.rotator.pool.filter(e =>
      SEARCH_PROVIDERS.has(e.provider)
    ).length,
    provider: result.provider,
  }
}
