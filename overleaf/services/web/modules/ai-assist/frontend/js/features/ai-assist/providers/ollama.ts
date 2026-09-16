import { parseNdjsonLines } from './sse'
import {
  AgentMessage,
  ChatChunk,
  ChatRequest,
  parseModelLimits,
  ProviderClient,
  ProviderError,
  ProviderModel,
  ProviderSettings,
  resolveLimits,
  toProviderError,
} from './types'

function toOllamaMessages(system: string, messages: AgentMessage[]) {
  const wire: any[] = []
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
      wire.push({ role: message.role, content: message.content })
    }
  }
  return wire
}

/**
 * Deduplicates and accumulates tool calls across Ollama streaming frames.
 * Ollama can stream tool calls with index/id, sometimes across multiple chunks.
 */
class OllamaToolCallAccumulator {
  private byId = new Map<string, { id: string; name: string; args: any }>()
  private byIndex = new Map<number, { id: string; name: string; args: any }>()

  add(calls: any[]) {
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i]
      const index =
        typeof call.function?.index === 'number' ? call.function.index : i
      const name = call.function?.name || call.name || ''
      const rawArgs = call.function?.arguments ?? call.args ?? {}
      let parsedArgs = rawArgs

      if (typeof rawArgs === 'string') {
        try {
          parsedArgs = JSON.parse(rawArgs)
        } catch {
          parsedArgs = { __parseError: rawArgs }
        }
      }

      const id =
        call.id || (name ? `call_${name}_${index}` : `call_${Date.now()}_${index}`)
      const entry = { id, name, args: parsedArgs }

      if (call.id) {
        this.byId.set(call.id, entry)
      } else {
        this.byIndex.set(index, entry)
      }
    }
  }

  drain(): ChatChunk[] {
    const list =
      this.byId.size > 0 ? [...this.byId.values()] : [...this.byIndex.values()]
    return list.map(entry => ({
      type: 'tool_call',
      id: entry.id,
      name: entry.name,
      args: entry.args,
    }))
  }
}

/**
 * Talks to Ollama's native API (/api/chat and /api/tags) from the browser.
 *
 * Uses the default endpoint http://localhost:11434 (without /v1).
 * Requests go straight to the Ollama service directly from this browser.
 */
export class OllamaClient implements ProviderClient {
  private baseUrl: string
  private apiKey: string
  private model: string
  private contextWindow: number
  private maxOutputTokens: number

  constructor({
    baseUrl,
    apiKey,
    model,
    contextWindow,
    maxOutputTokens,
  }: ProviderSettings) {
    this.baseUrl = (baseUrl || 'http://localhost:11434')
      .trim()
      .replace(/\/+$/, '')
      .replace(/\/v1$/, '')
      .replace(/\/+$/, '')
    this.apiKey = (apiKey || '').trim()
    this.model = (model || '').trim()
    const resolved = resolveLimits({
      type: 'ollama',
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      model: this.model,
      contextWindow,
      maxOutputTokens,
    })
    this.contextWindow = resolved.contextWindow
    this.maxOutputTokens = resolved.maxOutputTokens
  }

  private headers() {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`
    return headers
  }

  async *streamChat({
    system,
    messages,
    maxTokens,
    tools,
    cacheHints: _cacheHints,
    signal,
  }: ChatRequest): AsyncGenerator<ChatChunk> {
    // Ollama has no cache API. It benefits from the stable prefix anyway,
    // through its own KV reuse, so there is nothing to send.

    const toolCalls = new OllamaToolCallAccumulator()
    let finishReason: 'stop' | 'tool_calls' | 'length' | undefined

    const effectiveOutputTokens =
      typeof maxTokens === 'number' && maxTokens > 0
        ? maxTokens
        : this.maxOutputTokens

    const wireTools = tools?.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }))

    const body: Record<string, any> = {
      model: this.model,
      messages: toOllamaMessages(system, messages),
      stream: true,
      think: true,
      keep_alive: '15m',
      max_tokens: effectiveOutputTokens,
      options: {
        temperature: 0.2,
        top_p: 0.9,
        num_predict: effectiveOutputTokens,
        num_ctx: this.contextWindow,
      },
      ...(wireTools?.length ? { tools: wireTools } : {}),
    }

    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: this.headers(),
        signal,
        body: JSON.stringify(body),
      })
    } catch (error: any) {
      if (error?.name === 'AbortError') throw new ProviderError('aborted', 'Cancelled')
      throw new ProviderError('network', `Could not reach ${this.baseUrl}.`)
    }

    if (!response.ok || !response.body) throw await toProviderError(response)

    for await (const line of parseNdjsonLines(response.body)) {
      let payload: any
      try {
        payload = JSON.parse(line)
      } catch {
        continue
      }

      if (payload.error) {
        throw new ProviderError(
          'providerError',
          typeof payload.error === 'string'
            ? payload.error
            : payload.error.message || 'Ollama returned an error.'
        )
      }

      const msg = payload.message
      if (msg?.thinking) {
        yield { type: 'thinking', text: msg.thinking }
      } else if (msg?.reasoning) {
        yield { type: 'thinking', text: msg.reasoning }
      }

      if (msg?.content) {
        yield { type: 'text', text: msg.content }
      }

      if (Array.isArray(msg?.tool_calls)) {
        toolCalls.add(msg.tool_calls)
        finishReason = 'tool_calls'
      }

      if (payload.done) {
        if (!finishReason) {
          finishReason =
            payload.done_reason === 'length'
              ? 'length'
              : payload.done_reason === 'stop'
              ? 'stop'
              : 'stop'
        }
        break
      }
    }

    yield* toolCalls.drain()
    yield { type: 'done', stopReason: finishReason }
  }

  async listModels({ signal }: { signal?: AbortSignal } = {}) {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        headers: this.headers(),
        signal,
      })
    } catch {
      throw new ProviderError('network', `Could not reach ${this.baseUrl}.`)
    }

    if (!response.ok) throw await toProviderError(response)

    const payload = await response.json().catch(() => null)
    const rawList = Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload?.data)
      ? payload.data
      : []

    const models: ProviderModel[] = rawList
      .map((entry: any) => {
        const id = entry.name || entry.model || entry.id
        const label =
          entry.name ||
          entry.display_name ||
          entry.title ||
          entry.model ||
          entry.id
        return { id, label, ...parseModelLimits(entry) }
      })
      .filter((entry: ProviderModel) => typeof entry.id === 'string' && entry.id)

    return models.sort((a, b) => a.label.localeCompare(b.label))
  }
}
