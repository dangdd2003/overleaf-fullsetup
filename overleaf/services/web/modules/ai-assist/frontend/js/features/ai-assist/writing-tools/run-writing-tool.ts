import { EditorTextClient, EditorTextRequest } from '../providers/server-client'
import {
  AgentMessage,
  ChatChunk,
  ProviderError,
  ProviderSettings,
  resolveLimits,
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
 */
export async function runWritingTool({
  settings,
  system,
  messages,
  maxTokens,
  signal,
  onText,
  client,
  cacheKey,
}: {
  settings: ProviderSettings
  system: string
  messages: AgentMessage[]
  maxTokens: number
  signal?: AbortSignal
  onText: (text: string) => void
  client?: StreamingClient
  /** Routes requests with the same instructions to one prompt cache (OpenAI). */
  cacheKey?: string
}): Promise<string> {
  const limits = resolveLimits(settings)
  const chat = client ?? new EditorTextClient(settings)
  let text = ''
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
  })) {
    if (chunk.type === 'text') {
      text += chunk.text
      onText(text)
    } else if (chunk.type === 'stop') {
      throw new ProviderError(
        'outputTruncated',
        'The reply was cut off before it finished.'
      )
    }
  }
  return text
}
