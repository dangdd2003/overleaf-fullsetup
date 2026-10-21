import { AgentMessage, ChatImage } from '../providers/types'
import { Attachment, EnvelopeState } from './context/types'
import {
  ContextBreakdown,
  ContextUsageRecord,
  ProviderUsage,
} from './context/context-usage-types'
import { SlashCommandInvocation } from './slash-commands/types'
import { renderCompactionMessage } from './context/compaction'

export type ToolCallRecord = {
  id: string
  name: string
  args: unknown
  result?: unknown
  isError?: boolean
  /**
   * Which provider request of a server run made the call. A run sends one
   * assistant message per request; this lets the next run rebuild those
   * messages as they were sent and read them from the provider's cache.
   */
  step?: number
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

/**
 * How a server run had cut the conversation to fit the context window, in
 * positions on the whole conversation. Kept so the next run cuts it the same
 * way and the messages the provider has cached stay as they were sent.
 */
export type ContextTrim = {
  total: number
  anchor: string
  dropped: number
  elided: number[]
}

/**
 * What a compaction kept, read by code from the span it summarized (never
 * written by the model). Rendered under the summary; see context/compaction.ts.
 */
export type CompactLedger = {
  userMessages: { id: string; text: string }[]
  filesRead: { path: string; ranges: string[] }[]
  edits: {
    path: string
    startLine?: number
    endLine?: number
    oldText?: string
    newText?: string
    status: 'applied' | 'rejected' | 'failed'
    turn?: string
  }[]
  filesCreated: string[]
  compile: {
    last?: {
      status: string
      errorCount: number
      warningCount: number
      firstError?: { file?: string; line?: number; message: string }
    }
    unresolved: { file?: string; line?: number; message: string }[]
    resolved: string[]
  }
  latex: {
    documentClass?: string
    packages: string[]
    macros: string[]
    labels: string[]
    citeKeys: string[]
    unresolvedRefs: string[]
    /** Server bookkeeping: whether unresolvedRefs came from a full check. */
    refsChecked?: boolean
  }
  settings: { key: string; value: string }[]
  pdf: { pages: number[]; notes: string[] }
  web: { url: string; title?: string }[]
  connectors: { tool: string; count: number }[]
  slashCommands: string[]
  rejected: string[]
}

/**
 * A `/compact` boundary. The messages before the newest one are not sent
 * again: the rebuilt conversation is this entry's compaction message, then
 * the tail kept verbatim, then everything after the entry.
 */
export type CompactEntry = {
  id: string
  role: 'compact'
  createdAt: number
  trigger: 'manual' | 'auto'
  /** The words after `/compact`, if any. */
  instructions?: string
  /** The summary, as markdown with `###` section headings. */
  summary: string
  ledger: CompactLedger
  /** First entry kept verbatim (an entry before this one); absent: no tail. */
  tailFromId?: string
  preTokens: number
  postTokens: number
  summarizedEntries: number
  model?: string
  durationMs: number
  retention: {
    score: number
    checked: number
    missing: string[]
    repaired: boolean
  }
  /** The model failed and the summary is the deterministic one. */
  fallback?: boolean
  /** More than one chunk was summarized (map-reduce). */
  chunks?: number
  /** Current text around the newest edits, appended to the message. */
  excerpts?: string
}

export type TranscriptEntry =
  | {
      id: string
      role: 'user'
      text: string
      /** Timestamp when the entry was created. */
      createdAt?: number
      /** The <project-context> block, rendered at send time and then frozen. */
      contextText?: string
      /** Carried forward so the next turn can delta-encode against it. */
      envelopeState?: EnvelopeState
      /** What the user pinned to this turn; the panel renders chips from it. */
      attachments?: Attachment[]
      /**
       * The slash command the turn was sent with: the chip, and the server's
       * scope lookup. `text` is then only the words typed after the name.
       */
      command?: SlashCommandInvocation
      /**
       * The frozen `<command>` block, rendered at send time from the command's
       * harness and the context it gathered. Never re-rendered, for the same
       * reason as contextText: the cached prefix has to stay byte-identical.
       */
      commandText?: string
      /** Attached images (e.g. pasted or uploaded photos). */
      images?: ChatImage[]
      /**
       * Sent while a run was already going and not yet read by it. Cleared by
       * the run's `userMessage` event; still set when the run ends means the
       * message never landed and has to be resent as a new run.
       */
      pending?: boolean
      /**
       * Read by a run that was already going. The server sends such a turn
       * with a note saying so, and rebuilds it with the same note.
       */
      sentDuringRun?: boolean
    }
  | {
      id: string
      role: 'assistant'
      text: string
      /** Timestamp when the entry was created. */
      createdAt?: number
      thinking?: string
      thinkingElapsedMs?: number
      toolCalls: ToolCallRecord[]
      blocks?: AssistantBlock[]
      durationMs?: number
      statusWord?: string
      /**
       * The run asked for a reply after this call's results (null: before
       * anything in this entry) with a message the user never sees. Kept so
       * the next run sends the same messages.
       */
      nudge?: { after: string | null }
      /** The latest trim recorded by the run that wrote this entry. */
      contextTrim?: ContextTrim
      /**
       * Tokens the provider billed for the newest request this turn made. Kept
       * whole: it is a handful of numbers, and the meter needs it on reload.
       */
      usage?: ProviderUsage
      /**
       * The server's estimate of what the newest request held, by category.
       * Newest wins; the dashboard reads its split and its budget from it.
       */
      contextBreakdown?: ContextBreakdown
      /**
       * The anchored count the run made before its newest request: the total
       * the meter shows, newer than `usage` once a request is under way.
       */
      contextUsage?: ContextUsageRecord
      /**
       * The breakdown of the same request as `usage` (paired by step), kept
       * apart from `contextBreakdown` so the meter calibrates against the
       * request the provider billed, not the newest one.
       */
      usageBreakdown?: ContextBreakdown
    }
  | CompactEntry

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
 * The provider-facing text of a user turn: its frozen context, its frozen
 * command block, then the user's words. Empty parts are skipped when a command
 * is present so no blank parts trail. Without one the join is exactly what
 * older transcripts were sent with, so their cached prefix still matches.
 */
function userTurnContent(
  entry: Extract<TranscriptEntry, { role: 'user' }>
): string {
  if (entry.commandText === undefined) {
    return entry.contextText
      ? `${entry.contextText}\n\n${entry.text}`
      : entry.text
  }
  return [entry.contextText, entry.commandText, entry.text]
    .filter(part => part)
    .join('\n\n')
}

/** The index of the newest `compact` entry, or -1 when there is none. */
export function latestCompactIndex(transcript: TranscriptEntry[]): number {
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i].role === 'compact') return i
  }
  return -1
}

/**
 * The index of the first transcript entry the provider still sees as history:
 * the tail of the newest compact boundary, else the boundary itself, else 0.
 * Entries before it are gone from every request.
 */
export function sentFromIndex(
  transcript: TranscriptEntry[],
  boundary = latestCompactIndex(transcript)
): number {
  if (boundary === -1) return 0
  const entry = transcript[boundary] as Extract<TranscriptEntry, { role: 'compact' }>
  const tailIndex = entry.tailFromId
    ? transcript.findIndex(other => other.id === entry.tailFromId)
    : -1
  return tailIndex !== -1 && tailIndex < boundary ? tailIndex : boundary
}

/**
 * Rebuilds the provider-facing message array from the stored transcript.
 *
 * The transcript is what gets persisted and rendered; this is the only place
 * that knows how it maps onto a conversation, which is why switching provider
 * mid-project is safe.
 *
 * After a compact boundary (the newest `compact` entry, index c) the messages
 * are the compaction message, then the tail kept verbatim (from `tailFromId`
 * up to c), then everything after c. Entries before the tail are never sent
 * again, and the entries before c are ignored.
 */
export function toAgentMessages(transcript: TranscriptEntry[]): AgentMessage[] {
  const boundary = latestCompactIndex(transcript)
  const boundaryEntry =
    boundary === -1
      ? null
      : (transcript[boundary] as Extract<TranscriptEntry, { role: 'compact' }>)
  if (!boundaryEntry) {
    return entriesToMessages(transcript, 0, transcript.length)
  }

  return [
    { role: 'user', content: renderCompactionMessage(boundaryEntry) },
    ...entriesToMessages(transcript, sentFromIndex(transcript, boundary), boundary),
    ...entriesToMessages(transcript, boundary + 1, transcript.length),
  ]
}

/** Messages for transcript[from, to). A compact entry sends nothing itself. */
function entriesToMessages(
  transcript: TranscriptEntry[],
  from: number,
  to: number
): AgentMessage[] {
  const messages: AgentMessage[] = []

  for (let index = from; index < to; index++) {
    const entry = transcript[index]
    if (entry.role === 'compact') continue

    if (entry.role === 'user') {
      const msg: AgentMessage = { role: 'user', content: userTurnContent(entry) }
      if (entry.images && entry.images.length > 0) {
        msg.images = entry.images
      }
      messages.push(msg)
      continue
    }

    if (index === transcript.length - 1 && !entry.text && entry.toolCalls.length === 0) continue

    if (entry.toolCalls.length === 0) {
      messages.push({ role: 'assistant', content: entry.text })
      continue
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
  }

  return messages
}
