import { resolveDockerHostUrl } from '../../AiAssistProviders.mjs'
import { apiJson } from '../api.mjs'
import { makeDocument } from '../document.mjs'
import { REQUEST_TIMEOUT_MS } from '../transport.mjs'
import { isoDay, webError } from '../util.mjs'
import { classifyFailure } from '../routing.mjs'

/**
 * Hosted services that read a page for us.
 */

export const OLLAMA_API_BASE = 'https://ollama.com/api'
export const WEBSEARCHAPI_BASE = 'https://api.websearchapi.ai'
export const WEBSEARCHAPI_DEFAULT_SCRAPE_TIMEOUT_S = 10
export const TAVILY_API_BASE = 'https://api.tavily.com'
export const FIRECRAWL_API_BASE = 'https://api.firecrawl.dev'
/** Firecrawl waits 60s for a scrape or search unless told otherwise. */
const FIRECRAWL_DEFAULT_TIMEOUT_MS = 60_000
export const JINA_SEARCH_BASE = 'https://s.jina.ai'
export const JINA_READER_BASE = 'https://r.jina.ai'
/** Jina waits up to 25s for pages unless given an X-Timeout. */
const JINA_DEFAULT_TIMEOUT_S = 25
export const EXA_API_BASE = 'https://api.exa.ai'
const READER_TIMEOUT_MS = 30_000

export const READER_ORDER = [
  'ollama',
  'websearchapi',
  'tavily',
  'firecrawl',
  'firecrawlSelfHosted',
  'jina',
  'exa',
]
export const READER_LABELS = {
  ollama: 'Ollama',
  websearchapi: 'WebSearchAPI.ai',
  tavily: 'Tavily',
  firecrawl: 'Firecrawl',
  firecrawlSelfHosted: 'Firecrawl (self-hosted)',
  jina: 'Jina Reader',
  exa: 'Exa',
}

function text(value) {
  return typeof value === 'string' ? value : ''
}

function jsonHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  }
}

/** Tavily's key, and the project its usage is filed under when one is set. */
export function tavilyHeaders({ apiKey, projectId } = {}) {
  return {
    ...jsonHeaders(apiKey),
    ...(projectId ? { 'X-Project-ID': projectId } : {}),
  }
}

/**
 * Firecrawl Cloud with its API key, or a self-hosted instance at `baseUrl`,
 * which runs without authentication and gets no Authorization header.
 */
export function firecrawlRequest(endpoint = {}, path) {
  const base = endpoint.baseUrl
    ? resolveDockerHostUrl(endpoint.baseUrl)
    : FIRECRAWL_API_BASE
  return {
    url: `${base}/v2/${path}`,
    headers: endpoint.apiKey
      ? jsonHeaders(endpoint.apiKey)
      : { 'Content-Type': 'application/json' },
  }
}

/**
 * The user's scrape options as Firecrawl's scrape body takes them, for
 * web_fetch and for the pages a search reads alike.
 */
export function firecrawlScrapeOptions(scrape = {}) {
  const { pdfMode, country, languages, ...rest } = scrape
  return {
    formats: ['markdown'],
    onlyMainContent: true,
    ...rest,
    ...(pdfMode ? { parsers: [{ type: 'pdf', mode: pdfMode }] } : {}),
    ...(country || languages
      ? {
          location: {
            ...(country ? { country } : {}),
            ...(languages ? { languages } : {}),
          },
        }
      : {}),
  }
}

/** Long enough for Firecrawl to hit its own timeout and say so. */
export function firecrawlTimeoutMs(timeoutMs = FIRECRAWL_DEFAULT_TIMEOUT_MS) {
  return Math.max(REQUEST_TIMEOUT_MS, timeoutMs + 10_000)
}

/** Long enough for Jina to hit its own timeout and say so. */
export function jinaTimeoutMs(seconds = JINA_DEFAULT_TIMEOUT_S) {
  return Math.max(REQUEST_TIMEOUT_MS, (seconds + 10) * 1000)
}

/** Long enough for Exa to hit its livecrawl timeout. */
export function exaTimeoutMs(timeoutMs) {
  if (Number.isInteger(timeoutMs) && timeoutMs > 0) {
    return Math.max(REQUEST_TIMEOUT_MS, timeoutMs + 10_000)
  }
  return READER_TIMEOUT_MS
}

/**
 * Jina takes its options as headers. JSON mode returns the page with its
 * title and the status the page itself answered with.
 */
export function jinaHeaders(apiKey, read = {}, { fresh = false } = {}) {
  const flag = value => (value ? 'true' : undefined)
  const headers = {
    ...jsonHeaders(apiKey),
    Accept: 'application/json',
    'X-Engine': read.engine,
    'X-Timeout': read.timeout ? String(read.timeout) : undefined,
    'X-Target-Selector': read.targetSelector,
    'X-Remove-Selector': read.removeSelector,
    'X-Retain-Images': read.retainImages,
    'X-With-Generated-Alt': flag(read.withGeneratedAlt),
    'X-With-Iframe': flag(read.withIframe),
    'X-With-Shadow-Dom': flag(read.withShadowDom),
    'X-Respond-With': read.respondWith,
    'X-Proxy': read.proxy,
    'X-Locale': read.locale,
    'X-No-Cache': flag(read.noCache || fresh),
    'X-Cache-Tolerance':
      read.cacheTolerance === undefined || read.noCache || fresh
        ? undefined
        : String(read.cacheTolerance),
    'X-Token-Budget': read.tokenBudget ? String(read.tokenBudget) : undefined,
    'X-Wait-For-Selector': read.waitForSelector,
    DNT: read.dnt ? '1' : undefined,
  }
  return Object.fromEntries(
    Object.entries(headers).filter(([, value]) => value !== undefined)
  )
}

/** Tavily waits 10s for a basic extraction and 30s for an advanced one. */
function extractTimeoutMs(extract = {}) {
  const seconds =
    extract.timeout ?? (extract.extractDepth === 'advanced' ? 30 : 10)
  return Math.max(REQUEST_TIMEOUT_MS, (seconds + 10) * 1000)
}

function scrapeTimeoutMs(scrape = {}) {
  return Math.max(
    REQUEST_TIMEOUT_MS,
    ((scrape.timeout ?? WEBSEARCHAPI_DEFAULT_SCRAPE_TIMEOUT_S) + 10) * 1000
  )
}

/** How long the ladder gives one reader, across all of its keys. */
export function readerTimeoutMs(name, router) {
  const endpoint = router?.pool?.find(e => e.provider === name)
  if (name === 'websearchapi') {
    return Math.max(READER_TIMEOUT_MS, scrapeTimeoutMs(endpoint?.scrape))
  }
  if (name === 'tavily') {
    return Math.max(READER_TIMEOUT_MS, extractTimeoutMs(endpoint?.extract))
  }
  if (name === 'firecrawl' || name === 'firecrawlSelfHosted') {
    return Math.max(
      READER_TIMEOUT_MS,
      firecrawlTimeoutMs(endpoint?.scrape?.timeout)
    )
  }
  if (name === 'jina') {
    return Math.max(READER_TIMEOUT_MS, jinaTimeoutMs(endpoint?.read?.timeout))
  }
  if (name === 'exa') {
    return Math.max(
      READER_TIMEOUT_MS,
      exaTimeoutMs(endpoint?.read?.livecrawlTimeout)
    )
  }
  return READER_TIMEOUT_MS
}

/**
 * Executes a reader across its provided endpoints.
 * Handles failure classification:
 * - key/rate: pause endpoint, try next key
 * - provider/content: throw immediately to move to next provider
 */
async function withEndpoints(provider, endpoints = [], router, readOne) {
  let lastErr = webError(`No ${READER_LABELS[provider]} API key is set.`, {
    kind: 'network',
  })

  for (const endpoint of endpoints) {
    try {
      const doc = await readOne(endpoint)
      router?.success?.(endpoint, 'read')
      return doc
    } catch (err) {
      if (err?.code === 'aborted') throw err
      const classification =
        router?.failure?.(endpoint, err) ?? classifyFailure(err)
      lastErr = err

      if (classification.class === 'key' || classification.class === 'rate') {
        continue
      }
      // provider error, content error, or unclassified: stop iterating keys and move to next provider
      break
    }
  }

  if (!lastErr.kind) lastErr.kind = 'http'
  throw lastErr
}

export function ollamaReader(
  url,
  { signal, endpoints, rotator, router = rotator, fetchFn }
) {
  const targetEndpoints =
    endpoints || router?.pool?.filter(e => e.provider === 'ollama') || []
  return withEndpoints('ollama', targetEndpoints, router, async endpoint => {
    const body = await apiJson(
      `${OLLAMA_API_BASE}/web_fetch`,
      {
        method: 'POST',
        headers: jsonHeaders(endpoint.apiKey),
        body: JSON.stringify({ url }),
      },
      { signal, label: 'Ollama web search', providerType: 'ollama', fetchFn }
    )
    return makeDocument({
      url,
      title: text(body?.title),
      text: text(body?.content),
    })
  })
}

export function websearchapiReader(
  url,
  { signal, endpoints, rotator, router = rotator, fetchFn, fresh }
) {
  const targetEndpoints =
    endpoints || router?.pool?.filter(e => e.provider === 'websearchapi') || []
  return withEndpoints(
    'websearchapi',
    targetEndpoints,
    router,
    async endpoint => {
      const scrape = endpoint.scrape ?? {}
      const body = await apiJson(
        `${WEBSEARCHAPI_BASE}/scrape`,
        {
          method: 'POST',
          headers: jsonHeaders(endpoint.apiKey),
          body: JSON.stringify({
            url,
            returnFormat: 'markdown',
            ...scrape,
            ...(fresh ? { noCache: true } : {}),
          }),
        },
        {
          signal,
          label: 'WebSearchAPI.ai',
          providerType: 'websearchapi',
          fetchFn,
          timeoutMs: scrapeTimeoutMs(scrape),
        }
      )
      const data = body?.data ?? {}
      return makeDocument({
        url,
        title: text(data.title),
        text: text(data.content),
      })
    }
  )
}

/** A page Tavily could not read comes back in failed_results, not as an HTTP error. */
export function tavilyReader(
  url,
  { signal, endpoints, rotator, router = rotator, fetchFn }
) {
  const targetEndpoints =
    endpoints || router?.pool?.filter(e => e.provider === 'tavily') || []
  return withEndpoints('tavily', targetEndpoints, router, async endpoint => {
    const extract = endpoint.extract ?? {}
    const body = await apiJson(
      `${TAVILY_API_BASE}/extract`,
      {
        method: 'POST',
        headers: tavilyHeaders(endpoint),
        body: JSON.stringify({
          urls: url,
          extract_depth: extract.extractDepth,
          format: extract.format,
          timeout: extract.timeout,
        }),
      },
      {
        signal,
        label: 'Tavily',
        providerType: 'tavily',
        fetchFn,
        timeoutMs: extractTimeoutMs(extract),
      }
    )
    const result = Array.isArray(body?.results) ? body.results[0] : null
    if (!result) {
      const failed = Array.isArray(body?.failed_results)
        ? body.failed_results[0]
        : null
      throw webError(
        `Tavily could not read ${url}${failed?.error ? `: ${failed.error}` : ''}.`
      )
    }
    const content = text(result.raw_content)
    const format = extract.format === 'text' ? 'text' : 'markdown'
    const title = format === 'markdown' ? /^# (.+)$/m.exec(content)?.[1] : ''
    return makeDocument({ url, title: text(title), text: content, format })
  })
}

function firstText(value) {
  return text(Array.isArray(value) ? value[0] : value)
}

/**
 * Firecrawl's /v2/scrape, for Firecrawl Cloud and self-hosted instances alike.
 * The status of the page itself is in the metadata: a 404 page is not content.
 */
function firecrawlReaderFor(provider) {
  return (
    url,
    { signal, endpoints, rotator, router = rotator, fetchFn, fresh }
  ) => {
    const targetEndpoints =
      endpoints || router?.pool?.filter(e => e.provider === provider) || []
    return withEndpoints(provider, targetEndpoints, router, async endpoint => {
      const scrape = endpoint.scrape ?? {}
      const request = firecrawlRequest(endpoint, 'scrape')
      const body = await apiJson(
        request.url,
        {
          method: 'POST',
          headers: request.headers,
          body: JSON.stringify({
            url,
            ...firecrawlScrapeOptions(scrape),
            ...(fresh ? { maxAge: 0 } : {}),
          }),
        },
        {
          signal,
          label: READER_LABELS[provider],
          providerType: provider,
          fetchFn,
          timeoutMs: firecrawlTimeoutMs(scrape.timeout),
        }
      )
      const data = body?.data ?? {}
      const metadata = data.metadata ?? {}
      if (body?.success === false || metadata.statusCode >= 400) {
        const reason =
          text(body?.error) ||
          text(metadata.error) ||
          (metadata.statusCode
            ? `the page returned HTTP ${metadata.statusCode}`
            : '')
        throw webError(
          `${READER_LABELS[provider]} could not read ${url}${reason ? `: ${reason}` : ''}.`
        )
      }
      const published = isoDay(
        firstText(metadata.publishedTime) ||
          firstText(metadata['article:published_time'])
      )
      return makeDocument({
        url,
        title: firstText(metadata.title),
        text: text(data.markdown),
        ...(published ? { published } : {}),
      })
    })
  }
}

export const firecrawlReader = firecrawlReaderFor('firecrawl')
export const firecrawlSelfHostedReader = firecrawlReaderFor(
  'firecrawlSelfHosted'
)

/**
 * Jina's Reader API. A page that answered with an error still comes back as
 * HTTP 200, with the page's own status in httpStatus. Its publishedTime falls
 * back to the Last-Modified header, so only the article's own date is kept.
 */
export function jinaReader(
  url,
  { signal, endpoints, rotator, router = rotator, fetchFn, fresh }
) {
  const targetEndpoints =
    endpoints || router?.pool?.filter(e => e.provider === 'jina') || []
  return withEndpoints('jina', targetEndpoints, router, async endpoint => {
    const read = endpoint.read ?? {}
    const body = await apiJson(
      `${JINA_READER_BASE}/`,
      {
        method: 'POST',
        headers: jinaHeaders(endpoint.apiKey, read, { fresh }),
        body: JSON.stringify({ url }),
      },
      {
        signal,
        label: READER_LABELS.jina,
        providerType: 'jina',
        fetchFn,
        timeoutMs: jinaTimeoutMs(read.timeout),
      }
    )
    const data = body?.data ?? {}
    if (data.httpStatus >= 400) {
      throw webError(
        `${READER_LABELS.jina} could not read ${url}: the page returned HTTP ${data.httpStatus}.`
      )
    }
    const published = isoDay(
      firstText(data.metadata?.['article:published_time'])
    )
    return makeDocument({
      url,
      title: text(data.title),
      text: text(data.content),
      ...(published ? { published } : {}),
    })
  })
}

/**
 * Exa's Get Contents API. Reads a web page and returns its extracted text,
 * highlights, and/or summary.
 */
export function exaReader(
  url,
  { signal, endpoints, rotator, router = rotator, fetchFn }
) {
  const targetEndpoints =
    endpoints || router?.pool?.filter(e => e.provider === 'exa') || []
  return withEndpoints('exa', targetEndpoints, router, async endpoint => {
    const read = endpoint.read ?? {}
    const textOption = read.maxCharacters
      ? {
          maxCharacters: read.maxCharacters,
          ...(read.includeHtmlTags ? { includeHtmlTags: true } : {}),
        }
      : read.includeHtmlTags
        ? { includeHtmlTags: true }
        : true

    const highlightsOption = read.highlights
      ? read.numSentences || read.highlightsPerUrl || read.highlightsQuery
        ? {
            ...(read.numSentences ? { numSentences: read.numSentences } : {}),
            ...(read.highlightsPerUrl
              ? { highlightsPerUrl: read.highlightsPerUrl }
              : {}),
            ...(read.highlightsQuery ? { query: read.highlightsQuery } : {}),
          }
        : true
      : undefined

    const summaryOption = read.summary
      ? read.summaryQuery
        ? { query: read.summaryQuery }
        : true
      : undefined

    const payload = {
      urls: [url],
      text: textOption,
      ...(highlightsOption ? { highlights: highlightsOption } : {}),
      ...(summaryOption ? { summary: summaryOption } : {}),
      ...(read.livecrawl ? { livecrawl: read.livecrawl } : {}),
      ...(read.livecrawlTimeout
        ? { livecrawlTimeout: read.livecrawlTimeout }
        : {}),
      ...(read.subpages ? { subpages: read.subpages } : {}),
      ...(read.subpageTarget ? { subpageTarget: read.subpageTarget } : {}),
    }

    const body = await apiJson(
      `${EXA_API_BASE}/contents`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': endpoint.apiKey,
        },
        body: JSON.stringify(payload),
      },
      {
        signal,
        label: READER_LABELS.exa,
        providerType: 'exa',
        fetchFn,
        timeoutMs: exaTimeoutMs(read.livecrawlTimeout),
      }
    )

    const data = Array.isArray(body?.results) ? body.results[0] : null
    const status = Array.isArray(body?.statuses) ? body.statuses[0] : null
    if (status?.status === 'error' || status?.error) {
      throw webError(
        `${READER_LABELS.exa} could not read ${url}: ${status.error || 'the page could not be retrieved'}.`
      )
    }
    if (!data) {
      throw webError(
        `${READER_LABELS.exa} could not read ${url}: no content returned.`
      )
    }
    const content =
      text(data.text) ||
      (Array.isArray(data.highlights) ? data.highlights.join('\n\n') : '') ||
      text(data.summary)

    if (!content) {
      throw webError(
        `${READER_LABELS.exa} could not read ${url}: page text was empty.`
      )
    }

    const published = isoDay(data.publishedDate)
    return makeDocument({
      url,
      title: text(data.title),
      text: content,
      ...(published ? { published } : {}),
    })
  })
}

export const READERS = {
  ollama: ollamaReader,
  websearchapi: websearchapiReader,
  tavily: tavilyReader,
  firecrawl: firecrawlReader,
  firecrawlSelfHosted: firecrawlSelfHostedReader,
  jina: jinaReader,
  exa: exaReader,
}
