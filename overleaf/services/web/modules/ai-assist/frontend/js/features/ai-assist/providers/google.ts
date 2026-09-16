import { parseSseFrames } from './sse'
import {
  AgentMessage,
  ChatChunk,
  ChatRequest,
  ProviderClient,
  ProviderError,
  ProviderModel,
  ProviderSettings,
  resolveLimits,
  toProviderError,
} from './types'

export function toGeminiContents(messages: AgentMessage[]) {
  const contents: any[] = []

  for (const message of messages) {
    if (message.role === 'tool') {
      let responseObj: any = {}
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
      const parts: any[] = []
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
 * Talks directly to Google's official native Gemini REST API (v1beta) using
 * `streamGenerateContent?alt=sse` and `GET /models`.
 */
export class GoogleClient implements ProviderClient {
  private baseUrl: string
  private apiKey: string
  private model: string
  private maxOutputTokens: number

  constructor({ baseUrl, apiKey, model, contextWindow, maxOutputTokens }: ProviderSettings) {
    const rawUrl = baseUrl || 'https://generativelanguage.googleapis.com/v1beta'
    this.baseUrl = rawUrl.trim().replace(/\/+$/, '').replace(/\/openai\/?$/, '')
    this.apiKey = (apiKey || '').trim()
    this.model = (model || 'gemini-2.0-flash').trim()
    const resolved = resolveLimits({
      type: 'google',
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      model: this.model,
      contextWindow,
      maxOutputTokens,
    })
    this.maxOutputTokens = resolved.maxOutputTokens
  }

  private headers() {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (this.apiKey) {
      headers['x-goog-api-key'] = this.apiKey
    }
    return headers
  }

  async *streamChat({
    system,
    messages,
    maxTokens,
    tools,
    signal,
  }: ChatRequest): AsyncGenerator<ChatChunk> {
    const effectiveMaxTokens =
      typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : this.maxOutputTokens

    const cleanModel = this.model.replace(/^models\//, '')
    const url = `${this.baseUrl}/models/${cleanModel}:streamGenerateContent?alt=sse`

    const isThinkingModel =
      cleanModel.includes('thinking') ||
      cleanModel.includes('2.5') ||
      cleanModel.includes('pro')

    const body: Record<string, any> = {
      contents: toGeminiContents(messages),
      generationConfig: {
        maxOutputTokens: effectiveMaxTokens,
        temperature: 0.2,
        ...(isThinkingModel ? { thinkingConfig: { includeThoughts: true } } : {}),
      },
    }

    if (system) {
      body.systemInstruction = {
        parts: [{ text: system }],
      }
    }

    if (tools?.length) {
      body.tools = [
        {
          functionDeclarations: tools.map(t => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters ? JSON.parse(JSON.stringify(t.parameters)) : {},
          })),
        },
      ]
    }

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: this.headers(),
        signal,
        body: JSON.stringify(body),
      })
    } catch (error: any) {
      if (error?.name === 'AbortError') throw new ProviderError('aborted', 'Cancelled')
      throw new ProviderError('network', `Could not reach Google Gemini at ${this.baseUrl}.`)
    }

    if (!response.ok || !response.body) throw await toProviderError(response)

    let toolCallIndex = 0
    let finishReason: 'stop' | 'tool_calls' | 'length' | undefined

    for await (const frame of parseSseFrames(response.body)) {
      let payload: any
      try {
        payload = JSON.parse(frame.data)
      } catch {
        continue
      }

      if (payload.error) {
        throw new ProviderError(
          'providerError',
          typeof payload.error === 'string' ? payload.error : payload.error.message || 'Google Gemini error'
        )
      }

      const candidate = payload.candidates?.[0]
      if (candidate?.finishReason) {
        if (candidate.finishReason === 'MAX_TOKENS') finishReason = 'length'
        else if (candidate.finishReason === 'STOP') finishReason = 'stop'
      }

      const parts = candidate?.content?.parts
      if (!Array.isArray(parts)) continue

      for (const part of parts) {
        if (part.thought) {
          yield { type: 'thinking', text: part.text || '' }
          continue
        }

        if (part.text) {
          yield { type: 'text', text: part.text }
        }

        if (part.functionCall) {
          finishReason = 'tool_calls'
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

    yield { type: 'done', stopReason: finishReason }
  }

  async listModels({ signal }: { signal?: AbortSignal } = {}): Promise<ProviderModel[]> {
    const url = `${this.baseUrl}/models`
    let response: Response
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: this.headers(),
        signal,
      })
    } catch {
      throw new ProviderError('network', `Could not reach ${this.baseUrl}.`)
    }

    if (!response.ok) throw await toProviderError(response)

    const payload = await response.json().catch(() => null)
    const rawList: any[] = Array.isArray(payload?.models) ? payload.models : []

    const models: ProviderModel[] = rawList
      .filter(m => m && Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
      .map(m => {
        const id = (m.name || '').replace(/^models\//, '')
        return {
          id,
          label: m.displayName || id,
          contextWindow: m.inputTokenLimit || 1048576,
          maxOutputTokens: m.outputTokenLimit || 8192,
        }
      })

    return models.sort((a, b) => a.id.localeCompare(b.id))
  }
}
