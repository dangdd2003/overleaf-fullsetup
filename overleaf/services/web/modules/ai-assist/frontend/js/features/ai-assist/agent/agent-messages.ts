import { AgentMessage } from '../providers/types'
import { Attachment, EnvelopeState } from './context/types'

export type ToolCallRecord = {
  id: string
  name: string
  args: unknown
  result?: unknown
  isError?: boolean
}

export type AssistantBlock =
  | {
      type: 'thinking'
      thinking: string
      startedAt?: number
      elapsedMs?: number
    }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; call: ToolCallRecord }

export type TranscriptEntry =
  | {
      id: string
      role: 'user'
      text: string
      /** The <project-context> block, rendered at send time and then frozen. */
      contextText?: string
      /** Carried forward so the next turn can delta-encode against it. */
      envelopeState?: EnvelopeState
      /** What the user pinned to this turn; the panel renders chips from it. */
      attachments?: Attachment[]
    }
  | {
      id: string
      role: 'assistant'
      text: string
      thinking?: string
      thinkingElapsedMs?: number
      toolCalls: ToolCallRecord[]
      blocks?: AssistantBlock[]
      durationMs?: number
      statusWord?: string
    }

/**
 * The ordered blocks of an assistant turn.
 *
 * Older transcripts — persisted before `blocks` existed — carry loose
 * `thinking`/`toolCalls`/`text` fields instead. Reassembling them here in that
 * order keeps every reader working from one chronological sequence rather than
 * each re-deriving its own.
 */
export function blocksForEntry(
  entry: Extract<TranscriptEntry, { role: 'assistant' }>
): AssistantBlock[] {
  if (entry.blocks && entry.blocks.length > 0) return entry.blocks
  return [
    ...(entry.thinking
      ? [
          {
            type: 'thinking' as const,
            thinking: entry.thinking,
            elapsedMs: entry.thinkingElapsedMs,
          },
        ]
      : []),
    ...entry.toolCalls.map(call => ({ type: 'tool_call' as const, call })),
    ...(entry.text ? [{ type: 'text' as const, text: entry.text }] : []),
  ]
}

/**
 * Rebuilds the provider-facing message array from the stored transcript.
 *
 * The transcript is what gets persisted and rendered; this is the only place
 * that knows how it maps onto a conversation, which is why switching provider
 * mid-project is safe.
 */
export function toAgentMessages(transcript: TranscriptEntry[]): AgentMessage[] {
  const messages: AgentMessage[] = []

  transcript.forEach((entry, index) => {
    if (entry.role === 'user') {
      const content = entry.contextText
        ? `${entry.contextText}\n\n${entry.text}`
        : entry.text
      messages.push({ role: 'user', content })
      return
    }

    const isLast = index === transcript.length - 1
    if (isLast && !entry.text && entry.toolCalls.length === 0) return

    if (entry.toolCalls.length === 0) {
      messages.push({ role: 'assistant', content: entry.text })
      return
    }

    messages.push({
      role: 'assistant',
      content: entry.text,
      toolCalls: entry.toolCalls.map(call => ({
        id: call.id,
        name: call.name,
        args: call.args,
      })),
    })

    for (const call of entry.toolCalls) {
      const finished = 'result' in call
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: finished
          ? JSON.stringify(call.result)
          : 'This tool call did not complete.',
        isError: finished ? Boolean(call.isError) : true,
      })
    }
  })

  return messages
}
