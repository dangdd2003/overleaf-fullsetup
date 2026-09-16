import { parseSseFrames } from './sse'
import {
  AgentMessage,
  ChatChunk,
  ChatRequest,
  parseModelLimits,
  ProviderClient,
  ProviderError,
  ProviderModel,
  ProviderSettings,
  toProviderError,
} from './types'

/** Maps the shared message shape onto OpenAI's wire format: tool results
 * become `role: 'tool'` messages, and assistant tool calls become the
 * `tool_calls` array the API expects instead of prose. */
function toWireMessages(system: string, messages: AgentMessage[]) {
  return [
    { role: 'system', content: system },
    ...messages.map((message, messageIndex) => {
      if (message.role === 'tool') {
        const safeContent =
          typeof message.content === 'string' && message.content.trim().length > 0
            ? message.content
            : '(empty)'
        return {
          role: 'tool',
          tool_call_id: message.toolCallId || `call_${messageIndex}`,
          content: safeContent,
        }
      }
      if (message.role === 'assistant' && message.toolCalls?.length) {
        return {
          role: 'assistant',
          content: message.content ?? '',
          tool_calls: message.toolCalls.map((call, callIndex) => ({
            id: call.id || `call_${messageIndex}_${callIndex}`,
            type: 'function',
            function: {
              name: call.name,
              arguments:
                typeof call.args === 'string'
                  ? call.args
                  : JSON.stringify(call.args ?? {}),
            },
          })),
        }
      }
      return { role: message.role, content: message.content }
    }),
  ]
}

/** Arguments arrive as fragments keyed by index; assemble then parse once. */
class ToolCallAccumulator {
  private byIndex = new Map<number, { id: string; name: string; args: string }>()

  add(deltas: any[]) {
    for (let i = 0; i < deltas.length; i++) {
      const delta = deltas[i]
      const index = typeof delta.index === 'number' ? delta.index : i
      const entry = this.byIndex.get(index) ?? {
        id: '',
        name: '',
        args: '',
      }
      if (delta.id) entry.id = delta.id
      if (delta.function?.name) entry.name = delta.function.name
      if (delta.function?.arguments) entry.args += delta.function.arguments
      this.byIndex.set(index, entry)
    }
  }

  drain(): ChatChunk[] {
    return [...this.byIndex.values()].map((entry, idx) => {
      let args: unknown
      try {
        args = JSON.parse(entry.args || '{}')
      } catch {
        // The model produced invalid JSON. The loop turns this into a tool
        // error the model can read, which beats throwing mid-stream.
        args = { __parseError: entry.args }
      }
      const id = entry.id || `call_${Date.now()}_${idx}`
      return { type: 'tool_call', id, name: entry.name, args }
    })
  }
}

/**
 * Talks to the OpenAI chat-completions wire format from the browser.
 *
 * Serves `openai`, `openai-compatible` and `ollama` — Ollama exposes an
 * OpenAI-compatible /v1 surface. Requests go straight to the provider; Overleaf
 * is not in the path, so nothing here is sent to the Overleaf server.
 */
export class OpenAiClient implements ProviderClient {
  private baseUrl: string
  private apiKey: string
  private model: string

  constructor({ baseUrl, apiKey, model }: ProviderSettings) {
    this.baseUrl = (baseUrl || '').trim().replace(/\/+$/, '')
    this.apiKey = (apiKey || '').trim()
    this.model = (model || '').trim()
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
    cacheHints,
    signal,
  }: ChatRequest): AsyncGenerator<ChatChunk> {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        signal,
        body: JSON.stringify({
          model: this.model,
          stream: true,
          max_tokens: maxTokens,
          messages: toWireMessages(system, messages),
          ...(cacheHints?.cacheKey
            ? { prompt_cache_key: cacheHints.cacheKey }
            : {}),
          ...(tools?.length
            ? {
                tools: tools.map(tool => ({ type: 'function', function: tool })),
                tool_choice: 'auto',
              }
            : {}),
        }),
      })
    } catch (error: any) {
      if (error?.name === 'AbortError') throw new ProviderError('aborted', 'Cancelled')
      throw new ProviderError('network', `Could not reach ${this.baseUrl}.`)
    }

    if (!response.ok || !response.body) throw await toProviderError(response)

    const toolCalls = new ToolCallAccumulator()
    let finishReason: string | undefined

    for await (const frame of parseSseFrames(response.body)) {
      if (frame.data === '[DONE]') break

      let payload
      try {
        payload = JSON.parse(frame.data)
      } catch {
        continue // a truncated frame must not kill the stream
      }

      if (payload.error) {
        const msg = payload.error.message || 'Stream error from provider'
        throw new ProviderError(
          'providerError',
          msg,
          undefined,
          {
            upstreamMessage: msg,
            upstreamCode: payload.error.code,
            upstreamType: payload.error.type,
            hint: 'The AI provider ended the stream with an error. Check their status or retry.',
          }
        )
      }

      const delta = payload.choices?.[0]?.delta
      const reasoning = delta?.reasoning_content || delta?.reasoning
      if (reasoning) yield { type: 'thinking', text: reasoning }

      const text = delta?.content
      if (text) yield { type: 'text', text }

      if (delta?.tool_calls) toolCalls.add(delta.tool_calls)

      if (payload.choices?.[0]?.finish_reason) {
        finishReason = payload.choices[0].finish_reason
      }
    }

    yield* toolCalls.drain()

    // finishReason is absent only when the stream never sent finish_reason at
    // all (real providers always do); omit stopReason rather than guess 'stop'.
    if (finishReason) {
      yield {
        type: 'done',
        stopReason:
          finishReason === 'tool_calls'
            ? 'tool_calls'
            : finishReason === 'length'
              ? 'length'
              : 'stop',
      }
    } else {
      yield { type: 'done' }
    }
  }

  async listModels({ signal }: { signal?: AbortSignal } = {}) {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: this.headers(),
        signal,
      })
    } catch {
      throw new ProviderError('network', `Could not reach ${this.baseUrl}.`)
    }

    if (!response.ok) throw await toProviderError(response)

    const payload = await response.json().catch(() => null)
    const models: ProviderModel[] = (
      Array.isArray(payload?.data) ? payload.data : []
    )
      .filter((entry: any) => entry && typeof entry.id === 'string')
      .map((entry: any) => ({
        id: entry.id,
        label:
          entry.name ||
          entry.display_name ||
          entry.title ||
          entry.description ||
          entry.id,
        ...parseModelLimits(entry),
      }))

    // OpenAI's order shifts between calls; a dropdown that reshuffles itself is
    // worse than an alphabetical one.
    return models.sort((a, b) => a.id.localeCompare(b.id))
  }
}
