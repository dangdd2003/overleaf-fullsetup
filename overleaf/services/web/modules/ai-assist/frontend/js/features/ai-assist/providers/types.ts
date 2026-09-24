export type ProviderType =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'ollama'

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
}

/**
 * Where the agent's web_search and web_fetch go. Ollama's hosted API answers
 * both; with SearXNG the Overleaf server searches through the instance and
 * reads pages itself.
 */
export type WebSearchSettings = (
  | { type: 'ollama'; apiKey: string }
  | { type: 'searxng'; baseUrl: string }
) &
  WebSearchPreferences

/**
 * How the server caches and sizes web research for this user. Every field is
 * optional: a missing one means the recommended value in WEB_SEARCH_DEFAULTS.
 */
export type WebSearchPreferences = {
  /** How long searches and pages are reused; 0 turns caching off. */
  cacheHours?: number
  maxCachedSearches?: number
  maxCachedPages?: number
  /** The most results the model may ask for in one search. */
  resultsPerSearch?: number
}

/** The recommended values, and the range the server accepts for each. */
export const WEB_SEARCH_DEFAULTS = {
  cacheHours: { value: 24, min: 0, max: 168 },
  maxCachedSearches: { value: 256, min: 0, max: 1000 },
  maxCachedPages: { value: 64, min: 0, max: 200 },
  resultsPerSearch: { value: 10, min: 1, max: 10 },
} as const satisfies Record<
  keyof WebSearchPreferences,
  { value: number; min: number; max: number }
>

export type WebSearchProviderType = WebSearchSettings['type']

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
    maxOutputTokens: positive(settings.maxOutputTokens, defaults.maxOutputTokens),
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

export type AgentMessage =
  | { role: 'user'; content: string }
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
    hint = 'The API key was rejected. Verify your API key and permissions in Account Settings.'
    message = upstreamMessage || `The provider rejected this API key (HTTP ${response.status}).`
  } else if (response.status === 404) {
    code = 'modelsUnsupported'
    hint = 'The requested endpoint or model was not found. Verify the model name and endpoint base URL in Account Settings.'
    message = upstreamMessage || `This endpoint or model was not found (HTTP 404).`
  } else if (response.status === 429) {
    code = 'providerError'
    hint = 'Rate limit or billing quota exceeded. Check your plan, usage limits, and credit balance on your provider dashboard.'
    message = upstreamMessage || `Rate limit or quota exceeded (HTTP 429).`
  } else if (response.status === 400) {
    code = 'providerError'
    hint = 'The upstream API rejected the request parameters or payload format.'
    message = upstreamMessage || `The provider rejected the request format (HTTP 400).`
  } else if (response.status >= 500) {
    code = 'providerError'
    hint = `Upstream service failure (HTTP ${response.status}). The AI provider's servers encountered an internal error. Check their status page or retry.`
    message = upstreamMessage || `The AI provider encountered an internal server error (HTTP ${response.status}).`
  } else {
    code = 'providerError'
    hint = `Unexpected response from provider (HTTP ${response.status}).`
    message = upstreamMessage || `The provider returned HTTP ${response.status}.`
  }

  return new ProviderError(code, message, response.status, {
    upstreamMessage,
    upstreamCode,
    upstreamType,
    upstreamParam,
    hint,
  })
}
