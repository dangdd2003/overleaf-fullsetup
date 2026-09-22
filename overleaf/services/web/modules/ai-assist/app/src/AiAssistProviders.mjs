import crypto from 'node:crypto'
import fs from 'node:fs'
import Settings from '@overleaf/settings'
import './ModuleSettings.mjs'
import { sanitizeToolSchema } from './AiAssistToolSchema.mjs'

export class ProviderError extends Error {
  constructor(message, { code = 'providerError', status = undefined, hint = '' } = {}) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
    this.status = status
    this.hint = hint
  }
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

export function validateSafeProviderBaseUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return true
  }

  let parsed
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    throw new ProviderError('Invalid provider URL format', { code: 'invalidProviderUrl', status: 400 })
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ProviderError(`Forbidden protocol '${parsed.protocol}'. Only http and https are permitted.`, {
      code: 'invalidProviderUrl',
      status: 400,
    })
  }

  const hostname = parsed.hostname.toLowerCase()
  if (BLOCKED_INTERNAL_HOSTS.has(hostname) || hostname.endsWith('.internal')) {
    throw new ProviderError(`Access to internal service '${hostname}' is forbidden.`, {
      code: 'restrictedProviderUrl',
      status: 400,
    })
  }

  // Block link-local and cloud metadata
  if (hostname === '169.254.169.254' || hostname.startsWith('169.254.')) {
    throw new ProviderError('Access to cloud metadata endpoints is forbidden.', {
      code: 'restrictedProviderUrl',
      status: 400,
    })
  }

  return true
}

/**
 * Automatically retries transient errors (429 Rate-Limit, 500, 502, 503, 504, connection drops)
 * with exponential backoff and jitter, matching official agent SDKs.
 */
export async function fetchWithRetry(url, options, {
  maxRetries = 3,
  initialDelayMs = 1000,
  maxDelayMs = 8000,
  fetchFn = fetch,
} = {}) {
  let attempt = 0
  while (true) {
    if (options?.signal?.aborted) {
      throw new ProviderError('Request was cancelled', { code: 'aborted' })
    }

    try {
      const res = await fetchFn(url, options)

      if ((res.status === 429 || (res.status >= 500 && res.status < 600)) && attempt < maxRetries) {
        attempt++
        const retryAfter = res.headers.get('retry-after')
        let delay = initialDelayMs * Math.pow(2, attempt - 1) + Math.random() * 200
        if (retryAfter) {
          const parsed = parseInt(retryAfter, 10)
          if (!isNaN(parsed) && parsed > 0 && parsed <= 30) {
            delay = parsed * 1000
          }
        }
        delay = Math.min(delay, maxDelayMs)
        if (options?.signal?.aborted) {
          throw new ProviderError('Request was cancelled', { code: 'aborted' })
        }
        await new Promise((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(timer)
            reject(new ProviderError('Request was cancelled', { code: 'aborted' }))
          }
          const timer = setTimeout(() => {
            options?.signal?.removeEventListener('abort', onAbort)
            resolve()
          }, delay)
          options?.signal?.addEventListener('abort', onAbort, { once: true })
        })
        continue
      }

      return res
    } catch (err) {
      if (options?.signal?.aborted || err?.code === 'aborted') {
        throw new ProviderError('Request was cancelled', { code: 'aborted' })
      }
      if (err.name === 'AbortError') {
        throw err
      }
      const isTransientNetwork =
        err.code === 'ECONNRESET' ||
        err.code === 'ETIMEDOUT' ||
        err.code === 'UND_ERR_SOCKET' ||
        err.message?.includes('fetch failed') || err.message?.includes('socket hang up') || err.message?.includes('network timeout')

      if (isTransientNetwork && attempt < maxRetries) {
        attempt++
        const delay = Math.min(initialDelayMs * Math.pow(2, attempt - 1) + Math.random() * 200, maxDelayMs)
        if (options?.signal?.aborted) {
          throw new ProviderError('Request was cancelled', { code: 'aborted' })
        }
        await new Promise((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(timer)
            reject(new ProviderError('Request was cancelled', { code: 'aborted' }))
          }
          const timer = setTimeout(() => {
            options?.signal?.removeEventListener('abort', onAbort)
            resolve()
          }, delay)
          options?.signal?.addEventListener('abort', onAbort, { once: true })
        })
        continue
      }
      throw err
    }
  }
}

export function withRequestTimeouts(callerSignal, {
  connectMs,
  idleMs,
} = {}) {
  const resolvedConnectMs =
    connectMs ??
    (Settings.aiAssist?.requestTimeoutSeconds ?? 180) * 1000
  const resolvedIdleMs =
    idleMs ??
    (Settings.aiAssist?.streamIdleSeconds ?? 120) * 1000

  const connectController = new AbortController()
  const idleController = new AbortController()
  let connectTimer = null
  let idleTimer = null

  if (resolvedConnectMs && resolvedConnectMs > 0) {
    connectTimer = setTimeout(() => connectController.abort(), resolvedConnectMs)
    connectTimer.unref?.()
  }

  const combinedSignal = AbortSignal.any(
    [callerSignal, connectController.signal, idleController.signal].filter(Boolean)
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
      throw new ProviderError('Request was cancelled', { code: 'aborted', status: undefined })
    }
    if (connectController.signal.aborted) {
      throw new ProviderError('Connection timed out', { code: 'aborted', status: undefined })
    }
    if (idleController.signal.aborted) {
      throw new ProviderError(
        `Stream stalled: no data received for ${Math.round(resolvedIdleMs / 1000)}s`,
        { code: 'providerError', status: undefined }
      )
    }
  }

  return {
    signal: combinedSignal,
    clearConnectTimeout,
    resetIdleTimer,
    clearAllTimeouts,
    checkAbortReason,
    connectController,
    idleController,
  }
}

export function resolveDockerHostUrl(url) {
  if (!url) return url
  const isDocker = Boolean(process.env.DOCKER) || fs.existsSync('/.dockerenv')
  if (isDocker) {
    const hostGateway = process.env.DOCKER_HOST_GATEWAY || '172.20.0.1'
    return url.replace(/https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/, (_match, _host, port) => {
      const portPart = port || ''
      return `http://${hostGateway}${portPart}`
    })
  }
  return url
}

export class StreamingThinkParser {
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

export async function* parseNdjsonLines(stream, onActivity) {
  const reader = stream[Symbol.asyncIterator]()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.next()
    if (done) break
    if (onActivity) onActivity()
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed) yield trimmed
    }
  }

  if (buffer.trim()) {
    yield buffer.trim()
  }
}

export function toOllamaMessages(system, messages) {
  const wire = []
  if (system) {
    wire.push({ role: 'system', content: system })
  }
  for (const message of messages) {
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
      wire.push({ role: message.role, content: message.content || '' })
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
  const reader = stream[Symbol.asyncIterator]()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.next()
    if (done) break
    if (onActivity) onActivity()
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith(':')) continue
      if (trimmed.startsWith('data:')) {
        const rawData = line.slice(line.indexOf('data:') + 5)
        yield rawData.startsWith(' ') ? rawData.slice(1) : rawData
      }
    }
  }

  if (buffer.trim()) {
    const trimmed = buffer.trim()
    if (trimmed.startsWith('data:') && !trimmed.startsWith(':')) {
      const rawData = buffer.slice(buffer.indexOf('data:') + 5)
      yield rawData.startsWith(' ') ? rawData.slice(1) : rawData
    }
  }
}

/**
 * Mirrors the browser-side limit parsing: gateways that report per-model limits
 * on their models listing use these field names.
 */
export function parseModelLimits(entry) {
  const contextWindow =
    entry?.max_input_tokens ?? entry?.context_window ?? entry?.details?.context_length
  let maxOutputTokens =
    entry?.max_tokens ?? entry?.max_output_tokens ?? entry?.details?.max_output_tokens
  if (typeof contextWindow === 'number' && contextWindow >= 128000 && !maxOutputTokens) {
    maxOutputTokens = 65536
  }
  return {
    ...(typeof contextWindow === 'number' && contextWindow > 0 ? { contextWindow } : {}),
    ...(typeof maxOutputTokens === 'number' && maxOutputTokens > 0 ? { maxOutputTokens } : {}),
  }
}

async function fetchModelList(fetchFn, url, headers, signal) {
  const timeoutMs = (Settings.aiAssist?.requestTimeoutSeconds ?? 60) * 1000
  const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean))
  let res
  try {
    res = await fetchFn(url, { method: 'GET', headers, signal: combined })
  } catch (err) {
    if (signal?.aborted) {
      throw new ProviderError('Request was cancelled', { code: 'aborted' })
    }
    const origin = new URL(url).origin
    throw new ProviderError(`Could not reach ${origin}: ${err.cause?.message || err.message}`, {
      code: 'network',
      status: 502,
    })
  }
  if (!res.ok) {
    let msg = `Provider returned ${res.status} when listing models`
    try {
      const body = await res.json()
      const upstream = body?.error?.message || (typeof body?.error === 'string' ? body.error : null)
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
  return await res.json().catch(() => null)
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
  const ephemeral = { type: 'ephemeral' }
  const mark = index => {
    const entry = wire[index]
    if (!entry) return
    if (typeof entry.content === 'string') {
      entry.content = [{ type: 'text', text: entry.content, cache_control: ephemeral }]
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

class AnthropicServerClient {
  constructor({ apiKey, model, baseURL, baseUrl, fetchFn = fetch, connectTimeoutMs, streamIdleTimeoutMs } = {}) {
    this.apiKey = (apiKey || '').trim()
    this.model = (model || '').trim()
    const url = baseURL || baseUrl || 'https://api.anthropic.com'
    this.baseURL = resolveDockerHostUrl(url.trim().replace(/\/+$/, ''))
    this.fetch = fetchFn
    this.connectTimeoutMs = connectTimeoutMs ?? (Settings.aiAssist?.requestTimeoutSeconds ?? 180) * 1000
    this.streamIdleTimeoutMs = streamIdleTimeoutMs ?? (Settings.aiAssist?.streamIdleSeconds ?? 120) * 1000
  }

  async listModels({ signal } = {}) {
    const headers = { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' }
    const models = []
    let cursor = null
    for (let page = 0; page < 10; page++) {
      const url = new URL(`${this.baseURL}/v1/models`)
      url.searchParams.set('limit', '1000')
      if (cursor) url.searchParams.set('after_id', cursor)
      const payload = await fetchModelList(this.fetch, url.toString(), headers, signal)
      for (const entry of Array.isArray(payload?.data) ? payload.data : []) {
        if (entry && typeof entry.id === 'string') {
          const label = entry.display_name || entry.name || entry.title || entry.description || entry.id
          models.push({ id: entry.id, label, ...parseModelLimits(entry) })
        }
      }
      if (!payload?.has_more || !payload?.last_id) break
      cursor = payload.last_id
    }
    return models
  }

  async *streamChat({ system, messages, maxTokens = 8192, tools = [], cacheHints, signal }) {
    const timeouts = withRequestTimeouts(signal, {
      connectMs: this.connectTimeoutMs,
      idleMs: this.streamIdleTimeoutMs,
    })

    const ephemeral = { type: 'ephemeral' }
    const systemField = cacheHints?.cacheSystem
      ? [{ type: 'text', text: system, cache_control: ephemeral }]
      : system

    const wire = []

    for (const message of messages) {
      if (message.role === 'tool') {
        const safeContent =
          typeof message.content === 'string' && message.content.trim().length > 0
            ? message.content
            : '(empty result)'
        const block = {
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: safeContent,
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
        if (message.content) content.push({ type: 'text', text: message.content })
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

      wire.push({
        role: message.role,
        content: message.content || ' ',
      })
    }

    // `cacheHints.lastStableMessage` is an index into the agent messages and
    // is not valid on `wire`; the breakpoints are placed on `wire` directly.
    if (cacheHints) {
      markMessageCacheBreakpoints(wire)
    }

    const isClaude37 =
      (this.model.includes('claude-3-7') ||
        this.model.includes('claude-3.7') ||
        (this.model.includes('claude') && this.model.includes('thinking')))
    let effectiveMaxTokens = maxTokens
    let thinkingPayload = null
    if (isClaude37) {
      const budget = Math.min(Math.max(1024, maxTokens - 1024), 4096)
      thinkingPayload = {
        type: 'enabled',
        budget_tokens: budget,
      }
      if (effectiveMaxTokens <= budget) {
        effectiveMaxTokens = budget + 2048
      }
    }

    let wireTools = undefined
    if (tools?.length) {
      wireTools = tools.map((t, index) => ({
        name: t.name,
        description: t.description,
        input_schema: sanitizeToolSchema(t.parameters),
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
      ...(wireTools ? { tools: wireTools } : {}),
    }

    let res
    try {
      res = await fetchWithRetry(`${this.baseURL}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: timeouts.signal,
      }, { fetchFn: this.fetch })
    } catch (err) {
      timeouts.checkAbortReason()
      throw err
    } finally {
      timeouts.clearConnectTimeout()
    }

    if (!res.ok) {
      let msg = `Anthropic API error (${res.status})`
      let code = res.status === 401 || res.status === 403 ? 'providerAuth' : 'providerError'
      try {
        const body = await res.json()
        if (body?.error?.message) msg = body.error.message
        if (body?.error?.type === 'authentication_error') code = 'providerAuth'
      } catch {}
      throw new ProviderError(msg, { status: res.status, code })
    }

    let activeTool = null
    let truncated = false
    try {
      timeouts.resetIdleTimer()
      for await (const data of parseSseLines(res.body, () => timeouts.resetIdleTimer())) {
        timeouts.resetIdleTimer()
        if (data === '[DONE]') break
        let parsed
        try {
          parsed = JSON.parse(data)
        } catch {
          continue
        }

        if (parsed.type === 'error') {
          throw new ProviderError(parsed.error?.message || 'Anthropic stream error', {
            code: parsed.error?.type === 'authentication_error' ? 'providerAuth' : 'providerError',
            status: parsed.error?.code ? 500 : undefined,
          })
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

    if (truncated) yield { type: 'stop', reason: 'max_tokens' }
  }
}

/**
 * OpenAI-only request fields go only to OpenAI's own API. Compatible gateways
 * and local servers reject or mishandle fields they do not know.
 */
export function isOfficialOpenAiUrl(url) {
  try {
    return new URL(url).hostname === 'api.openai.com'
  } catch {
    return false
  }
}

/** Groups requests for OpenAI's cache routing without sending the raw key. */
export function promptCacheKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 32)
}

export class OpenAiServerClient {
  constructor({ apiKey, model, baseURL, baseUrl, fetchFn = fetch, connectTimeoutMs, streamIdleTimeoutMs } = {}) {
    this.apiKey = (apiKey || '').trim()
    this.model = (model || '').trim()
    const url = baseURL || baseUrl || 'https://api.openai.com'
    this.baseURL = resolveDockerHostUrl(url.trim().replace(/\/+$/, ''))
    this.fetch = fetchFn
    this.connectTimeoutMs = connectTimeoutMs ?? (Settings.aiAssist?.requestTimeoutSeconds ?? 180) * 1000
    this.streamIdleTimeoutMs = streamIdleTimeoutMs ?? (Settings.aiAssist?.streamIdleSeconds ?? 120) * 1000
  }

  _getHeaders() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'content-type': 'application/json',
    }
  }

  _getChatEndpoint() {
    const base = this.baseURL.replace(/\/+$/, '')
    if (base.endsWith('/chat/completions')) return base
    if (base.endsWith('/v1') || base.includes('/openai')) return `${base}/chat/completions`
    return `${base}/v1/chat/completions`
  }

  _getModelsEndpoint() {
    const base = this.baseURL.replace(/\/+$/, '').replace(/\/chat\/completions$/, '')
    if (base.endsWith('/v1') || base.includes('/openai')) return `${base}/models`
    return `${base}/v1/models`
  }

  async listModels({ signal } = {}) {
    const payload = await fetchModelList(this.fetch, this._getModelsEndpoint(), this._getHeaders(), signal)
    return (Array.isArray(payload?.data) ? payload.data : [])
      .filter(entry => entry && typeof entry.id === 'string')
      .map(entry => ({
        id: entry.id,
        label: entry.name || entry.display_name || entry.title || entry.description || entry.id,
        ...parseModelLimits(entry),
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }

  async *streamChat({ system, messages, maxTokens = 8192, tools = [], cacheHints, signal }) {
    const timeouts = withRequestTimeouts(signal, {
      connectMs: this.connectTimeoutMs,
      idleMs: this.streamIdleTimeoutMs,
    })
    const formattedMessages = [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...messages.map(m => {
        if (m.role === 'tool') {
          const safeContent =
            typeof m.content === 'string'
              ? m.content
              : JSON.stringify(m.content ?? {})
          return {
            role: 'tool',
            tool_call_id: m.toolCallId || 'call_0',
            content: safeContent.trim() ? safeContent : '(empty result)',
          }
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
        return { role: m.role, content: m.content || '' }
      }),
    ]

    const official = isOfficialOpenAiUrl(this.baseURL)
    const payload = {
      model: this.model,
      messages: formattedMessages,
      // OpenAI's reasoning models reject max_tokens; compatible servers often
      // do not know max_completion_tokens.
      ...(official ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
      stream: true,
      ...(official && cacheHints?.cacheKey
        ? { prompt_cache_key: promptCacheKey(cacheHints.cacheKey) }
        : {}),
    }

    if (tools?.length) {
      payload.tools = tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: sanitizeToolSchema(t.parameters),
        },
      }))
    }

    let res
    try {
      res = await fetchWithRetry(this._getChatEndpoint(), {
        method: 'POST',
        headers: this._getHeaders(),
        body: JSON.stringify(payload),
        signal: timeouts.signal,
      }, { fetchFn: this.fetch })
    } catch (err) {
      timeouts.checkAbortReason()
      throw err
    } finally {
      timeouts.clearConnectTimeout()
    }

    if (!res.ok) {
      let msg = `OpenAI API error (${res.status})`
      let code = res.status === 401 || res.status === 403 ? 'providerAuth' : 'providerError'
      try {
        const body = await res.json()
        if (body?.error?.message) msg = body.error.message
        if (body?.error?.code === 'invalid_api_key') code = 'providerAuth'
      } catch {}
      throw new ProviderError(msg, { status: res.status, code })
    }

    const pendingToolCalls = new Map()
    const thinkParser = new StreamingThinkParser()
    let truncated = false

    try {
      timeouts.resetIdleTimer()
      for await (const data of parseSseLines(res.body, () => timeouts.resetIdleTimer())) {
        timeouts.resetIdleTimer()
        if (data === '[DONE]') break
        let parsed
        try {
          parsed = JSON.parse(data)
        } catch {
          continue
        }

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
            const index = tc.index ?? 0
            if (!pendingToolCalls.has(index)) {
              pendingToolCalls.set(index, { id: tc.id, name: tc.function?.name || '', rawArgs: '' })
            }
            const curr = pendingToolCalls.get(index)
            if (tc.id) curr.id = tc.id
            if (tc.function?.name) curr.name = tc.function.name
            if (tc.function?.arguments) curr.rawArgs += tc.function.arguments
          }
        }

        if (choice?.finish_reason) {
          if (choice.finish_reason === 'length') truncated = true
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
      const args = safeParseToolArgs(tool.rawArgs)
      yield {
        type: 'tool_call',
        id: tool.id,
        name: tool.name,
        args,
      }
    }

    if (truncated) yield { type: 'stop', reason: 'max_tokens' }
  }
}

export function toGeminiContents(messages) {
  const contents = []

  for (const message of messages) {
    if (message.role === 'tool') {
      let responseObj = {}
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
    contents.push({
      role: 'user',
      parts: [{ text: message.content || ' ' }],
    })
  }

  return contents
}

/**
 * Google Gemini native REST API (v1beta) client.
 * Calls `POST /models/{model}:streamGenerateContent?alt=sse` directly with native
 * contents, systemInstruction, thinkingConfig, and functionDeclarations schemas.
 */
export class GoogleServerClient {
  constructor({ apiKey, model, baseURL, baseUrl, fetchFn = fetch, connectTimeoutMs, streamIdleTimeoutMs } = {}) {
    this.apiKey = (apiKey || '').trim()
    this.model = (model || 'gemini-2.0-flash').trim()
    const defaultUrl = 'https://generativelanguage.googleapis.com/v1beta'
    const url = baseURL || baseUrl || defaultUrl
    this.baseURL = resolveDockerHostUrl(url.trim().replace(/\/+$/, '').replace(/\/openai\/?$/, ''))
    this.fetch = fetchFn
    this.connectTimeoutMs = connectTimeoutMs ?? (Settings.aiAssist?.requestTimeoutSeconds ?? 180) * 1000
    this.streamIdleTimeoutMs = streamIdleTimeoutMs ?? (Settings.aiAssist?.streamIdleSeconds ?? 120) * 1000
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

  async *streamChat({ system, messages, maxTokens = 8192, tools = [], signal }) {
    const timeouts = withRequestTimeouts(signal, {
      connectMs: this.connectTimeoutMs,
      idleMs: this.streamIdleTimeoutMs,
    })

    const cleanModel = encodeURIComponent(this.model.replace(/^models\//, ''))
      .replace(/\(/g, '%28')
      .replace(/\)/g, '%29')
    const url = `${this.baseURL}/models/${cleanModel}:streamGenerateContent?alt=sse`

    const contents = toGeminiContents(messages)
    const isThinkingModel =
      cleanModel.includes('thinking') ||
      cleanModel.includes('2.5') ||
      cleanModel.includes('pro')

    const payload = {
      contents,
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature: 0.2,
        ...(isThinkingModel ? { thinkingConfig: { includeThoughts: true } } : {}),
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
          functionDeclarations: tools.map(t => {
            // Gemini rejects an object schema with no properties, so a
            // no-argument tool must omit `parameters` rather than send `{}`.
            const parameters = sanitizeToolSchema(t.parameters, {
              emptyObject: 'omit',
            })
            return {
              name: t.name,
              description: t.description,
              ...(parameters ? { parameters } : {}),
            }
          }),
        },
      ]
    }

    const headers = {
      'content-type': 'application/json',
      'x-goog-api-key': this.apiKey,
    }

    let res
    try {
      res = await fetchWithRetry(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: timeouts.signal,
      }, { fetchFn: this.fetch })
    } catch (err) {
      timeouts.checkAbortReason()
      throw err
    } finally {
      timeouts.clearConnectTimeout()
    }

    if (!res.ok) {
      let msg = `Google Gemini API error (${res.status})`
      let code = res.status === 401 || res.status === 403 ? 'providerAuth' : 'providerError'
      try {
        const body = await res.json()
        if (body?.error?.message) msg = body.error.message
        if (body?.error?.status === 'UNAUTHENTICATED' || body?.error?.status === 'PERMISSION_DENIED') {
          code = 'providerAuth'
        }
      } catch {}
      throw new ProviderError(msg, { status: res.status, code })
    }

    const thinkParser = new StreamingThinkParser()
    let toolCallIndex = 0
    let truncated = false

    try {
      timeouts.resetIdleTimer()
      for await (const data of parseSseLines(res.body, () => timeouts.resetIdleTimer())) {
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
            typeof parsed.error === 'string' ? parsed.error : parsed.error.message || 'Gemini error',
            { code: 'providerError' }
          )
        }

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
    const json = await res.json()
    if (json?.error) msg = typeof json.error === 'string' ? json.error : json.error.message || msg
  } catch {}
  return msg
}

export class OllamaServerClient {
  constructor({ apiKey, model, baseURL, baseUrl, fetchFn = fetch, connectTimeoutMs, streamIdleTimeoutMs } = {}) {
    this.apiKey = (apiKey || '').trim()
    this.model = (model || '').trim()
    const rawUrl = baseURL || baseUrl || 'http://localhost:11434'
    const url = rawUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '').replace(/\/+$/, '')
    this.baseURL = resolveDockerHostUrl(url)
    this.fetch = fetchFn
    this.connectTimeoutMs = connectTimeoutMs ?? (Settings.aiAssist?.requestTimeoutSeconds ?? 180) * 1000
    this.streamIdleTimeoutMs = streamIdleTimeoutMs ?? (Settings.aiAssist?.streamIdleSeconds ?? 120) * 1000
  }

  async listModels({ signal } = {}) {
    const headers = {}
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`
    const payload = await fetchModelList(this.fetch, `${this.baseURL}/api/tags`, headers, signal)
    const rawList = Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload?.data)
        ? payload.data
        : []
    return rawList
      .map(entry => {
        const id = entry?.name || entry?.model || entry?.id
        const label = entry?.name || entry?.display_name || entry?.title || entry?.model || entry?.id
        return { id, label, ...parseModelLimits(entry) }
      })
      .filter(entry => typeof entry.id === 'string' && entry.id)
      .sort((a, b) => a.label.localeCompare(b.label))
  }

  async *streamChat({ system, messages, maxTokens = 8192, tools = [], contextWindow, signal }) {
    const timeouts = withRequestTimeouts(signal, {
      connectMs: this.connectTimeoutMs,
      idleMs: this.streamIdleTimeoutMs,
    })

    const wireMessages = toOllamaMessages(system, messages)
    const wireTools = tools?.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: sanitizeToolSchema(tool.parameters),
      },
    }))

    const thinkKey = `${this.baseURL}|${this.model}`
    const numCtx = Number(contextWindow) > 0 ? Math.floor(Number(contextWindow)) : null
    const body = {
      model: this.model,
      messages: wireMessages,
      stream: true,
      ...(ollamaThinkUnsupported.has(thinkKey) ? {} : { think: true }),
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
        return await fetchWithRetry(`${this.baseURL}/api/chat`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: timeouts.signal,
        }, { fetchFn: this.fetch })
      } catch (err) {
        timeouts.checkAbortReason()
        if (err.name === 'AbortError' || err.code === 'aborted') throw err
        throw new ProviderError(`Could not reach Ollama at ${this.baseURL}: ${err.message}`, {
          code: 'network',
        })
      }
    }

    let res
    try {
      res = await send()
      if (!res.ok && body.think) {
        const message = await ollamaErrorMessage(res)
        if (!/does not support thinking/i.test(message)) {
          throw new ProviderError(message, { status: res.status, code: 'providerError' })
        }
        ollamaThinkUnsupported.add(thinkKey)
        delete body.think
        res = await send()
      }
    } finally {
      timeouts.clearConnectTimeout()
    }

    if (!res.ok) {
      throw new ProviderError(await ollamaErrorMessage(res), {
        status: res.status,
        code: 'providerError',
      })
    }

    const pendingToolCalls = new Map()
    const thinkParser = new StreamingThinkParser()
    let truncated = false

    try {
      timeouts.resetIdleTimer()
      for await (const chunk of parseNdjsonLines(res.body, () => timeouts.resetIdleTimer())) {
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
            typeof parsed.error === 'string' ? parsed.error : parsed.error.message || 'Ollama returned an error.',
            { code: 'providerError' }
          )
        }

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
            const id = tc.id || (name ? `call_${name}_${index}` : `call_${Date.now()}_${index}`)
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
        args: typeof tool.args === 'string' ? safeParseToolArgs(tool.args) : tool.args,
      }
    }

    if (truncated) yield { type: 'stop', reason: 'max_tokens' }
  }
}

export function createProviderClient(settings) {
  const url = settings?.baseUrl || settings?.baseURL
  if (url) {
    validateSafeProviderBaseUrl(url)
  }
  if (settings.type === 'anthropic') {
    return new AnthropicServerClient(settings)
  }
  if (settings.type === 'ollama') {
    return new OllamaServerClient(settings)
  }
  if (settings.type === 'google') {
    return new GoogleServerClient(settings)
  }
  return new OpenAiServerClient({
    ...settings,
    baseUrl: settings.baseUrl || settings.baseURL || 'https://api.openai.com',
  })
}
