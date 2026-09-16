import fs from 'node:fs'

export class ProviderError extends Error {
  constructor(message, { code = 'providerError', status = 500, hint = '' } = {}) {
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
  maxRetries = 2,
  initialDelayMs = 500,
  maxDelayMs = 4000,
  fetchFn = fetch,
} = {}) {
  let attempt = 0
  while (true) {
    if (options?.signal?.aborted) {
      throw new ProviderError('aborted', 'Request was cancelled')
    }

    try {
      const res = await fetchFn(url, options)

      if ((res.status === 429 || (res.status >= 500 && res.status <= 504)) && attempt < maxRetries) {
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
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delay)
          options?.signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new ProviderError('aborted', 'Request was cancelled'))
          }, { once: true })
        })
        continue
      }

      return res
    } catch (err) {
      if (err.name === 'AbortError' || err.code === 'aborted' || options?.signal?.aborted) {
        throw err
      }
      const isTransientNetwork =
        err.code === 'ECONNRESET' ||
        err.code === 'ETIMEDOUT' ||
        err.code === 'UND_ERR_SOCKET' ||
        err.message?.includes('fetch failed')

      if (isTransientNetwork && attempt < maxRetries) {
        attempt++
        const delay = Math.min(initialDelayMs * Math.pow(2, attempt - 1) + Math.random() * 200, maxDelayMs)
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delay)
          options?.signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new ProviderError('aborted', 'Request was cancelled'))
          }, { once: true })
        })
        continue
      }
      throw err
    }
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

export async function* parseNdjsonLines(stream) {
  const reader = stream[Symbol.asyncIterator]()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.next()
    if (done) break
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
        return JSON.parse(candidate)
      } catch {}
    }
    return { _parseError: true, _raw: rawArgs }
  }
}

export async function* parseSseLines(stream) {
  const reader = stream[Symbol.asyncIterator]()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.next()
    if (done) break
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

class AnthropicServerClient {
  constructor({ apiKey, model, baseURL, baseUrl, fetchFn = fetch } = {}) {
    this.apiKey = (apiKey || '').trim()
    this.model = (model || '').trim()
    const url = baseURL || baseUrl || 'https://api.anthropic.com'
    this.baseURL = url.trim().replace(/\/+$/, '')
    this.fetch = fetchFn
  }

  async *streamChat({ system, messages, maxTokens = 8192, tools = [], signal }) {
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

    const isClaude37 =
      this.model.includes('3-7') ||
      this.model.includes('3.7') ||
      this.model.includes('thinking')
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

    const payload = {
      model: this.model,
      system,
      messages: wire,
      max_tokens: effectiveMaxTokens,
      stream: true,
      ...(thinkingPayload ? { thinking: thinkingPayload } : {}),
    }

    if (tools?.length) {
      payload.tools = tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }))
    }

    const res = await fetchWithRetry(`${this.baseURL}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal,
    }, { fetchFn: this.fetch })

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
    for await (const data of parseSseLines(res.body)) {
      if (data === '[DONE]') break
      let parsed
      try {
        parsed = JSON.parse(data)
      } catch {
        continue
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
      } else if (parsed.type === 'message_stop' && activeTool) {
        const args = safeParseToolArgs(activeTool.rawArgs)
        yield {
          type: 'tool_call',
          id: activeTool.id,
          name: activeTool.name,
          args,
        }
        activeTool = null
      }
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
  }
}

export class OpenAiServerClient {
  constructor({ apiKey, model, baseURL, baseUrl, fetchFn = fetch } = {}) {
    this.apiKey = (apiKey || '').trim()
    this.model = (model || '').trim()
    const url = baseURL || baseUrl || 'https://api.openai.com'
    this.baseURL = resolveDockerHostUrl(url.trim().replace(/\/+$/, ''))
    this.fetch = fetchFn
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

  async *streamChat({ system, messages, maxTokens = 8192, tools = [], signal }) {
    const formattedMessages = [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...messages.map(m => {
        if (m.role === 'tool') {
          return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
        }
        if (m.toolCalls?.length) {
          return {
            role: 'assistant',
            content: m.content || null,
            tool_calls: m.toolCalls.map(tc => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.args) },
            })),
          }
        }
        return { role: m.role, content: m.content }
      }),
    ]

    const payload = {
      model: this.model,
      messages: formattedMessages,
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    }

    if (tools?.length) {
      payload.tools = tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }))
    }

    const res = await fetchWithRetry(this._getChatEndpoint(), {
      method: 'POST',
      headers: this._getHeaders(),
      body: JSON.stringify(payload),
      signal,
    }, { fetchFn: this.fetch })

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

    for await (const data of parseSseLines(res.body)) {
      if (data === '[DONE]') break
      let parsed
      try {
        parsed = JSON.parse(data)
      } catch {
        continue
      }

      const delta = parsed.choices?.[0]?.delta

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
  constructor({ apiKey, model, baseURL, baseUrl, fetchFn = fetch } = {}) {
    this.apiKey = (apiKey || '').trim()
    this.model = (model || 'gemini-2.0-flash').trim()
    const defaultUrl = 'https://generativelanguage.googleapis.com/v1beta'
    const url = baseURL || baseUrl || defaultUrl
    this.baseURL = url.trim().replace(/\/+$/, '').replace(/\/openai\/?$/, '')
    this.fetch = fetchFn
  }

  async *streamChat({ system, messages, maxTokens = 8192, tools = [], signal }) {
    const cleanModel = this.model.replace(/^models\//, '')
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
          functionDeclarations: tools.map(t => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters ? JSON.parse(JSON.stringify(t.parameters)) : {},
          })),
        },
      ]
    }

    const headers = {
      'content-type': 'application/json',
      'x-goog-api-key': this.apiKey,
    }

    const res = await fetchWithRetry(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
    }, { fetchFn: this.fetch })

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

    for await (const data of parseSseLines(res.body)) {
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
    }

    for (const item of thinkParser.flush()) {
      yield item
    }
  }
}

export class OllamaServerClient {
  constructor({ apiKey, model, baseURL, baseUrl, fetchFn = fetch } = {}) {
    this.apiKey = (apiKey || '').trim()
    this.model = (model || '').trim()
    const rawUrl = baseURL || baseUrl || 'http://localhost:11434'
    const url = rawUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '').replace(/\/+$/, '')
    this.baseURL = resolveDockerHostUrl(url)
    this.fetch = fetchFn
  }

  async *streamChat({ system, messages, maxTokens = 8192, tools = [], signal }) {
    const wireMessages = toOllamaMessages(system, messages)
    const wireTools = tools?.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }))

    const body = {
      model: this.model,
      messages: wireMessages,
      stream: true,
      think: true,
      options: {
        num_predict: maxTokens,
      },
      ...(wireTools?.length ? { tools: wireTools } : {}),
    }

    const headers = { 'content-type': 'application/json' }
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`

    let res
    try {
      res = await fetchWithRetry(`${this.baseURL}/api/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      }, { fetchFn: this.fetch })
    } catch (err) {
      if (err.name === 'AbortError' || err.code === 'aborted') throw err
      throw new ProviderError(`Could not reach Ollama at ${this.baseURL}: ${err.message}`, {
        code: 'network',
      })
    }

    if (!res.ok) {
      let msg = `Ollama error (${res.status})`
      try {
        const json = await res.json()
        if (json?.error) msg = typeof json.error === 'string' ? json.error : json.error.message || msg
      } catch {}
      throw new ProviderError(msg, { status: res.status, code: 'providerError' })
    }

    const pendingToolCalls = new Map()
    const thinkParser = new StreamingThinkParser()

    for await (const chunk of parseNdjsonLines(res.body)) {
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
