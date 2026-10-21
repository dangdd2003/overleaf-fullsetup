import crypto from 'node:crypto'
import Settings from '@overleaf/settings'
import './ModuleSettings.mjs'
import { sanitizeToolSchema } from './AiAssistToolSchema.mjs'
import { dockerHostGateway, isRunningInDocker } from './DockerHost.mjs'
import {
  abortableSleep,
  planRetry,
  resolveRetryPolicy,
  retryHeaders,
} from './AiAssistRetry.mjs'
import { cancelledError, ProviderError } from './AiAssistErrors.mjs'
// The connectors' guard against this server, its metadata and its internal
// services, shared with the MCP connectors rather than copied
import {
  providerFetch,
  validateConnectorUrl,
} from './connectors/ConnectorFetch.mjs'

/** The retry fields of a failed provider reply, read before its body is. */
function httpRetryFields(res) {
  return retryHeaders(res?.headers)
}

/**
 * The HTTP-style status of a provider's error event sent inside a 200 stream,
 * so the retry layer can tell a busy provider from a broken request.
 */
function streamErrorStatus(type) {
  if (type === 'overloaded_error') return 529
  if (type === 'rate_limit_error') return 429
  if (type === 'api_error') return 500
  return undefined
}

/** The most a provider's reply (or error reply) may be read to: far above any real one. */
const MAX_JSON_REPLY_BYTES = 4 * 1024 * 1024

/**
 * res.json() with a cap: a URL the user chose must not fill the server's memory
 * with one reply.
 */
export async function readJsonReply(res, maxBytes = MAX_JSON_REPLY_BYTES) {
  if (typeof res.body?.getReader !== 'function') return res.json()
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new ProviderError('The provider sent more data than expected.', {
        code: 'providerError',
      })
    }
    chunks.push(value)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** The ProviderError for a failed OpenAI-compatible response. */
async function openAiError(res) {
  let msg = `OpenAI API error (${res.status})`
  let code =
    res.status === 401 || res.status === 403 ? 'providerAuth' : 'providerError'
  try {
    const body = await readJsonReply(res)
    if (body?.error?.message) msg = body.error.message
    if (body?.error?.code === 'invalid_api_key') code = 'providerAuth'
  } catch {}
  return new ProviderError(msg, {
    status: res.status,
    code,
    ...httpRetryFields(res),
  })
}

const BLOCKED_INTERNAL_HOSTS = new Set([
  'mongo',
  'mongodb',
  'redis',
  'clsi',
  'docstore',
  'document-updater',
  'filestore',
  'chat',
  'real-time',
  'spelling',
  'contacts',
  'notifications',
  'git-bridge',
  'project-history',
  'metadata.google.internal',
])

const DEFAULT_BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  ollama: 'http://localhost:11434',
}

export function normalizeProviderBaseUrl(
  type,
  rawUrl,
  fallbackUrl = DEFAULT_BASE_URLS[type] || DEFAULT_BASE_URLS.openai
) {
  let url = typeof rawUrl === 'string' ? rawUrl.trim() : ''
  if (!url) {
    return fallbackUrl || ''
  }

  // Trim trailing slashes
  url = url.replace(/\/+$/, '')

  if (type === 'anthropic') {
    // Anthropic official & compatible endpoints append /v1/messages and /v1/models.
    // The base URL must NOT end in /v1, /messages, or /models.
    url = url
      .replace(/\/v1\/messages$/, '')
      .replace(/\/messages$/, '')
      .replace(/\/v1\/models$/, '')
      .replace(/\/models$/, '')
      .replace(/\/v1$/, '')
      .replace(/\/+$/, '')
    return url || fallbackUrl || DEFAULT_BASE_URLS.anthropic
  }

  if (type === 'google') {
    // Google Gemini REST endpoints are ${baseURL}/models and ${baseURL}/models/{model}:streamGenerateContent
    // Strip /openai or /models suffix if accidentally provided
    url = url
      .replace(/\/openai\/?$/, '')
      .replace(/\/models\/?$/, '')
      .replace(/\/+$/, '')
    if (!url.endsWith('/v1beta') && !url.endsWith('/v1')) {
      url = `${url}/v1beta`
    }
    return url
  }

  if (type === 'ollama') {
    // Ollama REST endpoints are /api/tags and /api/chat.
    // Strip /v1 or /api or /api/tags or /api/chat if provided
    url = url
      .replace(/\/v1(\/(chat\/completions|models))?$/, '')
      .replace(/\/api(\/(tags|chat))?$/, '')
      .replace(/\/+$/, '')
    return url || fallbackUrl || DEFAULT_BASE_URLS.ollama
  }

  // Default is openai - hard fix the ending /v1
  url = url
    .replace(/\/(chat\/completions|models)$/, '')
    .replace(/\/+$/, '')
  if (!url.endsWith('/v1')) {
    url = `${url}/v1`
  }
  return url
}

export function validateSafeProviderBaseUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return true
  }

  // Checked as it will be dialled: in a container localhost is the host's
  // Ollama, reached at the gateway (see resolveDockerHostUrl)
  const target = resolveDockerHostUrl(rawUrl.trim())
  let parsed
  try {
    parsed = new URL(target)
  } catch {
    throw new ProviderError('Invalid provider URL format', {
      code: 'invalidProviderUrl',
      status: 400,
    })
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ProviderError(
      `Forbidden protocol '${parsed.protocol}'. Only http and https are permitted.`,
      {
        code: 'invalidProviderUrl',
        status: 400,
      }
    )
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (BLOCKED_INTERNAL_HOSTS.has(hostname) || hostname.endsWith('.internal')) {
    throw new ProviderError(
      `Access to internal service '${hostname}' is forbidden.`,
      {
        code: 'restrictedProviderUrl',
        status: 400,
      }
    )
  }

  // Loopback and this server's own addresses, by name or IP literal, the
  // metadata services, and Overleaf's internal services. A LAN address stays
  // allowed: that is where a self-hosted provider lives.
  try {
    validateConnectorUrl(target)
  } catch (err) {
    throw new ProviderError(err.message, {
      code: 'restrictedProviderUrl',
      status: 400,
    })
  }

  return true
}

/**
 * The ProviderError for a provider address the connector lookup refused (one
 * that resolves to this server, its metadata or its internal services), or null.
 * The lookup is the one the connection is made with, so the answer refused is
 * the answer that would have been dialled.
 */
function refusedDestination(err) {
  if (err?.code !== 'EADDRBLOCKED') return null
  return new ProviderError(err.message, {
    code: 'restrictedProviderUrl',
    status: 400,
  })
}

/**
 * Retries a fetch that fails with a transient status (429, 5xx) or a dropped
 * connection, with the backoff of the retry layer. A reply that is still a
 * failure once the retries are spent is returned as it is, for the caller to
 * map. Stream calls pass maxRetries 0: their retries run one level up, around
 * the whole attempt.
 */
export async function fetchWithRetry(
  url,
  options,
  {
    maxRetries = 3,
    initialDelayMs = 500,
    maxDelayMs = 8000,
    fetchFn = providerFetch,
    policy: explicitPolicy,
    random = Math.random,
  } = {}
) {
  const policy = explicitPolicy ?? {
    maxRetries,
    baseMs: initialDelayMs,
    capMs: maxDelayMs,
    maxRetryAfterMs: 30000,
  }
  let attempt = 0
  while (true) {
    if (options?.signal?.aborted) throw cancelledError()

    let res
    try {
      const { providerRequest, ...fetchOptions } = options ?? {}
      res = await fetchFn(url, {
        ...fetchOptions,
        // Provider endpoints should not redirect an approved public URL to an
        // internal service. Other fetchWithRetry callers keep fetch defaults.
        ...(providerRequest && options?.redirect == null
          ? { redirect: 'error' }
          : {}),
      })
    } catch (err) {
      if (options?.signal?.aborted || err?.code === 'aborted') {
        throw cancelledError()
      }
      if (err.name === 'AbortError') {
        throw err
      }
      const refused = refusedDestination(err)
      if (refused) throw refused

      const plan = planRetry(err, { attempt, policy, random })
      if (!plan.retry) throw plan.error
      attempt = plan.attempt
      await abortableSleep(plan.retryInMs, options?.signal)
      continue
    }

    // A success goes back as it is, whatever retry headers it carries
    if (res.ok) return res
    const plan = planRetry(
      {
        status: res.status,
        message: `HTTP ${res.status}`,
        ...httpRetryFields(res),
      },
      { attempt, policy, random }
    )
    if (!plan.retry) return res

    if (typeof res.text === 'function') {
      await res.text().catch(() => {})
    }
    attempt = plan.attempt
    await abortableSleep(plan.retryInMs, options?.signal)
  }
}

/** The connect and idle limits from the admin settings, read at each use. */
function defaultConnectMs() {
  return (Settings.aiAssist?.requestTimeoutSeconds ?? 180) * 1000
}

function defaultIdleMs() {
  return (Settings.aiAssist?.streamIdleSeconds ?? 0) * 1000
}

function withRequestTimeouts(callerSignal, { connectMs, idleMs } = {}) {
  const resolvedConnectMs =
    connectMs ?? defaultConnectMs()
  const resolvedIdleMs =
    idleMs ?? defaultIdleMs()

  const connectController = new AbortController()
  const idleController = new AbortController()
  let connectTimer = null
  let idleTimer = null

  if (resolvedConnectMs && resolvedConnectMs > 0) {
    connectTimer = setTimeout(
      () => connectController.abort(),
      resolvedConnectMs
    )
    connectTimer.unref?.()
  }

  const combinedSignal = AbortSignal.any(
    [callerSignal, connectController.signal, idleController.signal].filter(
      Boolean
    )
  )

  const clearConnectTimeout = () => {
    if (connectTimer) {
      clearTimeout(connectTimer)
      connectTimer = null
    }
  }

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer)
    if (resolvedIdleMs && resolvedIdleMs > 0) {
      idleTimer = setTimeout(() => idleController.abort(), resolvedIdleMs)
      idleTimer.unref?.()
    }
  }

  const clearAllTimeouts = () => {
    clearConnectTimeout()
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  const checkAbortReason = () => {
    if (callerSignal?.aborted) {
      throw new ProviderError('Request was cancelled', {
        code: 'aborted',
        status: undefined,
      })
    }
    if (connectController.signal.aborted) {
      throw new ProviderError('Connection timed out', {
        code: 'providerTimeout',
        status: undefined,
      })
    }
    if (idleController.signal.aborted) {
      throw new ProviderError(
        `Stream stalled: no data received for ${Math.round(resolvedIdleMs / 1000)}s`,
        { code: 'providerStalled', status: undefined }
      )
    }
  }

  return {
    signal: combinedSignal,
    clearConnectTimeout,
    resetIdleTimer,
    clearAllTimeouts,
    checkAbortReason,
  }
}

export function resolveDockerHostUrl(url) {
  if (!url) return url
  if (isRunningInDocker()) {
    const hostGateway = dockerHostGateway()
    return url.replace(
      /https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/,
      (_match, _host, port) => {
        const portPart = port || ''
        return `http://${hostGateway}${portPart}`
      }
    )
  }
  return url
}

class StreamingThinkParser {
  constructor() {
    this.inThink = false
    this.pending = ''
  }

  *feed(text) {
    if (!text) return
    let input = this.pending + text
    this.pending = ''

    while (input.length > 0) {
      if (!this.inThink) {
        const startIdx = input.indexOf('<think>')
        if (startIdx !== -1) {
          const before = input.slice(0, startIdx)
          if (before) yield { type: 'text', text: before }
          this.inThink = true
          input = input.slice(startIdx + 7)
        } else {
          const match = input.match(/<t(?:h(?:i(?:n(?:k)?)?)?)?$/)
          if (match) {
            const before = input.slice(0, match.index)
            if (before) yield { type: 'text', text: before }
            this.pending = match[0]
            input = ''
          } else {
            yield { type: 'text', text: input }
            input = ''
          }
        }
      } else {
        const endIdx = input.indexOf('</think>')
        if (endIdx !== -1) {
          const thinking = input.slice(0, endIdx)
          if (thinking) yield { type: 'thinking', text: thinking }
          this.inThink = false
          input = input.slice(endIdx + 8)
        } else {
          const match = input.match(/<\/t(?:h(?:i(?:n(?:k)?)?)?)?$/)
          if (match) {
            const thinking = input.slice(0, match.index)
            if (thinking) yield { type: 'thinking', text: thinking }
            this.pending = match[0]
            input = ''
          } else {
            yield { type: 'thinking', text: input }
            input = ''
          }
        }
      }
    }
  }

  *flush() {
    if (this.pending) {
      yield { type: this.inThink ? 'thinking' : 'text', text: this.pending }
      this.pending = ''
    }
  }
}

/** The longest line a provider stream may send; a longer one is refused. */
const MAX_STREAM_LINE_CHARS = 16 * 1024 * 1024

/**
 * The lines of a provider's byte stream, as they arrive. A chunk is searched
 * only for its own line breaks, so a long line costs its length once rather
 * than once per chunk that extends it.
 */
async function* streamLines(stream, onActivity) {
  const reader = stream[Symbol.asyncIterator]()
  const decoder = new TextDecoder()
  let buffer = ''
  const unfinished = () => {
    if (buffer.length > MAX_STREAM_LINE_CHARS) {
      throw new ProviderError('The provider sent a line that is too long.', {
        code: 'providerError',
      })
    }
  }
  const withoutCr = line => (line.endsWith('\r') ? line.slice(0, -1) : line)

  while (true) {
    const { value, done } = await reader.next()
    if (done) break
    if (onActivity) onActivity()
    const chunk = decoder.decode(value, { stream: true })
    if (!chunk.includes('\n')) {
      buffer += chunk
      unfinished()
      continue
    }
    const lines = (buffer + chunk).split('\n')
    buffer = lines.pop() ?? ''
    unfinished()
    for (const line of lines) yield withoutCr(line)
  }

  if (buffer) yield withoutCr(buffer)
}

async function* parseNdjsonLines(stream, onActivity) {
  for await (const line of streamLines(stream, onActivity)) {
    const trimmed = line.trim()
    if (trimmed) yield trimmed
  }
}

/** The images a tool message carries (view_compiled_pdf_page), if any. */
function toolImages(message) {
  return Array.isArray(message?.images)
    ? message.images.filter(
        image =>
          typeof image?.data === 'string' &&
          image.data &&
          typeof image.mediaType === 'string'
      )
    : []
}

/**
 * Chat-completions APIs (OpenAI and compatible servers, Ollama) only take
 * text in a tool message, so a tool's images follow its results as a user
 * turn. It goes after the last tool message of the step: a tool result has
 * to follow the assistant turn that asked for it directly.
 */
export function toolImageTurns(messages) {
  const turns = new Map()
  let pending = []
  messages.forEach((message, index) => {
    if (message.role === 'tool') {
      for (const image of toolImages(message)) {
        pending.push({ image, name: message.name || 'tool' })
      }
    }
    const endsToolRun = messages[index + 1]?.role !== 'tool'
    if (message.role === 'tool' && endsToolRun && pending.length > 0) {
      turns.set(index, pending)
      pending = []
    }
  })
  return turns
}

function imageTurnLabel(entries) {
  const names = [...new Set(entries.map(entry => entry.name))].join(', ')
  return `[The image${entries.length > 1 ? 's' : ''} returned by ${names} above.]`
}

export function toOllamaMessages(system, messages) {
  const wire = []
  if (system) {
    wire.push({ role: 'system', content: system })
  }
  const imageTurns = toolImageTurns(messages)
  for (const [index, message] of messages.entries()) {
    if (message.role === 'tool') {
      const safeContent =
        typeof message.content === 'string' && message.content.trim().length > 0
          ? message.content
          : '(empty result)'
      wire.push({
        role: 'tool',
        content: safeContent,
        ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
        ...(message.name ? { name: message.name } : {}),
      })
      const shown = imageTurns.get(index)
      if (shown) {
        wire.push({
          role: 'user',
          content: imageTurnLabel(shown),
          images: shown.map(entry => entry.image.data),
        })
      }
    } else if (message.role === 'assistant' && message.toolCalls?.length) {
      wire.push({
        role: 'assistant',
        content: message.content || '',
        tool_calls: message.toolCalls.map(call => {
          let args = call.args ?? {}
          if (typeof args === 'string') {
            try {
              args = JSON.parse(args)
            } catch {
              args = {}
            }
          }
          return {
            id: call.id,
            type: 'function',
            function: {
              name: call.name,
              arguments: args,
            },
          }
        }),
      })
    } else {
      const images =
        message.role === 'user' &&
        Array.isArray(message.images) &&
        message.images.length > 0
          ? { images: message.images.map(image => image.data) }
          : {}
      wire.push({ role: message.role, content: message.content || '', ...images })
    }
  }
  return wire
}

export function safeParseToolArgs(rawArgs) {
  if (!rawArgs || typeof rawArgs !== 'string' || !rawArgs.trim()) {
    return {}
  }
  try {
    return JSON.parse(rawArgs)
  } catch {
    const trimmed = rawArgs.trim()
    const candidates = [
      trimmed + '"}',
      trimmed + '}',
      trimmed + '"}}',
      trimmed + '}}',
      trimmed + '"]}',
    ]
    for (const candidate of candidates) {
      try {
        // Marked so the agent loop can refuse to act on a call whose
        // arguments were cut off: a repaired newText parses, but it is short.
        return { ...JSON.parse(candidate), _repaired: true }
      } catch {}
    }
    return { _parseError: true, _raw: rawArgs }
  }
}

export async function* parseSseLines(stream, onActivity) {
  for await (const line of streamLines(stream, onActivity)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith(':')) continue
    if (trimmed.startsWith('data:')) {
      const rawData = line.slice(line.indexOf('data:') + 5)
      yield rawData.startsWith(' ') ? rawData.slice(1) : rawData
    }
  }
}

/**
 * The one usage chunk a request yields, whatever the provider called its
 * counts. A count the provider did not report is 0; a request it reported
 * nothing for yields no chunk, so the meter keeps its estimate instead of
 * reading an exact zero.
 */
function* usageChunks({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheCreationTokens,
  partialInput = false,
}) {
  const count = value => {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  }
  const usage = {
    inputTokens: count(inputTokens),
    outputTokens: count(outputTokens),
    cacheReadTokens: count(cacheReadTokens),
    cacheCreationTokens: count(cacheCreationTokens),
  }
  if (Object.values(usage).some(n => n > 0)) {
    yield {
      type: 'usage',
      usage: partialInput ? { ...usage, partialInput: true } : usage,
    }
  }
}

/**
 * Mirrors the browser-side limit parsing: gateways that report per-model limits
 * on their models listing use these field names.
 */
function parseModelLimits(entry) {
  const contextWindow =
    entry?.max_input_tokens ??
    entry?.context_window ??
    entry?.details?.context_length
  let maxOutputTokens =
    entry?.max_tokens ??
    entry?.max_output_tokens ??
    entry?.details?.max_output_tokens
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

async function fetchModelList(fetchFn, url, headers, signal) {
  const timeoutMs = defaultConnectMs()
  const combined = AbortSignal.any(
    [signal, AbortSignal.timeout(timeoutMs)].filter(Boolean)
  )
  let res
  try {
    res = await fetchFn(url, {
      method: 'GET',
      headers,
      signal: combined,
      // A listing URL the user chose must not redirect to a server they could not name
      redirect: 'error',
    })
  } catch (err) {
    if (signal?.aborted) {
      throw new ProviderError('Request was cancelled', { code: 'aborted' })
    }
    const refused = refusedDestination(err)
    if (refused) throw refused
    const origin = new URL(url).origin
    throw new ProviderError(
      `Could not reach ${origin}: ${err.cause?.message || err.message}`,
      {
        code: 'network',
        status: 502,
      }
    )
  }
  if (!res.ok) {
    let msg = `Provider returned ${res.status} when listing models`
    try {
      const body = await readJsonReply(res)
      const upstream =
        body?.error?.message ||
        (typeof body?.error === 'string' ? body.error : null)
      if (upstream) msg = upstream
    } catch {}
    const code =
      res.status === 401 || res.status === 403
        ? 'providerAuth'
        : res.status === 404 || res.status === 405
          ? 'modelsUnsupported'
          : 'providerError'
    throw new ProviderError(msg, { code, status: res.status })
  }
  return await readJsonReply(res).catch(() => null)
}

export function cacheControlValue() {
  return Settings.aiAssist?.promptCacheTtl === '1h'
    ? { type: 'ephemeral', ttl: '1h' }
    : { type: 'ephemeral' }
}

/**
 * Marks up to two message cache breakpoints on Anthropic wire messages.
 *
 * Positions come from `wire`, not from the agent message list: consecutive
 * tool results are merged into one user message on the wire, so an index
 * counted on the agent messages points at the wrong message (or past the end)
 * whenever a turn made more than one tool call.
 *
 * - The newest message: the whole request is written to the cache, and the
 *   next step, which only appends to it, reads it back.
 * - The message before the newest assistant turn: where the previous request
 *   put its breakpoint. Anthropic looks back at most 20 content blocks for an
 *   earlier cache entry, and one turn with many tool calls adds more blocks
 *   than that.
 *
 * Together with the system and tools breakpoints this stays within the API's
 * limit of four.
 */
export function markMessageCacheBreakpoints(wire) {
  const ephemeral = cacheControlValue()
  const mark = index => {
    const entry = wire[index]
    if (!entry) return
    if (typeof entry.content === 'string') {
      entry.content = [
        { type: 'text', text: entry.content, cache_control: ephemeral },
      ]
    } else if (Array.isArray(entry.content) && entry.content.length > 0) {
      const last = entry.content.length - 1
      entry.content[last] = { ...entry.content[last], cache_control: ephemeral }
    }
  }

  const newest = wire.length - 1
  if (newest < 0) return
  mark(newest)

  let lastAssistant = -1
  for (let index = newest; index >= 0; index--) {
    if (wire[index].role === 'assistant') {
      lastAssistant = index
      break
    }
  }
  const previous = lastAssistant - 1
  if (previous >= 0 && previous !== newest) mark(previous)
}

/**
 * The reasoning effort levels each provider documents, as the composer offers
 * them. Anything else is dropped rather than sent upstream; no level at all
 * leaves the provider's default. Thinking on or off is a separate switch,
 * except on OpenAI, which has effort levels only ("none" among them).
 */
export const REASONING_EFFORTS = {
  openai: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  anthropic: ['low', 'medium', 'high', 'xhigh', 'max'],
  google: ['minimal', 'low', 'medium', 'high'],
  ollama: ['low', 'medium', 'high'],
}

function reasoningEffortFor(type, effort) {
  return REASONING_EFFORTS[type].includes(effort) ? effort : null
}

/** true or false from the composer's switch; anything else is left unset. */
function thinkingFor(thinking) {
  return typeof thinking === 'boolean' ? thinking : null
}

// Gemini 2.5 takes a token budget rather than a level; the Pro model cannot
// turn thinking off, so its lowest budget stands in for off and "minimal".
const GEMINI_THINKING_BUDGETS = {
  minimal: 0,
  low: 1024,
  medium: 8192,
  high: 24576,
}

function geminiThinkingBudget(effort, model) {
  const budget = GEMINI_THINKING_BUDGETS[effort]
  return budget === 0 && model.includes('pro') ? 128 : budget
}

/**
 * The Anthropic `system` field. With a `systemPrefix` hint the prefix is its
 * own cached block, so it is shared by every chat that has it, and what
 * follows (the project's AGENTS.md) is a second, uncached block covered by
 * the message breakpoints. Other providers get the joined string.
 */
export function anthropicSystemField(system, cacheHints) {
  if (!cacheHints?.cacheSystem) return system
  const ephemeral = cacheControlValue()
  const prefix = cacheHints.systemPrefix
  if (
    typeof prefix === 'string' &&
    prefix &&
    system.length > prefix.length &&
    system.startsWith(prefix)
  ) {
    const rest = system.slice(prefix.length).replace(/^\n+/, '')
    if (rest) {
      return [
        { type: 'text', text: prefix, cache_control: ephemeral },
        { type: 'text', text: rest },
      ]
    }
  }
  return [{ type: 'text', text: system, cache_control: ephemeral }]
}

/**
 * One tool spec in the provider's wire shape. The clients send these, and the
 * context meter prices the same objects (AiAssistContextUsage), so the two
 * cannot drift apart.
 */
export function toolWireSpec(type, tool) {
  if (type === 'anthropic') {
    return {
      name: tool.name,
      description: tool.description,
      input_schema: sanitizeToolSchema(tool.parameters),
    }
  }
  if (type === 'google') {
    // Gemini rejects an object schema with no properties, so a no-argument
    // tool must omit `parameters` rather than send `{}`.
    const parameters = sanitizeToolSchema(tool.parameters, {
      emptyObject: 'omit',
    })
    return {
      name: tool.name,
      description: tool.description,
      ...(parameters ? { parameters } : {}),
    }
  }
  // OpenAI, OpenAI-compatible servers and Ollama
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: sanitizeToolSchema(tool.parameters),
    },
  }
}

/**
 * The error of a count request that failed. The provider's own message is kept
 * when its reply has one, since a 400 says whether the route is unsupported.
 */
async function countReplyError(label, res) {
  let detail = ''
  if (typeof res.text === 'function') {
    const text = await res.text().catch(() => '')
    try {
      detail = JSON.parse(text)?.error?.message ?? ''
    } catch {
      detail = ''
    }
    if (!detail) detail = text
  }
  detail = String(detail).slice(0, 300)
  return new ProviderError(
    `${label} error (${res.status})${detail ? `: ${detail}` : ''}`,
    {
      status: res.status,
      code: 'providerError',
      ...httpRetryFields(res),
    }
  )
}

function isOfficialHost(url, host) {
  try {
    return new URL(url).hostname === host
  } catch {
    return false
  }
}

/**
 * Ollama serves the Anthropic API (/v1/messages) without its count endpoint:
 * ollama.com, or a local server on its default port.
 */
function isOllamaHost(url) {
  try {
    const { hostname, port } = new URL(url)
    return hostname === 'ollama.com' || port === '11434'
  } catch {
    return false
  }
}

class AnthropicServerClient {
  constructor({
    apiKey,
    model,
    baseURL,
    baseUrl,
    fetchFn = providerFetch,
    connectTimeoutMs,
    streamIdleTimeoutMs,
    reasoningEffort,
    thinking,
  } = {}) {
    this.apiKey = (apiKey || '').trim()
    this.model = (model || '').trim()
    const url = normalizeProviderBaseUrl('anthropic', baseURL || baseUrl)
    this.baseURL = resolveDockerHostUrl(url)
    this.fetch = fetchFn
    this.connectTimeoutMs =
      connectTimeoutMs ??
      defaultConnectMs()
    this.streamIdleTimeoutMs =
      streamIdleTimeoutMs ??
      defaultIdleMs()
    this.reasoningEffort = reasoningEffortFor('anthropic', reasoningEffort)
    this.thinking = thinkingFor(thinking)
  }

  /**
   * api.anthropic.com takes x-api-key. Compatible endpoints such as Ollama
   * cloud (https://ollama.com) reject it alone and want a bearer token, so
   * any other host gets both.
   */
  headers(extra = {}) {
    const headers = {
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
      ...extra,
    }
    if (this.apiKey && !isOfficialHost(this.baseURL, 'api.anthropic.com')) {
      headers.authorization = `Bearer ${this.apiKey}`
    }
    return headers
  }

  /**
   * Exact counts are asked on any base URL of this type but Ollama's, which
   * has no count endpoint and keeps the estimate: a gateway that routes the
   * count endpoint answers, and one that does not is marked unsupported on
   * first failure (see AiAssistContextUsage).
   */
  get exactCountsSupported() {
    return !isOllamaHost(this.baseURL)
  }

  /**
   * The input tokens the API counts for these parts, sent with a one-word user
   * turn so the caller can take that base count away.
   */
  async countTokens({ system = '', tools = [], signal } = {}) {
    const body = {
      model: this.model,
      messages: [{ role: 'user', content: 'x' }],
    }
    if (system) body.system = system
    if (tools.length) body.tools = tools.map(t => toolWireSpec('anthropic', t))
    const res = await fetchWithRetry(
      `${this.baseURL}/v1/messages/count_tokens`,
      {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
        signal,
        providerRequest: true,
      },
      { fetchFn: this.fetch, policy: resolveRetryPolicy('inline') }
    )
    if (!res.ok) throw await countReplyError('Anthropic count API', res)
    const count = Number((await readJsonReply(res))?.input_tokens)
    if (!Number.isFinite(count)) {
      throw new ProviderError('Anthropic count API gave no count', {
        code: 'providerError',
      })
    }
    return count
  }

  async listModels({ signal } = {}) {
    const headers = this.headers()
    const models = []
    let cursor = null
    for (let page = 0; page < 10; page++) {
      const url = new URL(`${this.baseURL}/v1/models`)
      url.searchParams.set('limit', '1000')
      if (cursor) url.searchParams.set('after_id', cursor)
      const payload = await fetchModelList(
        this.fetch,
        url.toString(),
        headers,
        signal
      )
      for (const entry of Array.isArray(payload?.data) ? payload.data : []) {
        if (entry && typeof entry.id === 'string') {
          const label =
            entry.display_name ||
            entry.name ||
            entry.title ||
            entry.description ||
            entry.id
          models.push({ id: entry.id, label, ...parseModelLimits(entry) })
        }
      }
      if (!payload?.has_more || !payload?.last_id) break
      cursor = payload.last_id
    }
    return models
  }

  async *streamChat({
    system,
    messages,
    maxTokens = 8192,
    tools = [],
    cacheHints,
    signal,
  }) {
    const timeouts = withRequestTimeouts(signal, {
      connectMs: this.connectTimeoutMs,
      idleMs: this.streamIdleTimeoutMs,
    })

    const ephemeral = cacheControlValue()
    const systemField = anthropicSystemField(system, cacheHints)

    const wire = []

    for (const message of messages) {
      if (message.role === 'tool') {
        const safeContent =
          typeof message.content === 'string' &&
          message.content.trim().length > 0
            ? message.content
            : '(empty result)'
        // Anthropic takes images inside the tool result itself
        const images = toolImages(message)
        const block = {
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content:
            images.length > 0
              ? [
                  { type: 'text', text: safeContent },
                  ...images.map(image => ({
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: image.mediaType,
                      data: image.data,
                    },
                  })),
                ]
              : safeContent,
          is_error: Boolean(message.isError),
        }
        const previous = wire.at(-1)
        if (
          previous?.role === 'user' &&
          Array.isArray(previous.content) &&
          previous.content[0]?.type === 'tool_result'
        ) {
          previous.content.push(block)
        } else {
          wire.push({ role: 'user', content: [block] })
        }
        continue
      }

      if (message.role === 'assistant' && message.toolCalls?.length) {
        const content = []
        if (message.content)
          content.push({ type: 'text', text: message.content })
        for (const call of message.toolCalls) {
          let input = call.args ?? {}
          if (typeof input === 'string') {
            try {
              input = JSON.parse(input)
            } catch {
              input = {}
            }
          }
          content.push({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input,
          })
        }
        wire.push({ role: 'assistant', content })
        continue
      }

      // A message the user sent while tools ran shares the turn of their
      // results, after them, as Claude Code sends it. The API merges
      // consecutive user turns anyway; some gateways reject them instead.
      const imageBlocks =
        message.role === 'user' && Array.isArray(message.images)
          ? message.images.map(image => ({
              type: 'image',
              source: {
                type: 'base64',
                media_type: image.mediaType,
                data: image.data,
              },
            }))
          : []
      const lastTurn = wire.at(-1)
      if (message.role === 'user' && lastTurn?.role === 'user') {
        if (typeof lastTurn.content === 'string') {
          lastTurn.content = [{ type: 'text', text: lastTurn.content }]
        }
        lastTurn.content.push(...imageBlocks, {
          type: 'text',
          text: message.content || ' ',
        })
        continue
      }

      wire.push({
        role: message.role,
        content:
          imageBlocks.length > 0
            ? [...imageBlocks, { type: 'text', text: message.content || ' ' }]
            : message.content || ' ',
      })
    }

    // `cacheHints.lastStableMessage` is an index into the agent messages and
    // is not valid on `wire`; the breakpoints are placed on `wire` directly.
    if (cacheHints) {
      markMessageCacheBreakpoints(wire)
    }

    const isClaude37 =
      this.model.includes('claude-3-7') ||
      this.model.includes('claude-3.7') ||
      (this.model.includes('claude') && this.model.includes('thinking'))
    let effectiveMaxTokens = maxTokens
    let thinkingPayload = null
    // Extended thinking is opt-in: with the switch off no thinking field goes
    if (this.thinking === false) {
      thinkingPayload = null
    } else if (isClaude37) {
      const budget = Math.min(Math.max(1024, maxTokens - 1024), 4096)
      thinkingPayload = {
        type: 'enabled',
        budget_tokens: budget,
      }
      if (effectiveMaxTokens <= budget) {
        effectiveMaxTokens = budget + 2048
      }
    } else if (this.thinking || this.reasoningEffort) {
      // Effort sets thinking depth only in adaptive mode; without it the
      // model does not think and gateways ignore output_config.effort.
      thinkingPayload = { type: 'adaptive' }
    }

    let wireTools = undefined
    if (tools?.length) {
      wireTools = tools.map((t, index) => ({
        ...toolWireSpec('anthropic', t),
        ...(cacheHints?.cacheTools && index === tools.length - 1
          ? { cache_control: ephemeral }
          : {}),
      }))
    }

    const payload = {
      model: this.model,
      system: systemField,
      messages: wire,
      max_tokens: effectiveMaxTokens,
      stream: true,
      ...(thinkingPayload ? { thinking: thinkingPayload } : {}),
      ...(this.reasoningEffort
        ? { output_config: { effort: this.reasoningEffort } }
        : {}),
      ...(wireTools ? { tools: wireTools } : {}),
    }

    let res
    try {
      res = await fetchWithRetry(
        `${this.baseURL}/v1/messages`,
        {
          method: 'POST',
          headers: this.headers({ 'content-type': 'application/json' }),
          body: JSON.stringify(payload),
          signal: timeouts.signal,
          providerRequest: true,
        },
        { fetchFn: this.fetch, maxRetries: 0 }
      )
    } catch (err) {
      timeouts.checkAbortReason()
      throw err
    } finally {
      timeouts.clearConnectTimeout()
    }

    if (!res.ok) {
      let msg = `Anthropic API error (${res.status})`
      let code =
        res.status === 401 || res.status === 403
          ? 'providerAuth'
          : 'providerError'
      const retry = httpRetryFields(res)
      try {
        const body = await readJsonReply(res)
        if (body?.error?.message) msg = body.error.message
        if (body?.error?.type === 'authentication_error') code = 'providerAuth'
      } catch {}
      throw new ProviderError(msg, {
        status: res.status,
        code,
        ...retry,
      })
    }

    let activeTool = null
    let truncated = false
    // message_start carries the input counts, message_delta the output count
    let reported = null
    try {
      timeouts.resetIdleTimer()
      for await (const data of parseSseLines(res.body, () =>
        timeouts.resetIdleTimer()
      )) {
        timeouts.resetIdleTimer()
        if (data === '[DONE]') break
        let parsed
        try {
          parsed = JSON.parse(data)
        } catch {
          continue
        }

        if (parsed.type === 'message_start') {
          reported = { ...reported, ...parsed.message?.usage }
        } else if (parsed.type === 'message_delta' && parsed.usage) {
          reported = { ...reported, ...parsed.usage }
        }

        if (parsed.type === 'error') {
          throw new ProviderError(
            parsed.error?.message || 'Anthropic stream error',
            {
              code:
                parsed.error?.type === 'authentication_error'
                  ? 'providerAuth'
                  : 'providerError',
              status: streamErrorStatus(parsed.error?.type),
            }
          )
        }

        if (parsed.type === 'content_block_start') {
          if (parsed.content_block?.type === 'tool_use') {
            activeTool = {
              id: parsed.content_block.id,
              name: parsed.content_block.name,
              rawArgs: '',
            }
          }
        } else if (parsed.type === 'content_block_delta') {
          const delta = parsed.delta
          if (delta?.type === 'thinking_delta') {
            yield { type: 'thinking', text: delta.thinking }
          } else if (delta?.type === 'text_delta') {
            yield { type: 'text', text: delta.text }
          } else if (delta?.type === 'input_json_delta' && activeTool) {
            activeTool.rawArgs += delta.partial_json
          }
        } else if (parsed.type === 'content_block_stop' && activeTool) {
          const args = safeParseToolArgs(activeTool.rawArgs)
          yield {
            type: 'tool_call',
            id: activeTool.id,
            name: activeTool.name,
            args,
          }
          activeTool = null
        } else if (parsed.type === 'message_delta') {
          if (parsed.delta?.stop_reason === 'max_tokens') truncated = true
        } else if (parsed.type === 'message_stop') {
          if (activeTool) {
            const args = safeParseToolArgs(activeTool.rawArgs)
            yield {
              type: 'tool_call',
              id: activeTool.id,
              name: activeTool.name,
              args,
            }
            activeTool = null
          }
          break
        }
      }
    } catch (err) {
      timeouts.checkAbortReason()
      throw err
    } finally {
      timeouts.clearAllTimeouts()
    }

    if (activeTool) {
      const args = safeParseToolArgs(activeTool.rawArgs)
      yield {
        type: 'tool_call',
        id: activeTool.id,
        name: activeTool.name,
        args,
      }
    }

    if (reported) {
      yield* usageChunks({
        inputTokens: reported.input_tokens,
        outputTokens: reported.output_tokens,
        cacheReadTokens: reported.cache_read_input_tokens,
        cacheCreationTokens: reported.cache_creation_input_tokens,
      })
    }

    if (truncated) yield { type: 'stop', reason: 'max_tokens' }
  }
}

/**
 * OpenAI-only request fields go only to OpenAI's own API. Compatible gateways
 * and local servers reject or mishandle fields they do not know.
 */
export function isOfficialOpenAiUrl(url) {
  return isOfficialHost(url, 'api.openai.com')
}

/** Groups requests for OpenAI's cache routing without sending the raw key. */
export function promptCacheKey(key) {
  return crypto
    .createHash('sha256')
    .update(String(key))
    .digest('hex')
    .slice(0, 32)
}

export class OpenAiServerClient {
  constructor({
    apiKey,
    model,
    baseURL,
    baseUrl,
    fetchFn = providerFetch,
    connectTimeoutMs,
    streamIdleTimeoutMs,
    reasoningEffort,
  } = {}) {
    this.apiKey = (apiKey || '').trim()
    this.model = (model || '').trim()
    const url = normalizeProviderBaseUrl('openai', baseURL || baseUrl)
    this.baseURL = resolveDockerHostUrl(url)
    this.fetch = fetchFn
    this.connectTimeoutMs =
      connectTimeoutMs ??
      defaultConnectMs()
    this.streamIdleTimeoutMs =
      streamIdleTimeoutMs ??
      defaultIdleMs()
    this.reasoningEffort = reasoningEffortFor('openai', reasoningEffort)
  }

  _getHeaders() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'content-type': 'application/json',
    }
  }

  // baseURL is normalized in the constructor: it always ends in /v1
  _getChatEndpoint() {
    return `${this.baseURL}/chat/completions`
  }

  _getModelsEndpoint() {
    return `${this.baseURL}/models`
  }

  async listModels({ signal } = {}) {
    const payload = await fetchModelList(
      this.fetch,
      this._getModelsEndpoint(),
      this._getHeaders(),
      signal
    )
    return (Array.isArray(payload?.data) ? payload.data : [])
      .filter(entry => entry && typeof entry.id === 'string')
      .map(entry => ({
        id: entry.id,
        label:
          entry.name ||
          entry.display_name ||
          entry.title ||
          entry.description ||
          entry.id,
        ...parseModelLimits(entry),
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }

  async *streamChat({
    system,
    messages,
    maxTokens = 8192,
    tools = [],
    cacheHints,
    signal,
  }) {
    const timeouts = withRequestTimeouts(signal, {
      connectMs: this.connectTimeoutMs,
      idleMs: this.streamIdleTimeoutMs,
    })
    const imageTurns = toolImageTurns(messages)
    const formattedMessages = [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...messages.flatMap((m, index) => {
        if (m.role === 'tool') {
          const safeContent =
            typeof m.content === 'string'
              ? m.content
              : JSON.stringify(m.content ?? {})
          const toolMessage = {
            role: 'tool',
            tool_call_id: m.toolCallId || 'call_0',
            content: safeContent.trim() ? safeContent : '(empty result)',
          }
          const shown = imageTurns.get(index)
          if (!shown) return [toolMessage]
          return [
            toolMessage,
            {
              role: 'user',
              content: [
                { type: 'text', text: imageTurnLabel(shown) },
                ...shown.map(({ image }) => ({
                  type: 'image_url',
                  image_url: {
                    url: `data:${image.mediaType};base64,${image.data}`,
                    detail: image.detail ?? 'high',
                  },
                })),
              ],
            },
          ]
        }
        if (m.toolCalls?.length) {
          return {
            role: 'assistant',
            content: m.content || '',
            tool_calls: m.toolCalls.map(tc => {
              let argsStr = '{}'
              if (typeof tc.args === 'string') {
                try {
                  JSON.parse(tc.args)
                  argsStr = tc.args
                } catch {
                  argsStr = JSON.stringify({ raw: tc.args })
                }
              } else if (tc.args && typeof tc.args === 'object') {
                argsStr = JSON.stringify(tc.args)
              }
              return {
                id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
                type: 'function',
                function: { name: tc.name, arguments: argsStr },
              }
            }),
          }
        }
        if (m.role === 'user' && Array.isArray(m.images) && m.images.length > 0) {
          return {
            role: 'user',
            content: [
              ...m.images.map(image => ({
                type: 'image_url',
                image_url: {
                  url: `data:${image.mediaType};base64,${image.data}`,
                  detail: image.detail ?? 'high',
                },
              })),
              { type: 'text', text: m.content || '' },
            ],
          }
        }
        return { role: m.role, content: m.content || '' }
      }),
    ]

    const official = isOfficialOpenAiUrl(this.baseURL)
    const payload = {
      model: this.model,
      messages: formattedMessages,
      // OpenAI's reasoning models reject max_tokens; compatible servers often
      // do not know max_completion_tokens.
      ...(official
        ? { max_completion_tokens: maxTokens }
        : { max_tokens: maxTokens }),
      stream: true,
      // The usage arrives in a chunk after the finish reason. Compatible
      // servers may not know the field, so only OpenAI itself gets it.
      ...(official ? { stream_options: { include_usage: true } } : {}),
      ...(this.reasoningEffort
        ? { reasoning_effort: this.reasoningEffort }
        : {}),
      ...(official && cacheHints?.cacheKey
        ? { prompt_cache_key: promptCacheKey(cacheHints.cacheKey) }
        : {}),
    }

    if (tools?.length) {
      payload.tools = tools.map(t => toolWireSpec('openai', t))
    }

    let res
    try {
      res = await fetchWithRetry(
        this._getChatEndpoint(),
        {
          method: 'POST',
          headers: this._getHeaders(),
          body: JSON.stringify(payload),
          signal: timeouts.signal,
          providerRequest: true,
        },
        { fetchFn: this.fetch, maxRetries: 0 }
      )
    } catch (err) {
      timeouts.checkAbortReason()
      throw err
    } finally {
      timeouts.clearConnectTimeout()
    }

    if (!res.ok) throw await openAiError(res)

    const pendingToolCalls = new Map()
    // wire index -> the call in pendingToolCalls open at that index
    const openToolCalls = new Map()
    const thinkParser = new StreamingThinkParser()
    let truncated = false
    let reported = null

    try {
      timeouts.resetIdleTimer()
      for await (const data of parseSseLines(res.body, () =>
        timeouts.resetIdleTimer()
      )) {
        timeouts.resetIdleTimer()
        if (data === '[DONE]') break
        let parsed
        try {
          parsed = JSON.parse(data)
        } catch {
          continue
        }

        if (parsed.usage) reported = parsed.usage

        const choice = parsed.choices?.[0]
        const delta = choice?.delta

        const thinkingDelta =
          delta?.reasoning_content ??
          delta?.reasoning ??
          delta?.thinking ??
          delta?.reasoning_text
        if (thinkingDelta) {
          yield { type: 'thinking', text: thinkingDelta }
        }

        if (delta?.content) {
          for (const item of thinkParser.feed(delta.content)) {
            yield item
          }
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            // Ollama's /v1 gives every parallel call index 0, told apart only
            // by id: a new id at a used index is a new call, not more of it
            const index = tc.index ?? 0
            let curr = openToolCalls.get(index)
            if (!curr || (tc.id && curr.id && tc.id !== curr.id)) {
              curr = { id: tc.id, name: tc.function?.name || '', rawArgs: '' }
              openToolCalls.set(index, curr)
              pendingToolCalls.set(pendingToolCalls.size, curr)
            }
            if (tc.id) curr.id = tc.id
            if (tc.function?.name) curr.name = tc.function.name
            if (tc.function?.arguments) curr.rawArgs += tc.function.arguments
          }
        }

        if (choice?.finish_reason) {
          if (choice.finish_reason === 'length') truncated = true
          // Read on to [DONE] when usage was asked for: it follows this chunk
          if (!official) break
        }
      }
    } catch (err) {
      timeouts.checkAbortReason()
      throw err
    } finally {
      timeouts.clearAllTimeouts()
    }

    for (const item of thinkParser.flush()) {
      yield item
    }

    for (const tool of pendingToolCalls.values()) {
      const args = safeParseToolArgs(tool.rawArgs)
      yield {
        type: 'tool_call',
        id: tool.id,
        name: tool.name,
        args,
      }
    }

    if (reported) {
      // prompt_tokens includes the cached part, which is reported on its own
      const cached = Number(reported.prompt_tokens_details?.cached_tokens) || 0
      yield* usageChunks({
        inputTokens: Math.max(0, (Number(reported.prompt_tokens) || 0) - cached),
        outputTokens: reported.completion_tokens,
        cacheReadTokens: cached,
        cacheCreationTokens: 0,
      })
    }

    if (truncated) yield { type: 'stop', reason: 'max_tokens' }
  }
}

/**
 * A picture for a Gemini request. Gemini 3 and later take a per-part media
 * resolution; the field name follows the generateContent REST shape and is not
 * yet confirmed against the live API (see AiAssistImagePolicy.mjs).
 */
function geminiImagePart(image) {
  const part = { inlineData: { mimeType: image.mediaType, data: image.data } }
  if (image.mediaResolution) {
    part.mediaResolution = { level: 'MEDIA_RESOLUTION_HIGH' }
  }
  return part
}

export function toGeminiContents(messages) {
  const contents = []
  let pendingImageParts = []

  for (const [index, message] of messages.entries()) {
    if (message.role === 'tool') {
      let responseObj
      if (typeof message.content === 'string') {
        try {
          responseObj = JSON.parse(message.content)
        } catch {
          responseObj = { output: message.content }
        }
      } else if (message.content && typeof message.content === 'object') {
        responseObj = message.content
      } else {
        responseObj = { output: String(message.content ?? '') }
      }

      const part = {
        functionResponse: {
          name: message.name || 'tool',
          response: responseObj,
        },
      }
      const prev = contents.at(-1)
      if (prev && prev.role === 'user') {
        prev.parts.push(part)
      } else {
        contents.push({ role: 'user', parts: [part] })
      }
      // Images go after the step's last function response, in the same turn,
      // so parallel responses stay together in the order of their calls.
      for (const image of toolImages(message)) {
        pendingImageParts.push(geminiImagePart(image))
      }
      if (messages[index + 1]?.role !== 'tool' && pendingImageParts.length) {
        contents.at(-1).parts.push(...pendingImageParts)
        pendingImageParts = []
      }
      continue
    }

    if (message.role === 'assistant') {
      const parts = []
      if (message.content) {
        parts.push({ text: message.content })
      }
      if (message.toolCalls?.length) {
        for (const tc of message.toolCalls) {
          let args = tc.args ?? {}
          if (typeof args === 'string') {
            try {
              args = JSON.parse(args)
            } catch {
              args = {}
            }
          }
          parts.push({
            functionCall: {
              name: tc.name,
              args,
            },
          })
        }
      }
      if (parts.length > 0) {
        contents.push({ role: 'model', parts })
      }
      continue
    }

    // role === 'user'
    const parts = [
      ...(Array.isArray(message.images)
        ? message.images.map(geminiImagePart)
        : []),
      { text: message.content || ' ' },
    ]
    const prev = contents.at(-1)
    if (prev && prev.role === 'user') {
      prev.parts.push(...parts)
    } else {
      contents.push({ role: 'user', parts })
    }
  }

  return contents
}

/** A Gemini model id as a URL path segment, without its `models/` prefix. */
function geminiModelSegment(model) {
  return encodeURIComponent(model.replace(/^models\//, ''))
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
}

/**
 * Google Gemini native REST API (v1beta) client.
 * Calls `POST /models/{model}:streamGenerateContent?alt=sse` directly with native
 * contents, systemInstruction, thinkingConfig, and functionDeclarations schemas.
 */
export class GoogleServerClient {
  constructor({
    apiKey,
    model,
    baseURL,
    baseUrl,
    fetchFn = providerFetch,
    connectTimeoutMs,
    streamIdleTimeoutMs,
    reasoningEffort,
    thinking,
  } = {}) {
    this.apiKey = (apiKey || '').trim()
    this.model = (model || 'gemini-2.0-flash').trim()
    const url = normalizeProviderBaseUrl('google', baseURL || baseUrl)
    this.baseURL = resolveDockerHostUrl(url)
    this.fetch = fetchFn
    this.connectTimeoutMs =
      connectTimeoutMs ??
      defaultConnectMs()
    this.streamIdleTimeoutMs =
      streamIdleTimeoutMs ??
      defaultIdleMs()
    this.reasoningEffort = reasoningEffortFor('google', reasoningEffort)
    this.thinking = thinkingFor(thinking)
  }

  /** Exact counts are asked on any base URL of this type (see the Anthropic client). */
  get exactCountsSupported() {
    return true
  }

  /**
   * The total tokens the API counts for these parts, sent with a one-word user
   * turn so the caller can take that base count away.
   */
  async countTokens({ system = '', tools = [], signal } = {}) {
    const model = this.model.replace(/^models\//, '')
    const generateContentRequest = {
      model: `models/${model}`,
      contents: [{ role: 'user', parts: [{ text: 'x' }] }],
    }
    if (system) {
      generateContentRequest.systemInstruction = { parts: [{ text: system }] }
    }
    if (tools.length) {
      generateContentRequest.tools = [
        { functionDeclarations: tools.map(t => toolWireSpec('google', t)) },
      ]
    }
    const res = await fetchWithRetry(
      `${this.baseURL}/models/${geminiModelSegment(this.model)}:countTokens`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify({ generateContentRequest }),
        signal,
        providerRequest: true,
      },
      { fetchFn: this.fetch, policy: resolveRetryPolicy('inline') }
    )
    if (!res.ok) throw await countReplyError('Google count API', res)
    const count = Number((await readJsonReply(res))?.totalTokens)
    if (!Number.isFinite(count)) {
      throw new ProviderError('Google count API gave no count', {
        code: 'providerError',
      })
    }
    return count
  }

  async listModels({ signal } = {}) {
    const payload = await fetchModelList(
      this.fetch,
      `${this.baseURL}/models`,
      { 'x-goog-api-key': this.apiKey },
      signal
    )
    return (Array.isArray(payload?.models) ? payload.models : [])
      .filter(
        m =>
          m &&
          Array.isArray(m.supportedGenerationMethods) &&
          m.supportedGenerationMethods.includes('generateContent')
      )
      .map(m => {
        const id = (m.name || '').replace(/^models\//, '')
        return {
          id,
          label: m.displayName || id,
          contextWindow: m.inputTokenLimit || 1048576,
          maxOutputTokens: m.outputTokenLimit || 8192,
        }
      })
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  async *streamChat({
    system,
    messages,
    maxTokens = 8192,
    tools = [],
    signal,
  }) {
    const timeouts = withRequestTimeouts(signal, {
      connectMs: this.connectTimeoutMs,
      idleMs: this.streamIdleTimeoutMs,
    })

    const cleanModel = geminiModelSegment(this.model)
    const url = `${this.baseURL}/models/${cleanModel}:streamGenerateContent?alt=sse`

    const contents = toGeminiContents(messages)
    const isThinkingModel =
      cleanModel.includes('thinking') ||
      cleanModel.includes('2.5') ||
      cleanModel.includes('pro')

    // Gemini 3 has no off switch; "minimal" is its lowest level
    const off = this.thinking === false
    const effort = off ? 'minimal' : this.reasoningEffort
    const thinkingConfig = effort
      ? {
          includeThoughts: !off,
          ...(cleanModel.includes('2.5')
            ? { thinkingBudget: geminiThinkingBudget(effort, cleanModel) }
            : { thinkingLevel: effort }),
        }
      : isThinkingModel
        ? { includeThoughts: true }
        : null

    const payload = {
      contents,
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature: 0.2,
        ...(thinkingConfig ? { thinkingConfig } : {}),
      },
    }

    if (system) {
      payload.systemInstruction = {
        parts: [{ text: system }],
      }
    }

    if (tools?.length) {
      payload.tools = [
        {
          functionDeclarations: tools.map(t => toolWireSpec('google', t)),
        },
      ]
    }

    const headers = {
      'content-type': 'application/json',
      'x-goog-api-key': this.apiKey,
    }

    let res
    try {
      res = await fetchWithRetry(
        url,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: timeouts.signal,
          providerRequest: true,
        },
        { fetchFn: this.fetch, maxRetries: 0 }
      )
    } catch (err) {
      timeouts.checkAbortReason()
      throw err
    } finally {
      timeouts.clearConnectTimeout()
    }

    if (!res.ok) {
      let msg = `Google Gemini API error (${res.status})`
      let code =
        res.status === 401 || res.status === 403
          ? 'providerAuth'
          : 'providerError'
      const retry = httpRetryFields(res)
      try {
        const body = await readJsonReply(res)
        if (body?.error?.message) msg = body.error.message
        if (
          body?.error?.status === 'UNAUTHENTICATED' ||
          body?.error?.status === 'PERMISSION_DENIED'
        ) {
          code = 'providerAuth'
        }
      } catch {}
      throw new ProviderError(msg, { status: res.status, code, ...retry })
    }

    const thinkParser = new StreamingThinkParser()
    let toolCallIndex = 0
    let truncated = false
    let reported = null

    try {
      timeouts.resetIdleTimer()
      for await (const data of parseSseLines(res.body, () =>
        timeouts.resetIdleTimer()
      )) {
        timeouts.resetIdleTimer()
        if (data === '[DONE]') break
        let parsed
        try {
          parsed = JSON.parse(data)
        } catch {
          continue
        }

        if (parsed.error) {
          throw new ProviderError(
            typeof parsed.error === 'string'
              ? parsed.error
              : parsed.error.message || 'Gemini error',
            {
              code: 'providerError',
              // Google's error body carries the HTTP status as a number
              status:
                typeof parsed.error?.code === 'number'
                  ? parsed.error.code
                  : undefined,
            }
          )
        }

        // Counted on every chunk, the last one to carry it wins
        if (parsed.usageMetadata) reported = parsed.usageMetadata

        const candidate = parsed.candidates?.[0]
        const parts = candidate?.content?.parts
        if (!Array.isArray(parts)) continue

        for (const part of parts) {
          if (part.thought) {
            yield { type: 'thinking', text: part.text || '' }
            continue
          }

          if (part.text) {
            for (const item of thinkParser.feed(part.text)) {
              yield item
            }
          }

          if (part.functionCall) {
            toolCallIndex++
            const id = `call_gemini_${Date.now()}_${toolCallIndex}`
            yield {
              type: 'tool_call',
              id,
              name: part.functionCall.name,
              args: part.functionCall.args || {},
            }
          }
        }

        if (candidate?.finishReason) {
          if (candidate.finishReason === 'MAX_TOKENS') truncated = true
          break
        }
      }
    } catch (err) {
      timeouts.checkAbortReason()
      throw err
    } finally {
      timeouts.clearAllTimeouts()
    }

    for (const item of thinkParser.flush()) {
      yield item
    }

    if (reported) {
      // promptTokenCount includes the cached part; thoughts bill as output
      const cached = Number(reported.cachedContentTokenCount) || 0
      yield* usageChunks({
        inputTokens: Math.max(
          0,
          (Number(reported.promptTokenCount) || 0) - cached
        ),
        outputTokens:
          (Number(reported.candidatesTokenCount) || 0) +
          (Number(reported.thoughtsTokenCount) || 0),
        cacheReadTokens: cached,
      })
    }

    if (truncated) yield { type: 'stop', reason: 'max_tokens' }
  }
}

/**
 * `baseURL|model` pairs that answered "does not support thinking". Sending
 * think: true to such a model is an HTTP 400, so after the first refusal the
 * flag is left out for that model.
 */
const ollamaThinkUnsupported = new Set()

async function ollamaErrorMessage(res) {
  let msg = `Ollama error (${res.status})`
  try {
    const json = await readJsonReply(res)
    if (json?.error)
      msg =
        typeof json.error === 'string' ? json.error : json.error.message || msg
  } catch {}
  return msg
}

export class OllamaServerClient {
  constructor({
    apiKey,
    model,
    baseURL,
    baseUrl,
    fetchFn = providerFetch,
    connectTimeoutMs,
    streamIdleTimeoutMs,
    reasoningEffort,
    thinking,
  } = {}) {
    this.apiKey = (apiKey || '').trim()
    this.model = (model || '').trim()
    const url = normalizeProviderBaseUrl('ollama', baseURL || baseUrl)
    this.baseURL = resolveDockerHostUrl(url)
    this.fetch = fetchFn
    this.connectTimeoutMs =
      connectTimeoutMs ??
      defaultConnectMs()
    this.streamIdleTimeoutMs =
      streamIdleTimeoutMs ??
      defaultIdleMs()
    this.reasoningEffort = reasoningEffortFor('ollama', reasoningEffort)
    this.thinking = thinkingFor(thinking)
  }

  async listModels({ signal } = {}) {
    const headers = {}
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`
    const payload = await fetchModelList(
      this.fetch,
      `${this.baseURL}/api/tags`,
      headers,
      signal
    )
    const rawList = Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload?.data)
        ? payload.data
        : []
    return rawList
      .map(entry => {
        const id = entry?.name || entry?.model || entry?.id
        const label =
          entry?.name ||
          entry?.display_name ||
          entry?.title ||
          entry?.model ||
          entry?.id
        return { id, label, ...parseModelLimits(entry) }
      })
      .filter(entry => typeof entry.id === 'string' && entry.id)
      .sort((a, b) => a.label.localeCompare(b.label))
  }

  async *streamChat({
    system,
    messages,
    maxTokens = 8192,
    tools = [],
    contextWindow,
    signal,
  }) {
    const timeouts = withRequestTimeouts(signal, {
      connectMs: this.connectTimeoutMs,
      idleMs: this.streamIdleTimeoutMs,
    })

    const wireMessages = toOllamaMessages(system, messages)
    const wireTools = tools?.map(tool => toolWireSpec('ollama', tool))

    const thinkKey = `${this.baseURL}|${this.model}`
    const numCtx =
      Number(contextWindow) > 0 ? Math.floor(Number(contextWindow)) : null
    const body = {
      model: this.model,
      messages: wireMessages,
      stream: true,
      ...(ollamaThinkUnsupported.has(thinkKey)
        ? {}
        : {
            think:
              this.thinking === false ? false : (this.reasoningEffort ?? true),
          }),
      options: {
        num_predict: maxTokens,
        // Without num_ctx Ollama uses its small default window and silently
        // drops the start of the prompt, while the harness budgets for this one.
        ...(numCtx ? { num_ctx: numCtx } : {}),
      },
      ...(wireTools?.length ? { tools: wireTools } : {}),
    }

    const headers = { 'content-type': 'application/json' }
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`

    const send = async () => {
      try {
        return await fetchWithRetry(
          `${this.baseURL}/api/chat`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: timeouts.signal,
            providerRequest: true,
          },
          { fetchFn: this.fetch, maxRetries: 0 }
        )
      } catch (err) {
        timeouts.checkAbortReason()
        if (err.name === 'AbortError' || err.code === 'aborted') throw err
        throw new ProviderError(
          `Could not reach Ollama at ${this.baseURL}: ${err.message}`,
          {
            code: 'network',
          }
        )
      }
    }

    let res
    try {
      res = await send()
      if (!res.ok && body.think !== undefined) {
        const retry = httpRetryFields(res)
        const message = await ollamaErrorMessage(res)
        if (!/does not support thinking/i.test(message)) {
          throw new ProviderError(message, {
            status: res.status,
            code: 'providerError',
            ...retry,
          })
        }
        ollamaThinkUnsupported.add(thinkKey)
        delete body.think
        res = await send()
      }
    } finally {
      timeouts.clearConnectTimeout()
    }

    if (!res.ok) {
      const retry = httpRetryFields(res)
      throw new ProviderError(await ollamaErrorMessage(res), {
        status: res.status,
        code: 'providerError',
        ...retry,
      })
    }

    const pendingToolCalls = new Map()
    const thinkParser = new StreamingThinkParser()
    let truncated = false
    let reported = null

    try {
      timeouts.resetIdleTimer()
      for await (const chunk of parseNdjsonLines(res.body, () =>
        timeouts.resetIdleTimer()
      )) {
        timeouts.resetIdleTimer()
        if (!chunk) continue
        let parsed
        try {
          parsed = JSON.parse(chunk)
        } catch {
          continue
        }

        if (parsed.error) {
          throw new ProviderError(
            typeof parsed.error === 'string'
              ? parsed.error
              : parsed.error.message || 'Ollama returned an error.',
            { code: 'providerError' }
          )
        }

        // The done chunk carries the counts, and may have no message
        if (parsed.done) reported = parsed

        const msg = parsed.message
        if (!msg) continue

        if (msg.thinking) {
          yield { type: 'thinking', text: msg.thinking }
        } else if (msg.reasoning) {
          yield { type: 'thinking', text: msg.reasoning }
        }

        if (msg.content) {
          for (const item of thinkParser.feed(msg.content)) {
            yield item
          }
        }

        if (Array.isArray(msg.tool_calls)) {
          for (let i = 0; i < msg.tool_calls.length; i++) {
            const tc = msg.tool_calls[i]
            const index = tc.function?.index ?? i
            const name = tc.function?.name || tc.name || ''
            const args = tc.function?.arguments ?? tc.args ?? {}
            const id =
              tc.id ||
              (name ? `call_${name}_${index}` : `call_${Date.now()}_${index}`)
            pendingToolCalls.set(id, { id, name, args })
          }
        }

        if (parsed.done) {
          if (parsed.done_reason === 'length') truncated = true
          break
        }
      }
    } catch (err) {
      timeouts.checkAbortReason()
      throw err
    } finally {
      timeouts.clearAllTimeouts()
    }

    for (const item of thinkParser.flush()) {
      yield item
    }

    for (const tool of pendingToolCalls.values()) {
      yield {
        type: 'tool_call',
        id: tool.id,
        name: tool.name,
        args:
          typeof tool.args === 'string'
            ? safeParseToolArgs(tool.args)
            : tool.args,
      }
    }

    if (reported) {
      // prompt_eval_count leaves out the prefix Ollama served from its
      // KV cache, so the input count is a floor
      yield* usageChunks({
        inputTokens: reported.prompt_eval_count,
        outputTokens: reported.eval_count,
        partialInput: true,
      })
    }

    if (truncated) yield { type: 'stop', reason: 'max_tokens' }
  }
}

export function createProviderClient(settings) {
  const type = settings?.type
  const rawUrl = settings?.baseUrl || settings?.baseURL
  const normalizedUrl = normalizeProviderBaseUrl(type, rawUrl)
  if (normalizedUrl) {
    validateSafeProviderBaseUrl(normalizedUrl)
  }
  const normalizedSettings = {
    ...settings,
    baseUrl: normalizedUrl,
    baseURL: normalizedUrl,
  }
  if (settings.type === 'anthropic') {
    return new AnthropicServerClient(normalizedSettings)
  }
  if (settings.type === 'ollama') {
    return new OllamaServerClient(normalizedSettings)
  }
  if (settings.type === 'google') {
    return new GoogleServerClient(normalizedSettings)
  }
  return new OpenAiServerClient(normalizedSettings)
}
