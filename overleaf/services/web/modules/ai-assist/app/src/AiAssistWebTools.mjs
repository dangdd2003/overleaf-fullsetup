import Settings from '@overleaf/settings'
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
import { clearWorkingSet, keepSearchPage } from './web-fetch/working-set.mjs'

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
export { isoDay, safeDecodeURI, safeDecodeURIComponent } from './web-fetch/util.mjs'

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
  'tinyfish',
  'parallel',
  'mcp',
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
  'tinyfish',
  'parallel',
  'mcp',
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
  'tinyfish',
  'parallel',
  'mcp',
])

export const WEB_SEARCH_DEFAULTS = {
  cacheHours: 24,
  maxCachedSearches: 256,
  maxCachedPages: 64,
}

export const LANGSEARCH_API_BASE = 'https://api.langsearch.com'
export const EXA_API_BASE = 'https://api.exa.ai'
export const TINYFISH_API_BASE = 'https://api.search.tinyfish.ai'
export const PARALLEL_API_BASE = 'https://api.parallel.ai'
export const PARALLEL_MAX_RESULTS = 20
export const PARALLEL_MODES = ['turbo', 'fast', 'basic', 'advanced']

/** Settings for a run with no search backend: web_fetch only, default caching. */
export function fetchOnlyWebSettings() {
  const { cacheHours, maxCachedSearches, maxCachedPages } = Settings.aiAssist || {}
  return {
    providers: {},
    cacheHours: cacheHours ?? WEB_SEARCH_DEFAULTS.cacheHours,
    maxCachedSearches: maxCachedSearches ?? WEB_SEARCH_DEFAULTS.maxCachedSearches,
    maxCachedPages: maxCachedPages ?? WEB_SEARCH_DEFAULTS.maxCachedPages,
  }
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
/** TinyFish Search answers one GET on its root; limit is applied client-side. */
const TINYFISH_MAX_RESULTS = 20
const TINYFISH_DOMAIN_TYPES = ['web', 'news', 'research_paper']
const MAX_SNIPPET_CHARS = 600
/** Unread page ranges a web_fetch result lists; the count covers the rest. */
const MAX_UNREAD_RANGES = 8
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

export function normalizeMcpOptions(raw = {}) {
  const rawHeaders = Array.isArray(raw?.headers) ? raw.headers : []
  const headers = rawHeaders
    .filter(
      h =>
        h &&
        typeof h === 'object' &&
        typeof h.key === 'string' &&
        h.key.trim() &&
        typeof h.value === 'string'
    )
    .map(h => ({
      key: h.key.trim().replace(/[\r\n]+/g, ''),
      value: h.value.trim().replace(/[\r\n]+/g, ''),
    }))
    .filter(h => h.key.length > 0)
  const toolName =
    typeof raw?.toolName === 'string' && raw.toolName.trim()
      ? raw.toolName.trim()
      : undefined
  const queryParam =
    typeof raw?.queryParam === 'string' && raw.queryParam.trim()
      ? raw.queryParam.trim()
      : undefined
  return withoutUndefined({
    headers: headers.length > 0 ? headers : undefined,
    toolName,
    queryParam,
  })
}

/**
 * Validates the web search settings a client sent with a run. Returns null
 * when none were sent, which leaves the web tools out of the run.
 */
function clampCacheParam(value, min, defaultValue) {
  const num =
    typeof value === 'string'
      ? parseInt(value, 10)
      : typeof value === 'number'
        ? value
        : null
  if (num === null || Number.isNaN(num)) return defaultValue
  return Math.max(min, num)
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

/**
 * The TinyFish request options a user chose, keeping only valid values.
 * An option left out is left to the API's own default (US/en, web, page 0).
 * Date filters are mutually exclusive with recency and unsupported for
 * research_paper; invalid combos are dropped here so the API never sees a 400.
 */
export function normalizeTinyfishOptions(raw = {}) {
  const rawSearch =
    raw?.search && typeof raw.search === 'object' ? raw.search : {}
  const domainType = optionalChoice(
    rawSearch.domainType ?? rawSearch.domain_type,
    TINYFISH_DOMAIN_TYPES
  )
  const isPaper = domainType === 'research_paper'
  const recencyMinutes = Number.isInteger(rawSearch.recencyMinutes)
    ? Math.min(5256000, Math.max(1, rawSearch.recencyMinutes))
    : undefined
  const afterDate =
    !isPaper && recencyMinutes === undefined
      ? optionalText(rawSearch.afterDate, /^\d{4}-\d{2}-\d{2}$/, 10)
      : undefined
  const beforeDate =
    !isPaper && recencyMinutes === undefined
      ? optionalText(rawSearch.beforeDate, /^\d{4}-\d{2}-\d{2}$/, 10)
      : undefined
  const search = withoutUndefined({
    maxResults: Number.isInteger(rawSearch.maxResults)
      ? Math.min(TINYFISH_MAX_RESULTS, Math.max(1, rawSearch.maxResults))
      : undefined,
    domainType,
    location: optionalText(rawSearch.location ?? rawSearch.country, /^[A-Za-z]{2}$/, 2),
    language: optionalText(rawSearch.language, /^[A-Za-z]{2,5}$/, 5),
    includeDomains: domainList(rawSearch.includeDomains),
    excludeDomains: domainList(rawSearch.excludeDomains),
    ...(isPaper
      ? {
          pubYearMin: Number.isInteger(rawSearch.pubYearMin)
            ? Math.min(9999, Math.max(0, rawSearch.pubYearMin))
            : undefined,
          pubYearMax: Number.isInteger(rawSearch.pubYearMax)
            ? Math.min(9999, Math.max(0, rawSearch.pubYearMax))
            : undefined,
        }
      : {
          recencyMinutes,
          afterDate,
          beforeDate,
        }),
  })
  const baseUrl =
    typeof raw?.baseUrl === 'string' && raw.baseUrl.trim()
      ? raw.baseUrl.trim()
      : typeof rawSearch.baseUrl === 'string' && rawSearch.baseUrl.trim()
        ? rawSearch.baseUrl.trim()
        : undefined
  return {
    ...(Object.keys(search).length > 0 ? { search } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  }
}

/**
 * The Parallel request options a user chose, keeping only valid values.
 * An option left out is left to the API's own default.
 */
export function normalizeParallelOptions(raw = {}) {
  const rawSearch =
    raw?.search && typeof raw.search === 'object' ? raw.search : {}
  const rawRead =
    raw?.read && typeof raw.read === 'object'
      ? raw.read
      : raw?.extract && typeof raw.extract === 'object'
        ? raw.extract
        : {}

  const search = withoutUndefined({
    maxResults: Number.isInteger(rawSearch.maxResults)
      ? Math.min(PARALLEL_MAX_RESULTS, Math.max(1, rawSearch.maxResults))
      : undefined,
    mode: optionalChoice(rawSearch.mode, PARALLEL_MODES),
    location: optionalText(rawSearch.location, /^[a-z]{2}$/i)?.toLowerCase(),
    includeDomains: domainList(rawSearch.includeDomains),
    excludeDomains: domainList(rawSearch.excludeDomains),
    afterDate: optionalText(rawSearch.afterDate, /^\d{4}-\d{2}-\d{2}$/),
    maxCharsTotal: Number.isInteger(rawSearch.maxCharsTotal)
      ? Math.max(1, rawSearch.maxCharsTotal)
      : undefined,
    maxCharsPerResult: Number.isInteger(rawSearch.maxCharsPerResult)
      ? Math.max(1, rawSearch.maxCharsPerResult)
      : undefined,
    maxAgeSeconds: Number.isInteger(rawSearch.maxAgeSeconds)
      ? Math.max(600, rawSearch.maxAgeSeconds)
      : undefined,
    timeoutSeconds: Number.isInteger(rawSearch.timeoutSeconds)
      ? Math.min(120, Math.max(1, rawSearch.timeoutSeconds))
      : undefined,
    disableCacheFallback: optionalFlag(rawSearch.disableCacheFallback),
  })

  const read = withoutUndefined({
    fullContent: optionalFlag(rawRead.fullContent),
    maxCharsPerResult: Number.isInteger(rawRead.maxCharsPerResult)
      ? Math.max(1, rawRead.maxCharsPerResult)
      : undefined,
    maxAgeSeconds: Number.isInteger(rawRead.maxAgeSeconds)
      ? Math.max(600, rawRead.maxAgeSeconds)
      : undefined,
    timeoutSeconds: Number.isInteger(rawRead.timeoutSeconds)
      ? Math.min(120, Math.max(1, rawRead.timeoutSeconds))
      : undefined,
    disableCacheFallback: optionalFlag(rawRead.disableCacheFallback),
  })

  const baseUrl =
    typeof raw?.baseUrl === 'string' && raw.baseUrl.trim()
      ? raw.baseUrl.trim()
      : typeof rawSearch.baseUrl === 'string' && rawSearch.baseUrl.trim()
        ? rawSearch.baseUrl.trim()
        : undefined

  return {
    ...(Object.keys(search).length > 0 ? { search } : {}),
    ...(Object.keys(read).length > 0 ? { read } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  }
}

export function normalizeWebSearchSettings(
  raw,
  { allowConfiguredOnly = false } = {}
) {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object')
    throw settingsError('Invalid web search settings.')

  // Always enforce server cache configuration (no upper caps for server owner)
  const serverCfg = Settings.aiAssist || {}
  const preferences = {
    cacheHours: clampCacheParam(serverCfg.cacheHours, 0, WEB_SEARCH_DEFAULTS.cacheHours),
    maxCachedSearches: clampCacheParam(serverCfg.maxCachedSearches, 0, WEB_SEARCH_DEFAULTS.maxCachedSearches),
    maxCachedPages: clampCacheParam(serverCfg.maxCachedPages, 0, WEB_SEARCH_DEFAULTS.maxCachedPages),
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

    if (type === 'mcp') {
      const rawUrls = Array.isArray(raw.serverUrls)
        ? raw.serverUrls
        : raw.baseUrl ? [raw.baseUrl] : []
      const serverUrls = rawUrls
        .map(u => (typeof u === 'string' ? u.trim() : ''))
        .filter(Boolean)
      if (serverUrls.length === 0) {
        throw settingsError('MCP web search needs the URL of your endpoint.')
      }
      for (const url of serverUrls) {
        validateSafeProviderBaseUrl(url)
      }
      return {
        type: 'mcp',
        serverUrls,
        ...normalizeMcpOptions(raw),
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
                      : type === 'tinyfish'
                        ? 'TinyFish'
                        : type === 'parallel'
                          ? 'Parallel'
                          : type
      const help =
        type === 'ollama'
          ? ' from https://ollama.com/settings/keys.'
          : type === 'parallel'
            ? ' from https://parallel.ai.'
            : '.'
      throw settingsError(`${label} web search needs an API key${help}`)
    }
    if (type === 'parallel') {
      const rawBaseUrl =
        typeof raw.baseUrl === 'string'
          ? raw.baseUrl.trim()
          : typeof raw.search?.baseUrl === 'string'
            ? raw.search.baseUrl.trim()
            : ''
      if (rawBaseUrl) {
        validateSafeProviderBaseUrl(rawBaseUrl)
      }
      return {
        type: 'parallel',
        apiKey,
        ...(rawBaseUrl ? { baseUrl: rawBaseUrl } : {}),
        ...normalizeParallelOptions(raw),
        ...preferences,
      }
    }
    if (type === 'tinyfish') {
      const rawBaseUrl =
        typeof raw.baseUrl === 'string'
          ? raw.baseUrl.trim()
          : typeof raw.search?.baseUrl === 'string'
            ? raw.search.baseUrl.trim()
            : ''
      if (rawBaseUrl) {
        validateSafeProviderBaseUrl(rawBaseUrl)
      }
      return {
        type: 'tinyfish',
        apiKey,
        ...(rawBaseUrl ? { baseUrl: rawBaseUrl } : {}),
        ...normalizeTinyfishOptions(raw),
        ...preferences,
      }
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
    const rawFirecrawlSelfHosted = raw.providers.firecrawlSelfHosted
    const rawLangsearch = raw.providers.langsearch
    const rawExa = raw.providers.exa
    const rawTinyfish = raw.providers.tinyfish
    const rawParallel = raw.providers.parallel
    const rawMcp = raw.providers.mcp
    const readerKeys = raw =>
      Array.isArray(raw?.apiKeys)
        ? raw.apiKeys
            .map(k => (typeof k === 'string' ? k.trim() : ''))
            .filter(Boolean)
        : typeof raw?.apiKey === 'string' && raw.apiKey.trim()
          ? [raw.apiKey.trim()]
          : []
    const jinaKeys = readerKeys(rawJina)
    const firecrawlKeys = readerKeys(rawFirecrawl)
    const langsearchKeys = readerKeys(rawLangsearch)
    const exaKeys = readerKeys(rawExa)
    const tinyfishKeys = readerKeys(rawTinyfish)
    const parallelKeys = readerKeys(rawParallel)

    const ollamaKeys = Array.isArray(rawOllama?.apiKeys)
      ? rawOllama.apiKeys
          .map(k => (typeof k === 'string' ? k.trim() : ''))
          .filter(Boolean)
      : typeof rawOllama?.apiKey === 'string' && rawOllama.apiKey.trim()
        ? [rawOllama.apiKey.trim()]
        : []
    const websearchapiKeys = Array.isArray(rawWebsearchapi?.apiKeys)
      ? rawWebsearchapi.apiKeys
          .map(k => (typeof k === 'string' ? k.trim() : ''))
          .filter(Boolean)
      : typeof rawWebsearchapi?.apiKey === 'string' &&
          rawWebsearchapi.apiKey.trim()
        ? [rawWebsearchapi.apiKey.trim()]
        : []

    const tavilyKeys = readerKeys(rawTavily)

    const rawUrls = Array.isArray(rawSearxng?.baseUrls)
      ? rawSearxng.baseUrls
      : typeof rawSearxng?.baseUrl === 'string' && rawSearxng.baseUrl.trim()
        ? [rawSearxng.baseUrl.trim()]
        : []

    const searxngUrls = rawUrls
      .map(u => normalizeSearxngBaseUrl(u))
      .filter(Boolean)

    // Validate safe URL for every SearXNG baseUrl
    for (const url of searxngUrls) {
      validateSafeProviderBaseUrl(url)
    }

    const firecrawlSelfHostedUrls = (
      Array.isArray(rawFirecrawlSelfHosted?.baseUrls)
        ? rawFirecrawlSelfHosted.baseUrls
        : typeof rawFirecrawlSelfHosted?.baseUrl === 'string' &&
            rawFirecrawlSelfHosted.baseUrl.trim()
          ? [rawFirecrawlSelfHosted.baseUrl.trim()]
          : []
    )
      .map(u => normalizeFirecrawlBaseUrl(u))
      .filter(Boolean)
    for (const url of firecrawlSelfHostedUrls) {
      validateSafeProviderBaseUrl(url)
    }

    const rawMcpServerUrls = Array.isArray(rawMcp?.serverUrls)
      ? rawMcp.serverUrls
      : typeof rawMcp?.baseUrl === 'string' && rawMcp.baseUrl.trim()
        ? [rawMcp.baseUrl.trim()]
        : []
    const mcpServerUrls = rawMcpServerUrls
      .map(u => (typeof u === 'string' ? u.trim() : ''))
      .filter(Boolean)
    for (const url of mcpServerUrls) {
      validateSafeProviderBaseUrl(url)
    }

    // Validate optional TinyFish base URL override (proxy/mock)
    const rawTinyfishBaseUrl =
      typeof rawTinyfish?.baseUrl === 'string'
        ? rawTinyfish.baseUrl.trim()
        : typeof rawTinyfish?.search?.baseUrl === 'string'
          ? rawTinyfish.search.baseUrl.trim()
          : ''
    if (rawTinyfishBaseUrl) {
      validateSafeProviderBaseUrl(rawTinyfishBaseUrl)
    }

    // Validate optional Parallel base URL override (proxy/mock)
    const rawParallelBaseUrl =
      typeof rawParallel?.baseUrl === 'string'
        ? rawParallel.baseUrl.trim()
        : typeof rawParallel?.search?.baseUrl === 'string'
          ? rawParallel.search.baseUrl.trim()
          : ''
    if (rawParallelBaseUrl) {
      validateSafeProviderBaseUrl(rawParallelBaseUrl)
    }

    let ollamaEnabled = Boolean(rawOllama?.enabled && ollamaKeys.length > 0)
    const ollamaMaxResults = Number.isInteger(rawOllama?.maxResults)
      ? Math.min(OLLAMA_MAX_RESULTS, Math.max(1, rawOllama.maxResults))
      : undefined
    let searxngEnabled = Boolean(
      rawSearxng?.enabled && searxngUrls.length > 0
    )
    let websearchapiEnabled = Boolean(
      rawWebsearchapi?.enabled && websearchapiKeys.length > 0
    )

    let tavilyEnabled = Boolean(rawTavily?.enabled && tavilyKeys.length > 0)
    let firecrawlEnabled = Boolean(
      rawFirecrawl?.enabled && firecrawlKeys.length > 0
    )
    let firecrawlSelfHostedEnabled = Boolean(
      rawFirecrawlSelfHosted?.enabled && firecrawlSelfHostedUrls.length > 0
    )
    let jinaEnabled = Boolean(rawJina?.enabled && jinaKeys.length > 0)
    let langsearchEnabled = Boolean(
      rawLangsearch?.enabled && langsearchKeys.length > 0
    )
    let exaEnabled = Boolean(rawExa?.enabled && exaKeys.length > 0)
    let tinyfishEnabled = Boolean(
      rawTinyfish?.enabled && tinyfishKeys.length > 0
    )
    let parallelEnabled = Boolean(
      rawParallel?.enabled && parallelKeys.length > 0
    )
    let mcpEnabled = Boolean(rawMcp?.enabled && mcpServerUrls.length > 0)

    if (
      !ollamaEnabled &&
      !searxngEnabled &&
      !websearchapiEnabled &&
      !tavilyEnabled &&
      !firecrawlEnabled &&
      !firecrawlSelfHostedEnabled &&
      !jinaEnabled &&
      !langsearchEnabled &&
      !exaEnabled &&
      !tinyfishEnabled &&
      !parallelEnabled &&
      !mcpEnabled
    ) {
      if (allowConfiguredOnly || raw.forTest) {
        ollamaEnabled = ollamaKeys.length > 0
        searxngEnabled = searxngUrls.length > 0
        websearchapiEnabled = websearchapiKeys.length > 0
        tavilyEnabled = tavilyKeys.length > 0
        firecrawlEnabled = firecrawlKeys.length > 0
        firecrawlSelfHostedEnabled = firecrawlSelfHostedUrls.length > 0
        jinaEnabled = jinaKeys.length > 0
        langsearchEnabled = langsearchKeys.length > 0
        exaEnabled = exaKeys.length > 0
        tinyfishEnabled = tinyfishKeys.length > 0
        parallelEnabled = parallelKeys.length > 0
        mcpEnabled = mcpServerUrls.length > 0
      }
    }

    if (
      !ollamaEnabled &&
      !searxngEnabled &&
      !websearchapiEnabled &&
      !tavilyEnabled &&
      !firecrawlEnabled &&
      !firecrawlSelfHostedEnabled &&
      !jinaEnabled &&
      !langsearchEnabled &&
      !exaEnabled &&
      !tinyfishEnabled &&
      !parallelEnabled &&
      !mcpEnabled
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
                      : exaEnabled
                        ? 'exa'
                        : tinyfishEnabled
                          ? 'tinyfish'
                          : parallelEnabled
                            ? 'parallel'
                            : 'mcp',
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
        tinyfish: {
          enabled: tinyfishEnabled,
          apiKeys: tinyfishKeys,
          ...normalizeTinyfishOptions(rawTinyfish),
        },
        parallel: {
          enabled: parallelEnabled,
          apiKeys: parallelKeys,
          ...(rawParallelBaseUrl ? { baseUrl: rawParallelBaseUrl } : {}),
          ...normalizeParallelOptions(rawParallel),
        },
        mcp: {
          enabled: mcpEnabled,
          serverUrls: mcpServerUrls,
          ...normalizeMcpOptions(rawMcp),
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
  if (settings?.providers?.tinyfish?.enabled) {
    const { apiKeys = [], baseUrl, search } = settings.providers.tinyfish
    apiKeys.forEach((apiKey, index) => {
      pool.push({
        id: `tinyfish:${index}`,
        provider: 'tinyfish',
        apiKey,
        ...(baseUrl ? { baseUrl } : {}),
        search,
      })
    })
  }
  if (settings?.providers?.parallel?.enabled) {
    const { apiKeys = [], baseUrl, search, read } = settings.providers.parallel
    apiKeys.forEach((apiKey, index) => {
      pool.push({
        id: `parallel:${index}`,
        provider: 'parallel',
        apiKey,
        ...(baseUrl ? { baseUrl } : {}),
        search,
        read,
      })
    })
  }
  if (settings?.providers?.mcp?.enabled) {
    const { serverUrls = [], headers, toolName, queryParam } = settings.providers.mcp
    serverUrls.forEach((baseUrl, index) => {
      pool.push({
        id: `mcp:${index}`,
        provider: 'mcp',
        baseUrl,
        ...(headers ? { headers } : {}),
        ...(toolName ? { toolName } : {}),
        ...(queryParam ? { queryParam } : {}),
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
      settings?.type === 'mcp' &&
      (settings.baseUrl ||
        (Array.isArray(settings.serverUrls) && settings.serverUrls.length > 0))
    ) {
      const urls = settings.baseUrl ? [settings.baseUrl] : settings.serverUrls
      urls.forEach((baseUrl, index) => {
        pool.push({
          id: `mcp:${index}`,
          provider: 'mcp',
          baseUrl,
          ...(settings.headers ? { headers: settings.headers } : {}),
          ...(settings.toolName ? { toolName: settings.toolName } : {}),
          ...(settings.queryParam ? { queryParam: settings.queryParam } : {}),
        })
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
        ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}),
        ...(settings.search ? { search: settings.search } : {}),
        ...(settings.read ? { read: settings.read } : {}),
        ...(settings.scrape ? { scrape: settings.scrape } : {}),
        ...(settings.extract ? { extract: settings.extract } : {}),
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
    'Search the web for current information, including LaTeX packages, syntax and changes. Call it first whenever you are unsure a fact is correct or current, before relying on memory. Returns the top results, each numbered as a source [n] that you cite by that number, with title, URL, publication date when known and a snippet. Snippets are pointers: read the page with web_fetch before relying on a detail.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'What to search for, in the words a page answering it would use. One topic per query, a few words long. Include the year for time-sensitive questions, e.g. "Vietnam president 2026" or "siunitx range-phrase option".',
      },
    },
    required: ['query'],
  },
}

/**
 * A model reads on only when the result makes reading on look necessary and
 * cheap, so the description says plainly that one page is not the document,
 * and how page and find get to the rest.
 */
const WEB_FETCH_SPEC = {
  name: 'web_fetch',
  description: [
    'Read a web page, PDF or text file as Markdown.',
    'Long documents are split into pages of a few thousand tokens and you get ONE page per call. Each result starts with a status line: "Page 1 of 4", how many tokens the other pages hold, and which pages are still unread. Page 1 of a long document also lists its sections with the page each starts on.',
    'One page is not the whole document. If the answer is not on the page you got, never conclude the document lacks it while pages are unread: fetch the page the section list points to (page), search the whole document (find), or read the next page.',
    'Use find to jump straight to a command, option, error message or phrase anywhere in the document; it returns the most relevant passages with their page and section, and how many passages match in total. Use page to read a section in full.',
    'Further calls on a URL you already read are usually served from cache, so they are cheap: call several pages or finds of one document in parallel when you need them.',
    'A page that blocks automated readers is retried through other routes automatically. The result keeps its source number [n] for citing.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description:
          'The http or https URL to read: one from a search result, the user or the project. Use the same URL to read further pages of a document.',
      },
      page: {
        type: 'integer',
        minimum: 1,
        description:
          'Which page to return, from 1 (the default) to the page count the status line gives. Pages need not be read in order: jump to the page the section list or a find match points to. Ignored when find is given.',
      },
      find: {
        type: 'string',
        description:
          'Search the whole document instead of returning one page: a command, option, error text, or a few distinctive words, e.g. "\\qty" or "range-phrase". Case, Markdown formatting and hyphens versus spaces do not matter. When no passage has the exact phrase, passages with all or most of its words come back, marked as such. Separate alternatives or synonyms with " | ", e.g. "range-phrase | range-units". No match does not prove absence: try other words or read the pages.',
      },
    },
    required: ['url'],
  },
}

export const WEB_TOOL_SPECS = [WEB_SEARCH_SPEC, WEB_FETCH_SPEC]

/** Added to a search this conversation already ran, to push a new angle. */
export const REPEATED_SEARCH_NOTICE =
  'You already ran this search. Use these results or try a different angle.'

/**
 * The most one user's cached pages take on the data volume, least recently
 * used out first. A page counts two bytes a character, so this holds sixteen
 * of the longest documents or thousands of ordinary pages.
 */
export const MAX_DOCUMENT_CACHE_BYTES = 1024 * 1024 * 1024

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
  clearWorkingSet()
  clearEndpointHealth()
}

// ---------------------------------------------------------------------------
// Search results
// ---------------------------------------------------------------------------

export function parseTextSearchResults(text, query) {
  if (!text || typeof text !== 'string') return []
  const raw = text.trim()
  if (!raw) return []

  const items = []

  // Pattern 1: Numbered list format:
  // 1. Title
  //    https://example.com/link
  //    Snippet text
  // OR
  // 1. https://example.com/bare-url
  //    Snippet text
  const numberedPattern =
    /(?:^|\n)\s*(\d+)\.\s+(?:([^\n]+)\n\s*)?(https?:\/\/[^\s\]\)]+|\[https?:\/\/[^\]\)]+\])\n([\s\S]*?)(?=(?:\n\s*\d+\.|$))/g

  let match
  while ((match = numberedPattern.exec(raw)) !== null) {
    const [, , rawTitle, rawUrl, snippet] = match
    const url = rawUrl.replace(/^[\[\(]/, '').replace(/[\]\)]$/, '').trim()
    const title = rawTitle && rawTitle.trim() ? rawTitle.trim() : url
    items.push({
      title,
      url,
      snippet: snippet.trim(),
    })
  }

  // If numbered list matches found, normalize and return
  if (items.length > 0) {
    return normalizeResults(items, Number.MAX_SAFE_INTEGER, query)
  }

  // Pattern 2: Markdown links [Title](url) followed by optional snippet
  const mdPattern =
    /(?:^|\n)\s*(?:[-*]|\d+\.)?\s*\[([^\]]+)\]\((https?:\/\/[^)]+)\)(?:\s*[-:]\s*|\n+)?([\s\S]*?)(?=(?:\n\s*(?:[-*]|\d+\.)?\s*\[[^\]]+\]\(https?:|$))/g
  while ((match = mdPattern.exec(raw)) !== null) {
    const [, title, url, snippet] = match
    items.push({
      title: title.trim(),
      url: url.trim(),
      snippet: snippet.trim(),
    })
  }

  if (items.length > 0) {
    return normalizeResults(items, Number.MAX_SAFE_INTEGER, query)
  }

  // Pattern 3: Fallback - look for any URLs in text with preceding line as title
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    const urlMatch = line.match(/^https?:\/\/[^\s]+$/)
    if (urlMatch) {
      const url = urlMatch[0]
      const title = i > 0 ? lines[i - 1].replace(/^\d+\.\s*/, '').trim() : url
      const snippet = i + 1 < lines.length ? lines[i + 1].trim() : ''
      items.push({ title, url, snippet })
    }
  }

  return normalizeResults(items, Number.MAX_SAFE_INTEGER, query)
}

export function extractMcpSearchResults(body, query) {
  if (!body) return []

  // If string, try JSON parse first; if not JSON or parsing fails, parse as plain text
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body)
      return extractMcpSearchResults(parsed, query)
    } catch {
      return parseTextSearchResults(body, query)
    }
  }

  if (typeof body !== 'object') return []

  // JSON-RPC explicit error or tool execution failure
  if (body.error || body.result?.isError) {
    return []
  }

  // Case 1: body is an array of results
  if (Array.isArray(body)) {
    const normalized = normalizeResults(body, Number.MAX_SAFE_INTEGER, query)
    if (normalized.length > 0) return normalized
  }

  // Case 2: standard structured JSON keys (results, organic, items, data, webPages)
  const candidateArrays = [
    body.results,
    body.result?.results,
    body.result?.organic,
    body.result?.items,
    body.organic,
    body.items,
    body.data?.results,
    body.data?.webPages?.value,
    body.data,
  ]

  for (const arr of candidateArrays) {
    if (Array.isArray(arr)) {
      const normalized = normalizeResults(arr, Number.MAX_SAFE_INTEGER, query)
      if (normalized.length > 0) return normalized
    }
  }

  // Case 3: MCP content blocks: result.content or content array
  const contentBlocks = body.result?.content || body.content
  if (Array.isArray(contentBlocks)) {
    const extracted = []
    for (const block of contentBlocks) {
      if (typeof block?.text === 'string') {
        const parsed = extractMcpSearchResults(block.text, query)
        extracted.push(...parsed)
      } else if (typeof block === 'string') {
        const parsed = extractMcpSearchResults(block, query)
        extracted.push(...parsed)
      }
    }
    if (extracted.length > 0) {
      return normalizeResults(extracted, Number.MAX_SAFE_INTEGER, query)
    }
  }

  // Case 4: text / message / output field on body or result
  const textFields = [
    body.text,
    body.result?.text,
    body.message,
    body.result?.message,
    body.output,
    body.result?.output,
  ]
  for (const txt of textFields) {
    if (typeof txt === 'string' && txt.trim()) {
      const parsed = extractMcpSearchResults(txt, query)
      if (parsed.length > 0) return parsed
    }
  }

  // Case 5: recursive tree search for any array of objects with url or text fields
  const seenObjects = new Set()
  function traverse(obj) {
    if (!obj || typeof obj !== 'object' || seenObjects.has(obj)) return []
    seenObjects.add(obj)

    if (Array.isArray(obj)) {
      const direct = normalizeResults(obj, Number.MAX_SAFE_INTEGER, query)
      if (direct.length > 0) return direct
      for (const item of obj) {
        const res = traverse(item)
        if (res.length > 0) return res
      }
    } else {
      for (const key of Object.keys(obj)) {
        const val = obj[key]
        if (typeof val === 'string' && val.length > 20) {
          const parsed = extractMcpSearchResults(val, query)
          if (parsed.length > 0) return parsed
        } else if (typeof val === 'object') {
          const res = traverse(val)
          if (res.length > 0) return res
        }
      }
    }
    return []
  }

  return traverse(body)
}

/** Shorter page text is a summary, not the page, and is not kept. */
const MIN_SEARCH_PAGE_CHARS = 500

/**
 * The whole page a search result carries, for web_fetch to read it from
 * instead of a second request. Text that reaches the provider's character
 * limit was cut there, so it is not the whole page and is left out.
 */
function searchPage(text, format, limit) {
  if (typeof text !== 'string' || text.length < MIN_SEARCH_PAGE_CHARS) {
    return undefined
  }
  if (Number(limit) > 0 && text.length >= Number(limit) * 0.95) {
    return undefined
  }
  return { text, format }
}

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
      // Taken off before the results are cached or shown (see keepPages)
      ...(entry.page ? { page: entry.page } : {}),
    })
    if (results.length >= max) break
  }
  return results
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

export const MAX_MCP_CACHE_SIZE = 256
export const mcpEndpointCache = new Map()

export function setMcpEndpointCache(key, value) {
  if (mcpEndpointCache.has(key)) {
    mcpEndpointCache.delete(key)
  } else if (mcpEndpointCache.size >= MAX_MCP_CACHE_SIZE) {
    const oldest = mcpEndpointCache.keys().next().value
    if (oldest !== undefined) mcpEndpointCache.delete(oldest)
  }
  mcpEndpointCache.set(key, value)
}

export function clearMcpEndpointCache() {
  mcpEndpointCache.clear()
}

export function makeJsonRpcRequest(method, params, id = 1) {
  const req = {
    jsonrpc: '2.0',
    id,
    method,
  }
  if (params !== undefined) {
    req.params = params
  }
  return req
}

export function detectSearchTool(
  tools,
  configuredToolName,
  configuredQueryParam
) {
  let tool = null
  if (configuredToolName && Array.isArray(tools)) {
    tool =
      tools.find(t => t?.name === configuredToolName) || {
        name: configuredToolName,
      }
  } else if (Array.isArray(tools) && tools.length > 0) {
    tool = tools.find(t =>
      /search|web|brave|duckduckgo|google|tavily|bing|fetch/i.test(
        t?.name || ''
      )
    )
    if (!tool) {
      tool = tools.find(t => /search|web/i.test(t?.description || ''))
    }
    if (!tool && tools.length === 1) {
      tool = tools[0]
    }
  }

  const toolName = configuredToolName || tool?.name || 'search'

  let queryParam = configuredQueryParam
  if (!queryParam) {
    const props = tool?.inputSchema?.properties
    if (props && typeof props === 'object') {
      const candidates = [
        'query',
        'q',
        'search_query',
        'query_string',
        'text',
        'input',
        'url',
      ]
      for (const c of candidates) {
        if (c in props) {
          queryParam = c
          break
        }
      }
    }
    if (
      !queryParam &&
      Array.isArray(tool?.inputSchema?.required) &&
      tool.inputSchema.required.length > 0
    ) {
      queryParam = tool.inputSchema.required[0]
    }
    if (!queryParam) {
      queryParam = 'query'
    }
  }

  return { toolName, queryParam }
}

function isUninitializedError(err) {
  if (!err) return false
  const msg = String(err.message || '')
  return (
    msg.includes('-32002') ||
    /not initialized/i.test(msg) ||
    /initialize/i.test(msg)
  )
}

function isLegacyFallbackCandidate(err) {
  if (!err) return false
  const status = err.status
  return status === 400 || status === 404 || status === 405
}

function isToolNotFoundError(body) {
  if (!body) return false
  if (body?.error) {
    const msg = String(body.error.message || '').toLowerCase()
    if (
      body.error.code === -32601 ||
      msg.includes('not found') ||
      msg.includes('unknown tool') ||
      msg.includes('no such tool')
    ) {
      return true
    }
  }
  if (body?.result?.isError) {
    const text = Array.isArray(body.result.content)
      ? body.result.content
          .map(c => (typeof c === 'string' ? c : c?.text || ''))
          .join(' ')
          .toLowerCase()
      : ''
    if (
      text.includes('not found') ||
      text.includes('unknown tool') ||
      text.includes('no such tool')
    ) {
      return true
    }
  }
  return false
}

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
      browser,
      contextWindow,
      runJob,
      prefetch = 0,
    } = {}
  ) {
    this.settings = settings
    // Top search results read in the background, while the model reads the
    // results, so its web_fetch of one is answered at once
    this.prefetch = Math.max(0, Math.floor(Number(prefetch) || 0))
    // Extraction-worker jobs, such as indexing a long document
    this.runJob = runJob
    this.fetchFn = fetchFn
    this.fetchPage = fetchPage
    this.cacheOwner = cacheOwner
    // Pages are cut per run, for the model it serves
    this.pageChars = pageCharsFor(contextWindow)
    this.rotator = new WebRouter(settings, { cacheOwner })

    this.caches = getOwnerCaches(cacheOwner, settings)

    const effectiveBrowser =
      browser !== undefined
        ? browser
        : fetchPage !== fetchPublicUrl
          ? null
          : sharedBrowserRoute()

    this.fetcher = new WebFetcher({
      fetchPage,
      fetchFn,
      rotator: this.rotator,
      browser: effectiveBrowser,
      cache: this.caches.documents,
      cacheHours: settings.cacheHours ?? WEB_SEARCH_DEFAULTS.cacheHours,
      owner: cacheOwner,
    })

    // Every page the conversation has seen gets a number, [n], that the model
    // cites it by and the chat turns into a link. Numbers carry over from
    // earlier turns (see rememberSources), so [2] names one page throughout.
    this.sources = new Map()
    this.nextSource = 1
    // searchCacheText(query) -> the search in flight for it
    this.pending = new Map()
    // Queries this conversation already searched, as the search cache keys them
    this.searchedQueries = new Set()
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
        if (
          call?.name === 'web_search' &&
          typeof call.args?.query === 'string' &&
          call.result &&
          typeof call.result === 'object' &&
          !call.result.error
        ) {
          const key = searchCacheText(call.args.query)
          if (key) this.searchedQueries.add(key)
        }
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
            const source = this._source(item.url, item, item.source)
            if (call.name === 'web_fetch') this._markRead(source, item)
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

  /**
   * Records the page a web_fetch result showed. Pages are numbered for the
   * page size they were cut at, so a read is kept with its document's page
   * count and only counts against a document paged the same way.
   */
  _markRead(source, result) {
    if (
      !Number.isInteger(result?.page) ||
      !Number.isInteger(result?.totalPages)
    ) {
      return
    }
    source.read ??= new Map()
    let pages = source.read.get(result.totalPages)
    if (!pages) {
      pages = new Set()
      source.read.set(result.totalPages, pages)
    }
    pages.add(result.page)
  }

  /**
   * The pages of a document paged into `totalPages` that no result has shown
   * yet: how many, and the first of them as [from, to] ranges.
   */
  _unreadPages(source, totalPages) {
    const read = source.read?.get(totalPages) ?? new Set()
    const ranges = []
    for (let page = 1; page <= totalPages; page++) {
      if (read.has(page)) continue
      const last = ranges[ranges.length - 1]
      if (last && last[1] === page - 1) last[1] = page
      else if (ranges.length < MAX_UNREAD_RANGES) ranges.push([page, page])
      else break
    }
    return { count: totalPages - read.size, ranges }
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
        const key = searchCacheText(
          typeof args?.query === 'string' ? args.query : ''
        )
        const repeated = Boolean(key) && this.searchedQueries.has(key)
        const result = await this._shared(key, () =>
          this.search(args, { signal })
        )
        if (result?.error) return result
        if (key) this.searchedQueries.add(key)
        return repeated ? { ...result, notice: REPEATED_SEARCH_NOTICE } : result
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
      this.settings.primaryProvider ?? null,
      this.settings.baseUrl ?? '',
      this.settings.providers?.websearchapi?.search ?? null,
      this.settings.providers?.tavily?.search ?? null,
      this.settings.providers?.firecrawl?.search ?? null,
      this.settings.providers?.firecrawlSelfHosted?.search ?? null,
      this.settings.providers?.jina?.search ?? null,
      this.settings.providers?.langsearch?.search ?? null,
      this.settings.providers?.exa?.search ?? null,
      this.settings.providers?.tinyfish?.search ?? null,
      this.settings.providers?.parallel?.search ?? null,
      this.settings.providers?.ollama?.maxResults ?? null,
      this.settings.providers?.searxng?.timeRange ?? null,
      this.settings.providers?.searxng?.safeSearch ?? null,
      this.settings.providers?.searxng?.defaultCategories ?? null,
      this.settings.providers?.searxng?.defaultLanguage ?? null,
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
            } else if (provider === 'tinyfish') {
              res = await this._tinyfishSearch(query, signal, endpoint)
            } else if (provider === 'parallel') {
              res = await this._parallelSearch(query, signal, endpoint)
            } else if (provider === 'mcp') {
              res = await this._mcpSearch(query, signal, endpoint)
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

      found = { ...found, results: this._keepPages(found.results, providerUsed) }
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

    this._prefetchResults(results, signal)

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

  /**
   * Keeps the whole page text a provider returned with its results, for
   * web_fetch to read a result from, and returns the results without it: the
   * search cache and the model get snippets only.
   */
  _keepPages(results, provider) {
    return results.map(({ page, ...result }) => {
      if (page) {
        keepSearchPage(this.cacheOwner, cacheKeyFor(result.url), {
          url: result.url,
          title: result.title,
          text: page.text,
          format: page.format,
          via: provider,
          ...(result.published ? { published: result.published } : {}),
        })
      }
      return result
    })
  }

  /**
   * Starts reading the top results the cache does not hold yet. A web_fetch
   * of one joins the read in flight, or finds it done. Failures are left for
   * that web_fetch to report; the run's cancel stops them.
   */
  _prefetchResults(results, signal) {
    if (this.prefetch <= 0 || signal?.aborted) return
    for (const result of results
      .filter(result => !result.cached)
      .slice(0, this.prefetch)) {
      this.fetcher.read(result.url, { signal }).catch(() => {})
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
      // The document's length, so the model can see what reading on costs
      totalChars: doc.text.length,
      ...(doc.truncated ? { truncated: true } : {}),
      ...(doc.via ? { via: doc.via } : {}),
      ...(doc.fetchedAt ? { fetchedAt: doc.fetchedAt } : {}),
      ...(doc.partial ? { partial: true } : {}),
    }
    const outline =
      totalPages > 1 && index.map.outline.length > 0
        ? { outline: index.map.outline }
        : {}

    const find = typeof args?.find === 'string' ? args.find.trim() : ''
    if (find) {
      // Passages fill at most a page, the size this model reads at once
      const found = findPassages(doc, find, {
        budget: this.pageChars,
        source: index.source,
        pages,
      })
      // Without a passage that has the exact phrase, the contents are the
      // next best way into the document
      const weak =
        found.matches.length === 0 || found.matches.every(match => match.match)
      return {
        ...base,
        find: found.term || collapse(find),
        matches: found.matches,
        totalMatches: found.total,
        ...(found.pages.length > 0 ? { matchPages: found.pages } : {}),
        ...(weak ? outline : {}),
        ...this._unreadFields(source, totalPages),
      }
    }

    const page = clampInt(args?.page, 1, Number.MAX_SAFE_INTEGER, 1)
    if (page > totalPages) {
      return {
        error: `${doc.url} has ${totalPages} page${totalPages === 1 ? '' : 's'}; there is no page ${page}. Pages run from 1 to ${totalPages}.`,
      }
    }
    const result = {
      ...base,
      page,
      content: pageText({ text: doc.text, pages, open: index.map.open }, page),
      ...(page === 1 ? outline : {}),
    }
    this._markRead(source, result)
    return { ...result, ...this._unreadFields(source, totalPages) }
  }

  /** What is still unread of a multi-page document, for the result. */
  _unreadFields(source, totalPages) {
    if (totalPages <= 1) return {}
    const unread = this._unreadPages(source, totalPages)
    return {
      unreadCount: unread.count,
      ...(unread.count > 0 ? { unreadPages: unread.ranges } : {}),
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
      entry => ({
        ...entry,
        content: entry?.content || entry?.description,
        page: options.includeContent
          ? searchPage(entry?.content, 'text')
          : undefined,
      })
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
      entry => ({
        ...entry,
        content: entry?.raw_content || entry?.content,
        page: searchPage(
          entry?.raw_content,
          options.includeRawContent === 'text' ? 'text' : 'markdown'
        ),
      })
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
      page: searchPage(entry?.markdown, 'markdown'),
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
      page: options.includeContent
        ? searchPage(entry?.content, 'markdown')
        : undefined,
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
      page: options.includeContent
        ? searchPage(entry?.text, 'text', options.maxCharacters)
        : undefined,
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
      // Text with HTML tags in it is not Markdown, so it is read again
      page: options.includeHtmlTags
        ? undefined
        : searchPage(entry?.text, 'text', options.maxCharacters),
      publishedDate: entry?.publishedDate,
    }))
    return { results: normalizeResults(results, limit, query) }
  }

  /**
   * TinyFish Search API with the user's chosen options. Single GET on the
   * search root with X-API-Key. Search is search-only: pages are read by
   * this server via direct fetch. See https://docs.tinyfish.ai/search-api/reference
   */
  async _tinyfishSearch(query, signal, endpoint) {
    const options = endpoint?.search ?? {}
    const limit = options.maxResults ?? DEFAULT_RESULTS
    const base =
      typeof endpoint?.baseUrl === 'string' && endpoint.baseUrl.trim()
        ? endpoint.baseUrl.trim().replace(/\/+$/, '')
        : typeof options.baseUrl === 'string' && options.baseUrl.trim()
          ? options.baseUrl.trim().replace(/\/+$/, '')
          : TINYFISH_API_BASE
    const params = new URLSearchParams()
    params.set('query', query)
    if (options.domainType) params.set('domain_type', options.domainType)
    if (options.location) params.set('location', options.location)
    if (options.language) params.set('language', options.language)
    if (Array.isArray(options.includeDomains) && options.includeDomains.length > 0) {
      params.set('include_domains', options.includeDomains.join(','))
    }
    if (Array.isArray(options.excludeDomains) && options.excludeDomains.length > 0) {
      params.set('exclude_domains', options.excludeDomains.join(','))
    }
    if (options.domainType === 'research_paper') {
      if (Number.isInteger(options.pubYearMin)) {
        params.set('pub_year_min', String(options.pubYearMin))
      }
      if (Number.isInteger(options.pubYearMax)) {
        params.set('pub_year_max', String(options.pubYearMax))
      }
    } else {
      if (Number.isInteger(options.recencyMinutes)) {
        params.set('recency_minutes', String(options.recencyMinutes))
      } else {
        if (options.afterDate) params.set('after_date', options.afterDate)
        if (options.beforeDate) params.set('before_date', options.beforeDate)
      }
    }
    const url = `${resolveDockerHostUrl(base).replace(/\/+$/, '')}/?${params.toString()}`
    const res = await this._request(
      url,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'X-API-Key': endpoint.apiKey,
        },
      },
      signal,
      'TinyFish',
      'tinyfish'
    )
    let body
    try {
      body = await res.json()
    } catch {
      throw webError('TinyFish returned a response that is not JSON.')
    }
    const rawResults = Array.isArray(body?.results) ? body.results : []
    const results = rawResults.map(entry => ({
      title: entry?.title,
      url: entry?.url,
      content: entry?.snippet || entry?.description || entry?.text,
      publishedDate:
        entry?.date || entry?.publishedDate || entry?.published_date ||
        (Number.isInteger(entry?.year) ? String(entry.year) : undefined),
    }))
    return { results: normalizeResults(results, limit, query) }
  }

  /**
   * Parallel Search API with the user's chosen options.
   * See https://parallel.ai/products/search
   */
  async _parallelSearch(query, signal, endpoint) {
    const options = endpoint?.search ?? {}
    const limit = options.maxResults ?? DEFAULT_RESULTS
    const base =
      typeof endpoint?.baseUrl === 'string' && endpoint.baseUrl.trim()
        ? endpoint.baseUrl.trim().replace(/\/+$/, '')
        : typeof options.baseUrl === 'string' && options.baseUrl.trim()
          ? options.baseUrl.trim().replace(/\/+$/, '')
          : PARALLEL_API_BASE

    const advanced_settings = {
      max_results: Math.min(PARALLEL_MAX_RESULTS, Math.max(1, limit)),
    }
    if (options.location) {
      advanced_settings.location = options.location
    }

    const source_policy = {}
    if (Array.isArray(options.includeDomains) && options.includeDomains.length > 0) {
      source_policy.include_domains = options.includeDomains
    }
    if (Array.isArray(options.excludeDomains) && options.excludeDomains.length > 0) {
      source_policy.exclude_domains = options.excludeDomains
    }
    if (options.afterDate) {
      source_policy.after_date = options.afterDate
    }
    if (Object.keys(source_policy).length > 0) {
      advanced_settings.source_policy = source_policy
    }

    const fetch_policy = {}
    if (Number.isInteger(options.maxAgeSeconds)) {
      fetch_policy.max_age_seconds = Math.max(600, options.maxAgeSeconds)
    }
    if (Number.isInteger(options.timeoutSeconds)) {
      fetch_policy.timeout_seconds = options.timeoutSeconds
    }
    if (typeof options.disableCacheFallback === 'boolean') {
      fetch_policy.disable_cache_fallback = options.disableCacheFallback
    }
    if (Object.keys(fetch_policy).length > 0) {
      advanced_settings.fetch_policy = fetch_policy
    }

    if (Number.isInteger(options.maxCharsPerResult)) {
      advanced_settings.excerpt_settings = {
        max_chars_per_result: options.maxCharsPerResult,
      }
    }

    const q = (typeof query === 'string' ? query.trim() : '') || 'search'
    const payload = {
      search_queries: [q.slice(0, 200)],
      objective: q.slice(0, 5000),
      ...(options.mode ? { mode: options.mode } : {}),
      ...(Number.isInteger(options.maxCharsTotal)
        ? { max_chars_total: options.maxCharsTotal }
        : {}),
      advanced_settings,
    }

    const timeoutMs = Number.isInteger(options.timeoutSeconds)
      ? Math.max(REQUEST_TIMEOUT_MS, (options.timeoutSeconds + 10) * 1000)
      : undefined

    const res = await this._request(
      `${resolveDockerHostUrl(base).replace(/\/+$/, '')}/v1/search`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': endpoint.apiKey,
        },
        body: JSON.stringify(payload),
      },
      signal,
      'Parallel',
      'parallel',
      timeoutMs
    )

    let body
    try {
      body = await res.json()
    } catch {
      throw webError('Parallel returned a response that is not JSON.')
    }

    const rawResults = Array.isArray(body?.results) ? body.results : []
    const results = rawResults.map(entry => ({
      title: entry?.title,
      url: entry?.url,
      content: Array.isArray(entry?.excerpts)
        ? entry.excerpts.join('\n\n')
        : entry?.content || entry?.snippet || '',
      publishedDate:
        entry?.publish_date || entry?.published_date || entry?.publishedDate,
    }))
    return { results: normalizeResults(results, limit, query) }
  }

  /** MCP search endpoint supporting JSON-RPC 2.0 tools/call and legacy webhooks */
  async _resolveMcpPostUrl(url, headers, signal) {
    if (url.endsWith('/sse')) {
      try {
        const sseRes = await this._request(
          url,
          {
            method: 'GET',
            headers: {
              ...headers,
              Accept: 'text/event-stream',
            },
          },
          signal,
          'MCP SSE handshake',
          'mcp',
          5000
        )
        let text = ''
        const reader = sseRes.body?.getReader?.()
        if (reader) {
          try {
            const decoder = new TextDecoder()
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              text += decoder.decode(value, { stream: true })
              if (text.includes('data:') && text.includes('endpoint')) {
                const match = text.match(/event:\s*endpoint[\r\n]+data:\s*([^\r\n]+)/)
                if (match) {
                  reader.cancel().catch(() => {})
                  break
                }
              }
            }
          } catch {
            // ignore stream read error
          }
        } else {
          text = await sseRes.text()
        }
        const match = text.match(/event:\s*endpoint[\r\n]+data:\s*([^\r\n]+)/)
        if (match && match[1]) {
          const resolved = new URL(match[1].trim(), url)
          const baseOrigin = new URL(url).origin
          if (resolved.origin === baseOrigin) {
            validateSafeProviderBaseUrl(resolved.toString())
            return resolved.toString()
          }
        }
      } catch {
        // Fall back to original URL
      }
    }
    return url
  }

  async _mcpInitialize(postUrl, headers, signal) {
    const initPayload = makeJsonRpcRequest(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'overleaf-ai-assist',
          version: '1.0.0',
        },
      },
      0
    )
    await this._request(
      postUrl,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(initPayload),
      },
      signal,
      'MCP Initialize',
      'mcp'
    ).catch(() => {})

    const notifPayload = {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }
    await this._request(
      postUrl,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(notifPayload),
      },
      signal,
      'MCP Initialized',
      'mcp'
    ).catch(() => {})
  }

  async _mcpDiscoverTool(postUrl, headers, signal, endpoint) {
    if (endpoint?.toolName && endpoint?.queryParam) {
      return {
        toolName: endpoint.toolName,
        queryParam: endpoint.queryParam,
      }
    }

    const listPayload = makeJsonRpcRequest('tools/list', {}, 1)
    let res
    try {
      res = await this._request(
        postUrl,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(listPayload),
        },
        signal,
        'MCP Tool Discovery',
        'mcp'
      )
    } catch (err) {
      if (isUninitializedError(err)) {
        await this._mcpInitialize(postUrl, headers, signal)
        res = await this._request(
          postUrl,
          {
            method: 'POST',
            headers,
            body: JSON.stringify(listPayload),
          },
          signal,
          'MCP Tool Discovery',
          'mcp'
        )
      } else {
        throw err
      }
    }

    let body
    try {
      const text = await res.text()
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
    } catch {
      return detectSearchTool([], endpoint?.toolName, endpoint?.queryParam)
    }

    if (
      body?.error &&
      (body.error.code === -32002 ||
        /initialize/i.test(body.error.message || ''))
    ) {
      await this._mcpInitialize(postUrl, headers, signal)
      const retryRes = await this._request(
        postUrl,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(listPayload),
        },
        signal,
        'MCP Tool Discovery',
        'mcp'
      )
      try {
        body = await retryRes.json()
      } catch {
        // ignore
      }
    }

    const tools = Array.isArray(body?.result?.tools) ? body.result.tools : []
    return detectSearchTool(tools, endpoint?.toolName, endpoint?.queryParam)
  }

  async _legacyMcpSearch(url, query, headers, signal) {
    const res = await this._request(
      url,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ q: query }),
      },
      signal,
      'MCP Search',
      'mcp'
    )

    let body
    try {
      const text = await res.text()
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
    } catch {
      throw webError('MCP search returned an unreadable response.')
    }

    const results = extractMcpSearchResults(body, query)
    return {
      results: normalizeResults(results, Number.MAX_SAFE_INTEGER, query),
    }
  }

  /** MCP search endpoint */
  async _mcpSearch(query, signal, endpoint) {
    const baseUrl = endpoint?.baseUrl
    const rawUrl = resolveDockerHostUrl(baseUrl)
    const cacheKey = rawUrl
    const cached = mcpEndpointCache.get(cacheKey)

    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
    }

    if (Array.isArray(endpoint?.headers)) {
      for (const h of endpoint.headers) {
        if (h && typeof h.key === 'string' && typeof h.value === 'string') {
          headers[h.key] = h.value
        }
      }
    } else if (endpoint?.headers && typeof endpoint.headers === 'object') {
      for (const [key, value] of Object.entries(endpoint.headers)) {
        if (typeof key === 'string' && typeof value === 'string') {
          headers[key] = value
        }
      }
    }

    let postUrl = cached?.postUrl || rawUrl
    if (!cached?.postUrl && rawUrl.endsWith('/sse')) {
      postUrl = await this._resolveMcpPostUrl(rawUrl, headers, signal)
    }

    // A tool the user named is always called as JSON-RPC; the legacy shortcut
    // only applies to endpoints whose tool is left to be discovered.
    if (cached?.isLegacy && !endpoint?.toolName) {
      return this._legacyMcpSearch(postUrl, query, headers, signal)
    }

    let toolName = endpoint?.toolName || cached?.toolName || 'search'
    let queryParam = endpoint?.queryParam || cached?.queryParam || 'query'

    const callPayload = makeJsonRpcRequest(
      'tools/call',
      {
        name: toolName,
        arguments: {
          [queryParam]: query,
        },
      },
      1
    )

    let res
    try {
      res = await this._request(
        postUrl,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(callPayload),
        },
        signal,
        'MCP Search',
        'mcp'
      )
    } catch (err) {
      if (isUninitializedError(err)) {
        await this._mcpInitialize(postUrl, headers, signal)
        res = await this._request(
          postUrl,
          {
            method: 'POST',
            headers,
            body: JSON.stringify(callPayload),
          },
          signal,
          'MCP Search',
          'mcp'
        )
      } else if (!endpoint?.toolName && isLegacyFallbackCandidate(err)) {
        try {
          const legacyRes = await this._legacyMcpSearch(
            postUrl,
            query,
            headers,
            signal
          )
          setMcpEndpointCache(cacheKey, { postUrl, isLegacy: true })
          return legacyRes
        } catch {
          throw err
        }
      } else {
        throw err
      }
    }

    let body
    try {
      const text = await res.text()
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
    } catch {
      throw webError('MCP search returned an unreadable response.')
    }

    if (
      body?.error &&
      (body.error.code === -32002 ||
        /initialize/i.test(body.error.message || ''))
    ) {
      await this._mcpInitialize(postUrl, headers, signal)
      const retryRes = await this._request(
        postUrl,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(callPayload),
        },
        signal,
        'MCP Search',
        'mcp'
      )
      try {
        const retryText = await retryRes.text()
        try {
          body = JSON.parse(retryText)
        } catch {
          body = retryText
        }
      } catch {
        // ignore
      }
    }

    if (!endpoint?.toolName && isToolNotFoundError(body)) {
      try {
        const discovered = await this._mcpDiscoverTool(
          postUrl,
          headers,
          signal,
          endpoint
        )
        if (discovered.toolName && discovered.toolName !== toolName) {
          toolName = discovered.toolName
          queryParam = discovered.queryParam
          setMcpEndpointCache(cacheKey, {
            postUrl,
            toolName,
            queryParam,
            isLegacy: false,
          })

          const retryPayload = makeJsonRpcRequest(
            'tools/call',
            {
              name: toolName,
              arguments: {
                [queryParam]: query,
              },
            },
            2
          )
          const retryRes = await this._request(
            postUrl,
            {
              method: 'POST',
              headers,
              body: JSON.stringify(retryPayload),
            },
            signal,
            'MCP Search',
            'mcp'
          )
          try {
            const retryText = await retryRes.text()
            try {
              body = JSON.parse(retryText)
            } catch {
              body = retryText
            }
          } catch {
            // ignore
          }
        }
      } catch {
        // keep current body
      }
    }

    const results = extractMcpSearchResults(body, query)
    return {
      results: normalizeResults(results, Number.MAX_SAFE_INTEGER, query),
    }
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

/**
 * Probes the health of a single provider endpoint without burning live search quotas.
 */
export async function probeProviderHealth(
  provider,
  endpoint,
  { signal, fetchFn, tools } = {}
) {
  const startedAt = Date.now()
  const timeoutMs = 5000
  const timeout = AbortSignal.timeout(timeoutMs)
  const combinedSignal = AbortSignal.any([signal, timeout].filter(Boolean))

  try {
    if (
      ['searxng', 'firecrawlSelfHosted', 'mcp'].includes(provider) &&
      !endpoint?.baseUrl
    ) {
      return {
        provider,
        ok: false,
        latencyMs: 0,
        error: 'Missing instance URL',
      }
    }
    if (
      !['searxng', 'firecrawlSelfHosted', 'mcp'].includes(provider) &&
      !endpoint?.apiKey
    ) {
      return {
        provider,
        ok: false,
        latencyMs: 0,
        error: 'Missing API key',
      }
    }

    switch (provider) {
      case 'tavily': {
        await apiRequest(
          'https://api.tavily.com/usage',
          {
            method: 'GET',
            headers: { Authorization: `Bearer ${endpoint.apiKey}` },
          },
          {
            signal: combinedSignal,
            label: 'Tavily',
            providerType: 'tavily',
            timeoutMs,
            fetchFn,
          }
        )
        break
      }
      case 'exa': {
        await apiRequest(
          'https://api.exa.ai/monitors',
          {
            method: 'GET',
            headers: { 'x-api-key': endpoint.apiKey },
          },
          {
            signal: combinedSignal,
            label: 'Exa',
            providerType: 'exa',
            timeoutMs,
            fetchFn,
          }
        )
        break
      }
      case 'firecrawl': {
        await apiRequest(
          'https://api.firecrawl.dev/v1/team/credit-usage',
          {
            method: 'GET',
            headers: { Authorization: `Bearer ${endpoint.apiKey}` },
          },
          {
            signal: combinedSignal,
            label: 'Firecrawl',
            providerType: 'firecrawl',
            timeoutMs,
            fetchFn,
          }
        )
        break
      }
      case 'firecrawlSelfHosted': {
        const base = (endpoint.baseUrl || '').replace(/\/+$/, '')
        try {
          await apiRequest(
            `${base}/v1/health`,
            { method: 'GET' },
            {
              signal: combinedSignal,
              label: 'Firecrawl (self-hosted)',
              providerType: 'firecrawlSelfHosted',
              timeoutMs,
              fetchFn,
            }
          )
        } catch (err) {
          if (err?.status === 404) {
            await apiRequest(
              `${base}/health`,
              { method: 'GET' },
              {
                signal: combinedSignal,
                label: 'Firecrawl (self-hosted)',
                providerType: 'firecrawlSelfHosted',
                timeoutMs,
                fetchFn,
              }
            )
          } else {
            throw err
          }
        }
        break
      }
      case 'searxng': {
        const base = (endpoint.baseUrl || '').replace(/\/+$/, '')
        try {
          await apiRequest(
            `${base}/healthz`,
            { method: 'GET' },
            {
              signal: combinedSignal,
              label: 'SearXNG',
              providerType: 'searxng',
              timeoutMs,
              fetchFn,
            }
          )
        } catch (err) {
          if (err?.status === 404) {
            await apiRequest(
              `${base}/config`,
              { method: 'GET' },
              {
                signal: combinedSignal,
                label: 'SearXNG',
                providerType: 'searxng',
                timeoutMs,
                fetchFn,
              }
            )
          } else {
            throw err
          }
        }
        break
      }
      case 'jina': {
        await apiRequest(
          'https://s.jina.ai/',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${endpoint.apiKey}`,
              'X-Respond-With': 'no-content',
            },
            body: JSON.stringify({ q: 'ping', num: 1 }),
          },
          {
            signal: combinedSignal,
            label: 'Jina AI',
            providerType: 'jina',
            timeoutMs,
            fetchFn,
          }
        )
        break
      }
      case 'websearchapi': {
        await apiRequest(
          'https://api.websearchapi.ai/ai-search',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${endpoint.apiKey}`,
            },
            body: JSON.stringify({ query: 'ping', maxResults: 1 }),
          },
          {
            signal: combinedSignal,
            label: 'WebSearchAPI.ai',
            providerType: 'websearchapi',
            timeoutMs,
            fetchFn,
          }
        )
        break
      }
      case 'langsearch': {
        await apiRequest(
          'https://api.langsearch.com/v1/web-search',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${endpoint.apiKey}`,
            },
            body: JSON.stringify({ query: 'ping', count: 1 }),
          },
          {
            signal: combinedSignal,
            label: 'LangSearch',
            providerType: 'langsearch',
            timeoutMs,
            fetchFn,
          }
        )
        break
      }
      case 'tinyfish': {
        const base = (
          endpoint.baseUrl || 'https://api.search.tinyfish.ai'
        ).replace(/\/+$/, '')
        await apiRequest(
          `${base}/?query=ping`,
          {
            method: 'GET',
            headers: { 'X-API-Key': endpoint.apiKey },
          },
          {
            signal: combinedSignal,
            label: 'TinyFish',
            providerType: 'tinyfish',
            timeoutMs,
            fetchFn,
          }
        )
        break
      }
      case 'parallel': {
        const base = (
          endpoint.baseUrl ||
          endpoint.search?.baseUrl ||
          PARALLEL_API_BASE
        ).replace(/\/+$/, '')
        await apiRequest(
          `${base}/v1/search`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': endpoint.apiKey,
            },
            body: JSON.stringify({
              search_queries: ['ping'],
              objective: 'ping',
              mode: endpoint.search?.mode || 'turbo',
              advanced_settings: {
                max_results: 1,
              },
            }),
          },
          {
            signal: combinedSignal,
            label: 'Parallel',
            providerType: 'parallel',
            timeoutMs,
            fetchFn,
          }
        )
        break
      }
      case 'ollama': {
        await apiRequest(
          'https://ollama.com/api/web_search',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${endpoint.apiKey}`,
            },
            body: JSON.stringify({ query: 'ping', max_results: 1 }),
          },
          {
            signal: combinedSignal,
            label: 'Ollama web search',
            providerType: 'ollama',
            timeoutMs,
            fetchFn,
          }
        )
        break
      }
      case 'mcp': {
        if (tools && typeof tools._mcpSearch === 'function') {
          await tools._mcpSearch('ping', combinedSignal, endpoint)
        } else {
          const base = (endpoint.baseUrl || '').replace(/\/+$/, '')
          await apiRequest(
            base,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ q: 'ping' }),
            },
            {
              signal: combinedSignal,
              label: 'MCP WebSearch',
              providerType: 'mcp',
              timeoutMs,
              fetchFn,
            }
          )
        }
        break
      }
      default:
        throw new Error(`Unknown provider '${provider}'`)
    }

    return {
      provider,
      ok: true,
      latencyMs: Date.now() - startedAt,
    }
  } catch (err) {
    return {
      provider,
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: err?.message || 'Connection failed',
    }
  }
}

/**
 * Runs parallel zero-credit / lightweight health checks across all enabled search providers.
 * Strictly tests only the first credential (index 0) per provider to avoid token/quota waste.
 */
export async function testWebSearch(settings, { signal, fetchFn } = {}) {
  const tools = new AiAssistWebTools(settings, fetchFn ? { fetchFn } : {})

  // Group endpoints by provider and strictly select only the first endpoint (index 0)
  const enabledProviders = new Map()
  for (const endpoint of tools.rotator.pool) {
    if (SEARCH_PROVIDERS.has(endpoint.provider)) {
      if (!enabledProviders.has(endpoint.provider)) {
        enabledProviders.set(endpoint.provider, endpoint)
      }
    }
  }

  const targetEndpoints = Array.from(enabledProviders.values())
  if (targetEndpoints.length === 0) {
    throw new ProviderError(
      'No web search providers are configured or enabled.',
      {
        code: 'invalidWebSearchSettings',
        status: 400,
      }
    )
  }

  const probePromises = targetEndpoints.map(endpoint =>
    probeProviderHealth(endpoint.provider, endpoint, { signal, fetchFn, tools })
  )

  const settled = await Promise.allSettled(probePromises)
  const results = settled.map((outcome, idx) => {
    if (outcome.status === 'fulfilled') {
      return outcome.value
    }
    return {
      provider: targetEndpoints[idx].provider,
      ok: false,
      latencyMs: 0,
      error: outcome.reason?.message || 'Unexpected probe failure',
    }
  })

  const anySuccess = results.some(r => r.ok)
  const maxLatency = Math.max(0, ...results.map(r => r.latencyMs || 0))
  const firstOk = results.find(r => r.ok)

  return {
    latencyMs: maxLatency,
    anySuccess,
    results,
    activeEndpoints: results.length,
    provider: firstOk ? firstOk.provider : results[0]?.provider || null,
    resultCount: results.filter(r => r.ok).length,
  }
}
