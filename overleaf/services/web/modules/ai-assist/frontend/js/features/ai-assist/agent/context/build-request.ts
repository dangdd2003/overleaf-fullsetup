import { AgentMessage, ToolSpec } from '../../providers/types'
import { TranscriptEntry, toAgentMessages } from '../agent-messages'
import { applyBudget } from './budget'
import { SYSTEM_PROMPT } from './system-prompt'
import { CacheHints, Limits } from './types'

/**
 * Assembles the whole provider request from the transcript.
 *
 * It renders nothing. Envelopes were frozen onto their user entries at send
 * time, so this function only concatenates, trims, and marks cache
 * breakpoints — which is what makes turn N+1 a byte-exact extension of turn N.
 *
 * It validates nothing either: an empty transcript assembles an empty message
 * list, and an assistant-first transcript assembles an assistant-first one.
 * Providers reject both. "A conversation opens with a user turn" is the
 * transcript's own invariant, held by the panel that appends to it; a guard
 * here could only turn one rejection into another, further from the bug.
 */
export function buildRequest({
  transcript,
  limits,
  cacheKey,
  tools,
  systemPrompt,
}: {
  transcript: TranscriptEntry[]
  limits: Limits
  cacheKey?: string
  tools?: ToolSpec[]
  /**
   * Overrides the rail's prompt. A one-click fix run ships its own, much
   * smaller one; it must be a constant too, or the cached prefix dies.
   */
  systemPrompt?: string
}): {
  system: string
  messages: AgentMessage[]
  cacheHints: CacheHints
  exhausted: boolean
  /**
   * Forwarded from the budget pass. Distinguishes a misconfigured model — an
   * output cap that eats the whole window before any message is counted —
   * from a conversation that genuinely grew too long. This is the only layer
   * that sees it, so swallowing it would make the distinction unreachable.
   */
  reason?: 'budget-non-positive'
} {
  const system = systemPrompt ?? SYSTEM_PROMPT
  const { messages, exhausted, reason } = applyBudget({
    system,
    messages: toAgentMessages(transcript),
    limits,
    tools,
  })

  // Everything except the final message was already sent in some earlier
  // request, so it is exactly the prefix worth caching. Deliberately not
  // "one before the newest user message": on a regenerate or a loop resume
  // the last message is a tool result, and anchoring on the user turn would
  // drop the whole latest turn out of the cached prefix and re-send it.
  const lastStableMessage = messages.length >= 2 ? messages.length - 2 : null

  return {
    system,
    messages,
    cacheHints: {
      cacheSystem: true,
      cacheTools: true,
      lastStableMessage,
      cacheKey,
    },
    exhausted,
    ...(reason ? { reason } : {}),
  }
}
