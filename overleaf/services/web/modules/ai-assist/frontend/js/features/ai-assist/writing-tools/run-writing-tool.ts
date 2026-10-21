import { EditorTextClient, EditorTextRequest } from '../providers/server-client'
import {
  AgentMessage,
  ChatChunk,
  ProviderError,
  ProviderRetry,
  ProviderSettings,
  resolveLimits,
  RetryPolicy,
} from '../providers/types'

/** Text only: the AI inside the editor gets no tools (EditorTextClient). */
export type StreamingClient = {
  streamChat(request: EditorTextRequest): AsyncGenerator<ChatChunk>
}

/** Room for the rewrite: a translation can be longer than its source. */
export function maxTokensFor(selection: string): number {
  return Math.max(1024, selection.length + 512)
}

/**
 * One model call, streamed. `onText` receives the whole reply so far after
 * every chunk; thinking chunks are ignored. Resolves with the full reply.
 * `onRetry` gets each scheduled retry, and null once output flows again.
 */
export async function runWritingTool({
  settings,
  system,
  messages,
  maxTokens,
  signal,
  onText,
  onRetry,
  client,
  cacheKey,
  retryPolicy = 'background',
}: {
  settings: ProviderSettings
  system: string
  messages: AgentMessage[]
  maxTokens: number
  signal?: AbortSignal
  onText: (text: string) => void
  onRetry?: (retry: ProviderRetry | null) => void
  client?: StreamingClient
  /** Routes requests with the same instructions to one prompt cache (OpenAI). */
  cacheKey?: string
  /** How the server retries the request; see RetryPolicy. */
  retryPolicy?: RetryPolicy
}): Promise<string> {
  const limits = resolveLimits(settings)
  const chat = client ?? new EditorTextClient(settings)
  let text = ''
  let retrying = false
  try {
    for await (const chunk of chat.streamChat({
      system,
      messages,
      maxTokens: Math.min(limits.maxOutputTokens, maxTokens),
      contextWindow: limits.contextWindow,
      cacheHints: {
        cacheSystem: true,
        cacheTools: false,
        lastStableMessage: null,
        ...(cacheKey ? { cacheKey } : {}),
      },
      signal,
      retryPolicy,
    })) {
      if (chunk.type === 'retrying') {
        const { type: _type, ...retry } = chunk
        retrying = true
        onRetry?.(retry)
      } else if (chunk.type === 'text') {
        if (retrying) {
          retrying = false
          onRetry?.(null)
        }
        text += chunk.text
        onText(text)
      } else if (chunk.type === 'stop') {
        throw new ProviderError(
          'outputTruncated',
          'The reply was cut off before it finished.'
        )
      }
    }
  } finally {
    // Failed or aborted while a retry was pending: clear the countdown
    if (retrying) onRetry?.(null)
  }
  return text
}
