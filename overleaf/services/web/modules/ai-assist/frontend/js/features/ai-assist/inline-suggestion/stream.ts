import { EditorTextClient } from '../providers/server-client'
import {
  AgentMessage,
  ProviderRetry,
  ProviderSettings,
  resolveLimits,
  RetryPolicy,
} from '../providers/types'
import type { StreamingClient } from '../writing-tools/run-writing-tool'

/**
 * One model call through the chat relay, as the ghost-text engine reads it:
 * the whole reply so far after every text chunk. Thinking is ignored; a
 * reply cut at the output limit simply ends, and is shown as far as it got.
 * `onRetry` gets each scheduled retry, and null once output flows again.
 */
export function chatTextStream({
  settings,
  fallbackSettings,
  system,
  messages,
  maxTokens,
  client,
  onRetry,
  retryPolicy = 'inline',
}: {
  settings: ProviderSettings
  fallbackSettings?: ProviderSettings | null
  system: string
  messages: AgentMessage[]
  maxTokens: number
  client?: StreamingClient
  onRetry?: (retry: ProviderRetry | null) => void
  /** Ghost text retries once, quickly, unless a caller shows the wait. */
  retryPolicy?: RetryPolicy
}): (signal: AbortSignal) => AsyncIterable<string> {
  return async function* (signal: AbortSignal) {
    const limits = resolveLimits(settings)
    const chat = client ?? new EditorTextClient(settings, fallbackSettings)
    let text = ''
    let retrying = false
    try {
      for await (const chunk of chat.streamChat({
        system,
        messages,
        maxTokens: Math.min(limits.maxOutputTokens, maxTokens),
        contextWindow: limits.contextWindow,
        cacheHints: { cacheSystem: true, cacheTools: false, lastStableMessage: null },
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
          yield text
        }
      }
    } finally {
      // Ended, failed or aborted while a retry was pending: clear the countdown
      if (retrying) onRetry?.(null)
    }
  }
}
