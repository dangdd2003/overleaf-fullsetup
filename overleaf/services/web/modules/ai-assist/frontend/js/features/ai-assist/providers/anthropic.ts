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

const ANTHROPIC_VERSION = '2023-06-01'

// The models endpoint pages at 1000 entries. Five pages is far more than any
// real deployment serves, and it bounds a compatible endpoint that always
// answers has_more.
const MAX_MODEL_PAGES = 5

function toWireMessages(messages: AgentMessage[]) {
  const wire: any[] = []

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
      const content: any[] = []
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
      content: [{ type: 'text', text: message.content || ' ' }],
    })
  }

  return wire
}

class ToolBlockAccumulator {
  private byIndex = new Map<number, { id: string; name: string; json: string }>()

  start(index: number, contentBlock: { id?: string; name?: string }) {
    const entry = this.byIndex.get(index) ?? { id: '', name: '', json: '' }
    if (contentBlock.id) entry.id = contentBlock.id
    if (contentBlock.name) entry.name = contentBlock.name
    this.byIndex.set(index, entry)
  }

  addDelta(index: number, partialJson: string) {
    const entry = this.byIndex.get(index) ?? { id: '', name: '', json: '' }
    entry.json += partialJson
    this.byIndex.set(index, entry)
  }

  drain(): ChatChunk[] {
    return [...this.byIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([_, entry]) => {
        let args: unknown
        try {
          args = JSON.parse(entry.json || '{}')
        } catch {
          args = { __parseError: entry.json }
        }
        return { type: 'tool_call', id: entry.id, name: entry.name, args }
      })
  }
}

/**
 * Talks to the Anthropic messages wire format from the browser.
 *
 * Anthropic blocks browser requests unless they carry
 * `anthropic-dangerous-direct-browser-access`. The header is deliberate: this
 * build keeps the user's key in their own browser, which is exactly the setup
 * that header exists to acknowledge.
 */
export class AnthropicClient implements ProviderClient {
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
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    }
    if (this.apiKey) headers['x-api-key'] = this.apiKey
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
    const ephemeral = { type: 'ephemeral' as const }

    const systemField = cacheHints?.cacheSystem
      ? [{ type: 'text', text: system, cache_control: ephemeral }]
      : system

    const wireTools = tools?.map((tool, index) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
      // Only the last spec is marked: the tool array is cached as one prefix,
      // and breakpoints are capped at four per request.
      ...(cacheHints?.cacheTools && index === tools.length - 1
        ? { cache_control: ephemeral }
        : {}),
    }))

    const wireMessages = toWireMessages(messages)
    const stable = cacheHints?.lastStableMessage
    if (
      typeof stable === 'number' &&
      stable >= 0 &&
      stable < wireMessages.length
    ) {
      const blocks = wireMessages[stable].content
      if (Array.isArray(blocks) && blocks.length > 0) {
        blocks[blocks.length - 1] = {
          ...blocks[blocks.length - 1],
          cache_control: ephemeral,
        }
      }
    }

    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: this.headers(),
        signal,
        body: JSON.stringify({
          model: this.model,
          stream: true,
          max_tokens: maxTokens,
          system: systemField,
          messages: wireMessages,
          ...(wireTools?.length ? { tools: wireTools } : {}),
        }),
      })
    } catch (error: any) {
      if (error?.name === 'AbortError') throw new ProviderError('aborted', 'Cancelled')
      throw new ProviderError('network', `Could not reach ${this.baseUrl}.`)
    }

    if (!response.ok || !response.body) throw await toProviderError(response)

    const toolBlocks = new ToolBlockAccumulator()
    let stopReason: string | undefined

    for await (const frame of parseSseFrames(response.body)) {
      let payload
      try {
        payload = JSON.parse(frame.data)
      } catch {
        continue
      }

      const eventType = frame.event || payload?.type

      if (eventType === 'error') {
        const msg = payload?.error?.message ?? 'The provider ended the stream with an error.'
        throw new ProviderError(
          'providerError',
          msg,
          undefined,
          {
            upstreamMessage: msg,
            upstreamType: payload?.error?.type,
            hint: 'The provider ended the stream with an error. Check your model parameters or provider status.',
          }
        )
      }

      if (
        eventType === 'content_block_start' &&
        payload.content_block?.type === 'tool_use'
      ) {
        toolBlocks.start(payload.index ?? 0, payload.content_block)
      }

      if (
        eventType === 'content_block_delta' &&
        payload.delta?.type === 'text_delta'
      ) {
        yield { type: 'text', text: payload.delta.text }
      }

      if (
        eventType === 'content_block_delta' &&
        payload.delta?.type === 'thinking_delta' &&
        payload.delta?.thinking
      ) {
        yield { type: 'thinking', text: payload.delta.thinking }
      }

      if (
        eventType === 'content_block_delta' &&
        payload.delta?.type === 'input_json_delta'
      ) {
        toolBlocks.addDelta(payload.index ?? 0, payload.delta.partial_json ?? '')
      }

      if (eventType === 'message_delta' && payload.delta?.stop_reason) {
        stopReason = payload.delta.stop_reason
      }

      if (eventType === 'message_stop') break
    }

    yield* toolBlocks.drain()

    if (stopReason) {
      yield {
        type: 'done',
        stopReason:
          stopReason === 'tool_use'
            ? 'tool_calls'
            : stopReason === 'max_tokens'
              ? 'length'
              : 'stop',
      }
    } else {
      yield { type: 'done' }
    }
  }

  async listModels({ signal }: { signal?: AbortSignal } = {}) {
    const models: ProviderModel[] = []
    let cursor: string | null = null

    for (let page = 0; page < MAX_MODEL_PAGES; page++) {
      const url = new URL(`${this.baseUrl}/v1/models`)
      url.searchParams.set('limit', '1000')
      if (cursor) url.searchParams.set('after_id', cursor)

      let response: Response
      try {
        response = await fetch(url.toString(), {
          method: 'GET',
          headers: this.headers(),
          signal,
        })
      } catch {
        throw new ProviderError('network', `Could not reach ${this.baseUrl}.`)
      }

      if (!response.ok) throw await toProviderError(response)

      const payload = await response.json().catch(() => null)
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

      // Without a cursor there is no way to ask for the next page, whatever
      // has_more claims. Anthropic returns newest first, so that order is kept.
      if (!payload?.has_more || !payload?.last_id) break
      cursor = payload.last_id
    }

    return models
  }
}
