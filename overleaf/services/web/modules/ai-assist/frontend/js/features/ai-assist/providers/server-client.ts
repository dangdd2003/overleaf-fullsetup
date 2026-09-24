import getMeta from '@/utils/meta'
import {
  ChatChunk,
  ChatRequest,
  ProviderClient,
  ProviderError,
  ProviderErrorCode,
  ProviderModel,
  ProviderSettings,
  WebSearchSettings,
} from './types'

type ErrorBody = { code?: string; message?: string; hint?: string }

function csrfHeaders(): Record<string, string> {
  const token =
    (typeof window !== 'undefined' && (window as any).csrfToken) ||
    getMeta('ol-csrfToken') ||
    ''
  return token ? { 'X-Csrf-Token': token } : {}
}

function toError(body: ErrorBody | undefined, status?: number): ProviderError {
  return new ProviderError(
    (body?.code as ProviderErrorCode) || 'providerError',
    body?.message || 'The provider request failed.',
    status,
    body?.hint ? { hint: body.hint } : undefined
  )
}

async function post(
  path: string,
  body: unknown,
  signal?: AbortSignal
): Promise<Response> {
  let response: Response
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error: any) {
    if (signal?.aborted || error?.name === 'AbortError') {
      throw new ProviderError('aborted', 'The request was cancelled.')
    }
    throw new ProviderError('network', 'Could not reach the Overleaf server.')
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    throw toError(
      payload?.error ?? { message: `Request failed (${response.status})` },
      response.status
    )
  }
  return response
}

/** Runs one small search through the server, for the settings form. */
export async function testWebSearch(
  webSearchSettings: WebSearchSettings
): Promise<{ latencyMs: number; resultCount: number }> {
  const response = await post('/ai-assist/web-search/test', {
    webSearchSettings,
  })
  return await response.json()
}

/**
 * A browser hands back a WHATWG ReadableStream; node-fetch, which the frontend
 * test runner installs as global fetch, hands back an async-iterable stream or
 * an already-buffered body.
 */
async function* bodyChunks(
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | Uint8Array
): AsyncGenerator<Uint8Array> {
  // Checked first: iterating a Uint8Array yields single byte numbers.
  if (body instanceof Uint8Array) {
    yield body
    return
  }
  const readable = body as ReadableStream<Uint8Array>
  if (typeof readable.getReader !== 'function') {
    yield* body as AsyncIterable<Uint8Array>
    return
  }
  const reader = readable.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      if (value) yield value
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}

/**
 * Talks to the provider through the Overleaf server. The page never contacts
 * the provider itself: a site served from a public domain cannot reach
 * providers on a private network, and the server can.
 */
export class ServerProviderClient implements ProviderClient {
  private settings: ProviderSettings

  constructor(settings: ProviderSettings) {
    this.settings = settings
  }

  async listModels({ signal }: { signal?: AbortSignal } = {}): Promise<
    ProviderModel[]
  > {
    const response = await post(
      '/ai-assist/providers/models',
      { providerSettings: this.settings },
      signal
    )
    const payload = await response.json()
    return Array.isArray(payload?.models) ? payload.models : []
  }

  async test(): Promise<{ latencyMs: number }> {
    const response = await post('/ai-assist/providers/test', {
      providerSettings: this.settings,
    })
    return await response.json()
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<ChatChunk> {
    const { signal, ...rest } = request
    const response = await post(
      '/ai-assist/providers/chat',
      { providerSettings: this.settings, request: rest },
      signal
    )
    if (!response.body) {
      throw new ProviderError('providerError', 'The server sent no response.')
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let finished = false

    const parse = function* (line: string): Generator<ChatChunk> {
      if (!line.trim()) return
      const chunk = JSON.parse(line)
      if (chunk.type === 'error') throw toError(chunk.error)
      if (chunk.type === 'done') finished = true
      yield chunk as ChatChunk
    }

    const chunks = bodyChunks(response.body as any)
    try {
      while (true) {
        let result: IteratorResult<Uint8Array>
        try {
          result = await chunks.next()
        } catch {
          if (signal?.aborted) {
            throw new ProviderError('aborted', 'The request was cancelled.')
          }
          throw new ProviderError(
            'network',
            'The connection to the Overleaf server was interrupted.'
          )
        }
        if (result.done) break
        buffer += decoder.decode(result.value, { stream: true })
        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          yield* parse(line)
          newline = buffer.indexOf('\n')
        }
      }
      yield* parse(buffer + decoder.decode())
    } finally {
      // Releases the connection when the caller stops reading early.
      await chunks.return(undefined)
    }

    if (!finished) {
      if (signal?.aborted) {
        throw new ProviderError('aborted', 'The request was cancelled.')
      }
      throw new ProviderError(
        'network',
        'The provider stream ended unexpectedly.'
      )
    }
  }
}
