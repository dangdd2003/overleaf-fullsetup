export type ProviderType = 'openai' | 'anthropic' | 'google' | 'ollama'

export type ProviderSettings = {
  type: ProviderType
  baseUrl: string
  apiKey: string
  model: string
  modelName?: string
  /**
   * User-supplied on purpose: the window of an arbitrary Ollama model or an
   * OpenAI-compatible endpoint cannot be detected, and guessing silently fails
   * worse than asking.
   */
  contextWindow?: number
  maxOutputTokens?: number
  /** Unset leaves the choice to the provider's own default. */
  reasoningEffort?: ReasoningEffort
  /** The composer's thinking switch; unset leaves the provider's default. */
  thinking?: boolean
}

export type ReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

/**
 * The levels each provider documents, lowest first. An OpenAI-compatible
 * endpoint decides which of OpenAI's levels its model takes. No level at all
 * is "Auto": the provider's own default.
 */
export const REASONING_EFFORTS: Record<ProviderType, ReasoningEffort[]> = {
  openai: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  anthropic: ['low', 'medium', 'high', 'xhigh', 'max'],
  google: ['minimal', 'low', 'medium', 'high'],
  ollama: ['low', 'medium', 'high'],
}

/** OpenAI has effort levels only, so it gets no thinking switch. */
export function hasThinkingSwitch(type: ProviderType) {
  return type !== 'openai'
}

export type WebSearchRotationStrategy =
  | 'round-robin'
  | 'provider-priority'
  | 'sticky'

export type WebSearchPrimaryProvider =
  | 'searxng'
  | 'ollama'
  | 'websearchapi'
  | 'tavily'
  | 'firecrawl'
  | 'firecrawlSelfHosted'
  | 'jina'
  | 'langsearch'
  | 'exa'
  | 'tinyfish'
  | 'parallel'
  | 'mcp'

export interface McpHeader {
  key: string
  value: string
}

export interface McpProviderConfig {
  enabled: boolean
  serverUrls: string[]
  headers?: McpHeader[]
  toolName?: string
  queryParam?: string
}

export interface OllamaProviderConfig {
  enabled: boolean
  apiKeys: string[]
  /** 1 to 10; unset asks for 10. */
  maxResults?: number
}

export type WebsearchapiLength = 'short' | 'medium' | 'long'

/** Defaults for WebSearchAPI.ai's Search API; a missing one is the API's. */
export interface WebsearchapiSearchOptions {
  /** 1 to 20; unset asks for 10. */
  maxResults?: number
  country?: string
  language?: string
  sortBy?: 'relevance' | 'date'
  safeSearch?: boolean
  includeDomains?: string[]
  excludeDomains?: string[]
  includeContent?: boolean
  contentLength?: WebsearchapiLength
  includeAnswer?: boolean
  answerLength?: WebsearchapiLength
  timeframe?: 'day' | 'week' | 'month' | 'year'
  siteSearch?: string
  exactTerms?: string
  excludeTerms?: string
  fileType?: string
}

/** How WebSearchAPI.ai's Scraper API reads pages for web_fetch. */
export interface WebsearchapiScrapeOptions {
  engine?: 'direct' | 'browser' | 'cf-browser-rendering'
  timeout?: number
  /** 100 to 1000000. */
  tokenBudget?: number
  retainImages?: 'all' | 'none'
  targetSelector?: string
  removeSelector?: string
  respondWith?: 'default' | 'readerlm-v2'
  proxy?: string
  locale?: string
  withGeneratedAlt?: boolean
  withIframe?: boolean
  withShadowDom?: boolean
  noCache?: boolean
  dnt?: boolean
}

export interface WebsearchapiProviderConfig {
  enabled: boolean
  apiKeys: string[]
  search?: WebsearchapiSearchOptions
  scrape?: WebsearchapiScrapeOptions
}

/** Defaults for Tavily's Search API; a missing one is the API's. */
export interface TavilySearchOptions {
  /** 1 to 20; unset asks for 10. */
  maxResults?: number
  searchDepth?: 'basic' | 'advanced' | 'fast' | 'ultra-fast'
  chunksPerSource?: number
  topic?: 'general' | 'news' | 'finance'
  timeRange?: 'day' | 'week' | 'month' | 'year'
  startDate?: string
  endDate?: string
  includePublishedDate?: boolean
  filterByPublishedDate?: boolean
  includeAnswer?: 'basic' | 'advanced'
  includeRawContent?: 'markdown' | 'text'
  includeDomains?: string[]
  excludeDomains?: string[]
  includeDomainsMode?: 'restrict' | 'prefer'
  country?: string
  language?: string
  filterByLanguage?: boolean
  autoParameters?: boolean
  exactMatch?: boolean
  safeSearch?: boolean
}

/** How Tavily's Extract API reads pages for web_fetch. */
export interface TavilyExtractOptions {
  extractDepth?: 'basic' | 'advanced'
  format?: 'markdown' | 'text'
  timeout?: number
}

export interface TavilyProviderConfig {
  enabled: boolean
  apiKeys: string[]
  projectId?: string
  search?: TavilySearchOptions
  extract?: TavilyExtractOptions
}

/** Defaults for Firecrawl's Search API; a missing one is the API's. */
export interface FirecrawlSearchOptions {
  /** 1 to 100; unset asks for 10. */
  maxResults?: number
  categories?: ('developer' | 'pdf')[]
  timeRange?: 'hour' | 'day' | 'week' | 'month' | 'year'
  sortByDate?: boolean
  includeDomains?: string[]
  excludeDomains?: string[]
  country?: string
  location?: string
  safeSearch?: boolean
  scrapeResults?: boolean
  /** Milliseconds, 1000 to 300000. */
  timeout?: number
  sources?: ('web' | 'news')[]
  highlights?: boolean
}

/** How Firecrawl's Scrape API reads pages for web_fetch. */
export interface FirecrawlScrapeOptions {
  onlyMainContent?: boolean
  onlyCleanContent?: boolean
  /** Milliseconds a cached copy may be old. */
  maxAge?: number
  pdfMode?: 'fast' | 'auto' | 'ocr'
  country?: string
  languages?: string[]
  includeTags?: string[]
  excludeTags?: string[]
  /** Milliseconds to wait before reading the page. */
  waitFor?: number
  /** Milliseconds, 1000 to 300000. */
  timeout?: number
  mobile?: boolean
  blockAds?: boolean
  /** Firecrawl Cloud only. */
  proxy?: 'basic' | 'enhanced' | 'auto'
  /** Firecrawl Cloud only. */
  zeroDataRetention?: boolean
}

export interface FirecrawlProviderConfig {
  enabled: boolean
  apiKeys: string[]
  search?: FirecrawlSearchOptions
  scrape?: FirecrawlScrapeOptions
}

export interface FirecrawlSelfHostedProviderConfig {
  enabled: boolean
  baseUrls: string[]
  search?: FirecrawlSearchOptions
  scrape?: FirecrawlScrapeOptions
}

/** Defaults for Jina's Search API; a missing one is the API's. */
export interface JinaSearchOptions {
  /** 1 to 20; unset asks for 10. */
  maxResults?: number
  includeContent?: boolean
  type?: 'news'
  country?: string
  language?: string
  location?: string
  includeDomains?: string[]
}

/** How Jina's Reader API reads pages for web_fetch. */
export interface JinaReadOptions {
  engine?: 'browser' | 'direct' | 'cf-browser-rendering'
  /** Seconds, 1 to 180. */
  timeout?: number
  targetSelector?: string
  removeSelector?: string
  retainImages?: 'none' | 'alt'
  withGeneratedAlt?: boolean
  withIframe?: boolean
  withShadowDom?: boolean
  respondWith?: 'readerlm-v2'
  proxy?: string
  locale?: string
  noCache?: boolean
  dnt?: boolean
  tokenBudget?: number
  waitForSelector?: string
  /** Seconds a cached copy may be old. */
  cacheTolerance?: number
}

export interface JinaProviderConfig {
  enabled: boolean
  apiKeys: string[]
  search?: JinaSearchOptions
  read?: JinaReadOptions
}

export type LangsearchFreshness =
  | 'noLimit'
  | 'oneDay'
  | 'oneWeek'
  | 'oneMonth'
  | 'oneYear'

/** Defaults for LangSearch's Search API; a missing one is the API's. */
export interface LangsearchSearchOptions {
  /** 1 to 50; unset asks for 10. */
  maxResults?: number
  freshness?: LangsearchFreshness
  includeDomains?: string[]
  excludeDomains?: string[]
  includeContent?: boolean
  /** Max characters of page content to extract when includeContent is on. */
  maxCharacters?: number
}

export interface LangsearchProviderConfig {
  enabled: boolean
  apiKeys: string[]
  search?: LangsearchSearchOptions
}

export type ExaSearchType = 'auto' | 'neural' | 'keyword' | 'fast' | 'deep'
export type ExaSearchCategory =
  | 'company'
  | 'research paper'
  | 'news'
  | 'pdf'
  | 'github'
  | 'tweet'
  | 'personal site'
  | 'linkedin profile'
  | 'financial report'
export type ExaLivecrawl = 'always' | 'fallback' | 'never' | 'auto'

/** Defaults for Exa's Search API; a missing one is the API's. */
export interface ExaSearchOptions {
  /** 1 to 100; unset asks for 10. */
  maxResults?: number
  type?: ExaSearchType
  category?: ExaSearchCategory
  includeDomains?: string[]
  excludeDomains?: string[]
  startPublishedDate?: string
  endPublishedDate?: string
  includeText?: string[]
  excludeText?: string[]
  moderation?: boolean
  includeContent?: boolean
  maxCharacters?: number
  includeHtmlTags?: boolean
  highlights?: boolean
  numSentences?: number
  highlightsPerUrl?: number
  highlightsQuery?: string
  summary?: boolean
  summaryQuery?: string
  livecrawl?: ExaLivecrawl
  livecrawlTimeout?: number
  subpages?: number
  subpageTarget?: string
}

/** How Exa's Contents API reads pages for web_fetch. */
export interface ExaReadOptions {
  maxCharacters?: number
  includeHtmlTags?: boolean
  highlights?: boolean
  numSentences?: number
  highlightsPerUrl?: number
  highlightsQuery?: string
  summary?: boolean
  summaryQuery?: string
  livecrawl?: ExaLivecrawl
  livecrawlTimeout?: number
  subpages?: number
  subpageTarget?: string
}

export interface ExaProviderConfig {
  enabled: boolean
  apiKeys: string[]
  search?: ExaSearchOptions
  read?: ExaReadOptions
}

export type TinyfishDomainType = 'web' | 'news' | 'research_paper'

/** Defaults for TinyFish Search API; a missing one is the API's (US/en, web, page 0). */
export interface TinyfishSearchOptions {
  /** 1 to 20; unset asks for 10 (applied client-side, API paginates via page). */
  maxResults?: number
  domainType?: TinyfishDomainType
  /** ISO country code, e.g. US, BR. Blank uses API default/auto-resolve. */
  location?: string
  /** Language code, e.g. en, fr. Blank uses API default/auto-resolve. */
  language?: string
  includeDomains?: string[]
  excludeDomains?: string[]
  /** 1 to 5256000 minutes; mutually exclusive with after/before dates. */
  recencyMinutes?: number
  /** YYYY-MM-DD; ignored for research_paper and when recencyMinutes is set. */
  afterDate?: string
  /** YYYY-MM-DD; ignored for research_paper and when recencyMinutes is set. */
  beforeDate?: string
  /** 0 to 9999; research_paper only. */
  pubYearMin?: number
  /** 0 to 9999; research_paper only. */
  pubYearMax?: number
}

export interface TinyfishProviderConfig {
  enabled: boolean
  apiKeys: string[]
  /** Optional proxy/mock override; blank uses https://api.search.tinyfish.ai. */
  baseUrl?: string
  search?: TinyfishSearchOptions
}

export type ParallelSearchMode = 'turbo' | 'fast' | 'basic' | 'advanced'

/** Defaults for Parallel's Search API; a missing one is the API's. */
export interface ParallelSearchOptions {
  /** 1 to 20; unset asks for 10. */
  maxResults?: number
  mode?: ParallelSearchMode
  /** ISO 3166-1 alpha-2 country code, e.g. 'us', 'gb', 'de', 'jp'. */
  location?: string
  includeDomains?: string[]
  excludeDomains?: string[]
  /** YYYY-MM-DD RFC 3339 date string. */
  afterDate?: string
  maxCharsTotal?: number
  maxCharsPerResult?: number
  maxAgeSeconds?: number
  timeoutSeconds?: number
  disableCacheFallback?: boolean
}

/** How Parallel's Extract API reads pages for web_fetch. */
export interface ParallelExtractOptions {
  fullContent?: boolean
  maxCharsPerResult?: number
  maxAgeSeconds?: number
  timeoutSeconds?: number
  disableCacheFallback?: boolean
}

export interface ParallelProviderConfig {
  enabled: boolean
  apiKeys: string[]
  /** Optional proxy/mock override; blank uses https://api.parallel.ai. */
  baseUrl?: string
  search?: ParallelSearchOptions
  read?: ParallelExtractOptions
}

export interface SearxngProviderConfig {
  enabled: boolean
  baseUrls: string[]
  defaultCategories?: string
  defaultLanguage?: string
  timeRange?: 'day' | 'week' | 'month' | 'year'
  /** 0 off, 1 moderate, 2 strict. */
  safeSearch?: 0 | 1 | 2
}

/**
 * How the server caches and sizes web research for this user. Every field is
 * optional: a missing one means the recommended value in WEB_SEARCH_DEFAULTS.
 */
export type WebSearchPreferences = {
  /** How long searches and pages are reused; 0 turns caching off. */
  cacheHours?: number
  maxCachedSearches?: number
  maxCachedPages?: number
}

export type WebSearchSourceMode = 'server' | 'custom' | 'disabled'

export interface MultiWebSearchSettings extends WebSearchPreferences {
  sourceMode?: WebSearchSourceMode
  providers: {
    ollama?: OllamaProviderConfig
    searxng?: SearxngProviderConfig
    websearchapi?: WebsearchapiProviderConfig
    tavily?: TavilyProviderConfig
    firecrawl?: FirecrawlProviderConfig
    firecrawlSelfHosted?: FirecrawlSelfHostedProviderConfig
    jina?: JinaProviderConfig
    langsearch?: LangsearchProviderConfig
    exa?: ExaProviderConfig
    tinyfish?: TinyfishProviderConfig
    parallel?: ParallelProviderConfig
    mcp?: McpProviderConfig
  }
  rotationStrategy?: WebSearchRotationStrategy
  primaryProvider?: WebSearchPrimaryProvider
}

export type LegacyWebSearchSettings = (
  | { type: 'ollama'; apiKey: string }
  | { type: 'searxng'; baseUrl: string }
  | { type: 'websearchapi'; apiKey: string }
  | { type: 'tavily'; apiKey: string }
  | { type: 'firecrawl'; apiKey: string }
  | { type: 'firecrawlSelfHosted'; baseUrl: string }
  | { type: 'jina'; apiKey: string }
  | { type: 'langsearch'; apiKey: string }
  | { type: 'exa'; apiKey: string }
  | { type: 'tinyfish'; apiKey: string }
  | { type: 'parallel'; apiKey: string }
  | {
      type: 'mcp'
      baseUrl: string
      headers?: McpHeader[]
      toolName?: string
      queryParam?: string
    }
) &
  WebSearchPreferences

/**
 * Where the agent's web_search and web_fetch go. Supports both multi-provider
 * pools with endpoint rotation and legacy single-provider configurations.
 */
export type WebSearchSettings = MultiWebSearchSettings | LegacyWebSearchSettings

/** The recommended values, and the range the server accepts for each. */
export const WEB_SEARCH_DEFAULTS = {
  cacheHours: { value: 24, min: 0, max: 168 },
  maxCachedSearches: { value: 256, min: 0, max: 1000 },
  maxCachedPages: { value: 64, min: 0, max: 200 },
} as const satisfies Record<
  keyof WebSearchPreferences,
  { value: number; min: number; max: number }
>

export type WebSearchProviderType =
  | 'ollama'
  | 'searxng'
  | 'websearchapi'
  | 'tavily'
  | 'firecrawl'
  | 'firecrawlSelfHosted'
  | 'jina'
  | 'langsearch'
  | 'exa'
  | 'tinyfish'
  | 'parallel'
  | 'mcp'

export type Limits = {
  contextWindow: number
  maxOutputTokens: number
}

export const DEFAULT_LIMITS: Record<ProviderType, Limits> = {
  openai: { contextWindow: 200000, maxOutputTokens: 32000 },
  anthropic: { contextWindow: 200000, maxOutputTokens: 32000 },
  google: { contextWindow: 1000000, maxOutputTokens: 65536 },
  ollama: { contextWindow: 256000, maxOutputTokens: 65536 },
}

function positive(value: number | undefined, fallback: number) {
  return typeof value === 'number' && value > 0 ? value : fallback
}

export function resolveLimits(settings: ProviderSettings): Limits {
  // `settings.type` is typed as `ProviderType`, but a value loaded from
  // storage is not checked at runtime — a corrupted or stale entry can hold
  // a type outside the three-member union, and indexing `DEFAULT_LIMITS`
  // with it would otherwise return `undefined` and throw on the next line.
  const defaults = DEFAULT_LIMITS[settings.type] ?? DEFAULT_LIMITS.openai
  return {
    contextWindow: positive(settings.contextWindow, defaults.contextWindow),
    maxOutputTokens: positive(
      settings.maxOutputTokens,
      defaults.maxOutputTokens
    ),
  }
}

export type ToolSpec = {
  name: string
  description: string
  parameters: object // JSON Schema
}

export type ToolCall = {
  id: string
  name: string
  args: unknown
}

/** An image on a user message (base64, no `data:` prefix). Only the equation generator sends one. */
export type ChatImage = {
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  data: string
}

export type AgentMessage =
  | { role: 'user'; content: string; images?: ChatImage[] }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | {
      role: 'tool'
      toolCallId: string
      name: string
      content: string
      isError?: boolean
    }

export type ChatChunk =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'done'; stopReason?: 'stop' | 'tool_calls' | 'length' }
  /**
   * The reply hit the output token limit. Sent last, and only then. The last
   * tool call of the reply, if any, has incomplete arguments.
   */
  | { type: 'stop'; reason: 'max_tokens' }

export type CacheHints = {
  cacheSystem: boolean
  cacheTools: boolean
  /** Index into `messages` of the last message stable across turns. */
  lastStableMessage: number | null
  /** Stable per-project key for providers with keyed caches. */
  cacheKey?: string
}

export type ChatRequest = {
  system: string
  messages: AgentMessage[]
  maxTokens: number
  /**
   * The context window the caller budgets for. Ollama needs it as num_ctx,
   * otherwise it runs with a small default and silently truncates the prompt.
   */
  contextWindow?: number
  tools?: ToolSpec[]
  cacheHints?: CacheHints
  signal?: AbortSignal
}

export type ProviderModel = {
  id: string
  label: string
  /** Per-model limits, when the endpoint's model listing reports them. */
  contextWindow?: number
  maxOutputTokens?: number
}

/**
 * Some gateways (and a few first-party APIs) report each model's own limits
 * on the models-list endpoint — `max_input_tokens`/`max_tokens` is the shape
 * seen across Anthropic-compatible and OpenAI-compatible gateways alike.
 * When present, these are a better default than the hardcoded fallback in
 * `DEFAULT_LIMITS`, which only exists for endpoints that report nothing.
 */
export function parseModelLimits(entry: any): {
  contextWindow?: number
  maxOutputTokens?: number
} {
  const contextWindow =
    entry?.max_input_tokens ??
    entry?.context_window ??
    entry?.details?.context_length
  let maxOutputTokens =
    entry?.max_tokens ??
    entry?.max_output_tokens ??
    entry?.details?.max_output_tokens

  // For models reporting a large context length (>= 128k, such as Gemma 4
  // 256k on Ollama) but omitting max_tokens, set maxOutputTokens to the
  // 64k (65,536) maximum ceiling.
  if (
    typeof contextWindow === 'number' &&
    contextWindow >= 128000 &&
    !maxOutputTokens
  ) {
    maxOutputTokens = 65536
  }

  return {
    ...(typeof contextWindow === 'number' && contextWindow > 0
      ? { contextWindow }
      : {}),
    ...(typeof maxOutputTokens === 'number' && maxOutputTokens > 0
      ? { maxOutputTokens }
      : {}),
  }
}

export type ProviderErrorCode =
  | 'providerAuth'
  | 'providerError'
  | 'modelsUnsupported'
  | 'network'
  | 'aborted'
  | 'contextExhausted'
  | 'runawayToolLoop'
  | 'consecutiveToolFailures'
  | 'outputTruncated'
  | 'imageUnsupported'
  | 'modelNotFound'

/**
 * A failure talking to the provider.
 *
 * The server relays the provider's own message: the request used this user's
 * own key, so there is nobody else to leak it to, and "invalid_api_key:
 * incorrect key provided" is far more useful than a generic sentence.
 */
export class ProviderError extends Error {
  code: ProviderErrorCode
  status?: number
  upstreamMessage?: string
  upstreamCode?: string
  upstreamType?: string
  upstreamParam?: string
  hint?: string

  constructor(
    code: ProviderErrorCode,
    message: string,
    status?: number,
    options?: {
      upstreamMessage?: string
      upstreamCode?: string
      upstreamType?: string
      upstreamParam?: string
      hint?: string
    }
  ) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
    this.status = status
    this.upstreamMessage = options?.upstreamMessage
    this.upstreamCode = options?.upstreamCode
    this.upstreamType = options?.upstreamType
    this.upstreamParam = options?.upstreamParam
    this.hint = options?.hint
  }
}

export interface ProviderClient {
  streamChat(request: ChatRequest): AsyncGenerator<ChatChunk>
  listModels(options?: { signal?: AbortSignal }): Promise<ProviderModel[]>
}

export const DEFAULT_BASE_URLS: Record<ProviderType, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  ollama: 'http://localhost:11434',
}

export const REQUIRES_API_KEY: Record<ProviderType, boolean> = {
  openai: true,
  anthropic: true,
  google: true,
  ollama: false,
}

/** Turns a fetch rejection or bad status into an informative typed error. */
export async function toProviderError(response: Response) {
  const body = await response.text().catch(() => '')
  let upstreamMessage = body.slice(0, 1000).trim()
  let upstreamCode: string | undefined
  let upstreamType: string | undefined
  let upstreamParam: string | undefined

  try {
    const parsed = JSON.parse(body)
    if (typeof parsed?.error === 'string') {
      upstreamMessage = parsed.error
    } else if (parsed?.error && typeof parsed.error === 'object') {
      if (typeof parsed.error.message === 'string') {
        upstreamMessage = parsed.error.message
      }
      if (typeof parsed.error.code === 'string') {
        upstreamCode = parsed.error.code
      }
      if (typeof parsed.error.type === 'string') {
        upstreamType = parsed.error.type
      }
      if (typeof parsed.error.param === 'string') {
        upstreamParam = parsed.error.param
      }
    } else if (typeof parsed?.message === 'string') {
      upstreamMessage = parsed.message
      if (typeof parsed?.code === 'string') {
        upstreamCode = parsed.code
      }
    }
  } catch {
    // keep raw slice
  }

  let code: ProviderErrorCode = 'providerError'
  let message = upstreamMessage
  let hint = ''

  if (response.status === 401 || response.status === 403) {
    code = 'providerAuth'
    hint =
      'The API key was rejected. Verify your API key and permissions in Account Settings.'
    message =
      upstreamMessage ||
      `The provider rejected this API key (HTTP ${response.status}).`
  } else if (response.status === 404) {
    code = 'modelsUnsupported'
    hint =
      'The requested endpoint or model was not found. Verify the model name and endpoint base URL in Account Settings.'
    message =
      upstreamMessage || `This endpoint or model was not found (HTTP 404).`
  } else if (response.status === 429) {
    code = 'providerError'
    hint =
      'Rate limit or billing quota exceeded. Check your plan, usage limits, and credit balance on your provider dashboard.'
    message = upstreamMessage || `Rate limit or quota exceeded (HTTP 429).`
  } else if (response.status === 400) {
    code = 'providerError'
    hint = 'The upstream API rejected the request parameters or payload format.'
    message =
      upstreamMessage || `The provider rejected the request format (HTTP 400).`
  } else if (response.status >= 500) {
    code = 'providerError'
    hint = `Upstream service failure (HTTP ${response.status}). The AI provider's servers encountered an internal error. Check their status page or retry.`
    message =
      upstreamMessage ||
      `The AI provider encountered an internal server error (HTTP ${response.status}).`
  } else {
    code = 'providerError'
    hint = `Unexpected response from provider (HTTP ${response.status}).`
    message =
      upstreamMessage || `The provider returned HTTP ${response.status}.`
  }

  return new ProviderError(code, message, response.status, {
    upstreamMessage,
    upstreamCode,
    upstreamType,
    upstreamParam,
    hint,
  })
}

/** How each provider type is named in the UI. */
export const PROVIDER_TYPE_LABELS: Record<ProviderType, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google Gemini',
  ollama: 'Ollama',
}

