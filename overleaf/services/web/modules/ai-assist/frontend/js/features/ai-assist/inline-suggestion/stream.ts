import { EditorTextClient } from '../providers/server-client'
import { AgentMessage, ProviderSettings, resolveLimits } from '../providers/types'
import type { StreamingClient } from '../writing-tools/run-writing-tool'

/**
 * One model call through the chat relay, as the ghost-text engine reads it:
 * the whole reply so far after every text chunk. Thinking is ignored; a
 * reply cut at the output limit simply ends, and is shown as far as it got.
 */
export function chatTextStream({
  settings,
  fallbackSettings,
  system,
  messages,
  maxTokens,
  client,
}: {
  settings: ProviderSettings
  fallbackSettings?: ProviderSettings | null
  system: string
  messages: AgentMessage[]
  maxTokens: number
  client?: StreamingClient
}): (signal: AbortSignal) => AsyncIterable<string> {
  return async function* (signal: AbortSignal) {
    const limits = resolveLimits(settings)
    const chat = client ?? new EditorTextClient(settings, fallbackSettings)
    let text = ''
    for await (const chunk of chat.streamChat({
      system,
      messages,
      maxTokens: Math.min(limits.maxOutputTokens, maxTokens),
      contextWindow: limits.contextWindow,
      cacheHints: { cacheSystem: true, cacheTools: false, lastStableMessage: null },
      signal,
    })) {
      if (chunk.type === 'text') {
        text += chunk.text
        yield text
      }
    }
  }
}
