import { AgentMessage, ToolSpec } from '../../providers/types'
import { Limits } from './types'

/**
 * Conservative for LaTeX, which tokenises worse than prose because of
 * backslashes and braces. A real tokenizer is not worth shipping to the
 * browser: the three providers do not share one.
 */
export const CHARS_PER_TOKEN = 3.7

/** Absorbs the gap between this estimate and the provider's real count. */
export const MARGIN_FRACTION = 0.1

/** How many of the newest tool results always survive intact. */
export const KEEP_RECENT_TOOL_RESULTS = 3

/**
 * How many of the newest assistant turns keep their original text, even
 * under budget pressure. Mirrors `KEEP_RECENT_TOOL_RESULTS`: the turn the
 * user is actively reading should never be the one that gets rewritten.
 */
const KEEP_RECENT_ASSISTANT_TURNS = KEEP_RECENT_TOOL_RESULTS

/**
 * Replaces old assistant prose. Never empty — an assistant message with no
 * tool calls and empty content is rejected outright by every provider's API,
 * so blanking is not a safe way to shrink one.
 */
const ASSISTANT_ELISION_MARKER = '[earlier reply elided]'

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

function messageTokens(message: AgentMessage): number {
  const content = estimateTokens(message.content ?? '')
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return content + estimateTokens(JSON.stringify(message.toolCalls))
  }
  return content
}

/**
 * `tools` is optional and defaults to no cost, so existing two-argument
 * callers are unaffected. Pass the registry's tool specs once a caller wires
 * them in — they are sent on every request and do count against the window.
 */
export function estimateRequestTokens(
  system: string,
  messages: AgentMessage[],
  tools: ToolSpec[] = []
): number {
  return (
    estimateTokens(system) +
    messages.reduce((total, message) => total + messageTokens(message), 0) +
    (tools.length ? estimateTokens(JSON.stringify(tools)) : 0)
  )
}

function isElided(message: AgentMessage): boolean {
  if (message.role !== 'tool') return false
  try {
    return JSON.parse(message.content)?.elided === true
  } catch {
    return false
  }
}

function stub(message: Extract<AgentMessage, { role: 'tool' }>): AgentMessage {
  return {
    ...message,
    content: JSON.stringify({
      elided: true,
      summary: `${message.name} result — content elided to fit the context window. Call ${message.name} again if you need it.`,
    }),
  }
}

/**
 * Trims a conversation to fit, deterministically.
 *
 * Order matters and is fixed: stale tool results first, then old assistant
 * text, then give up. Elision is monotonic — an elided result is already at its
 * smallest, so re-running this leaves it alone and the cache prefix restabilises
 * after the one turn where trimming happened.
 */
export function applyBudget({
  system,
  messages,
  limits,
  tools = [],
}: {
  system: string
  messages: AgentMessage[]
  limits: Limits
  tools?: ToolSpec[]
}): {
  messages: AgentMessage[]
  elided: number
  exhausted: boolean
  reason?: 'budget-non-positive'
} {
  const rawBudget =
    limits.contextWindow -
    limits.maxOutputTokens -
    Math.ceil(limits.contextWindow * MARGIN_FRACTION)

  if (rawBudget <= 0) {
    // The output reservation plus the safety margin already consumes the
    // whole context window on its own — a misconfigured model (small window,
    // large output cap), not a conversation that grew too large. Flagged
    // distinctly so the caller doesn't tell the user "your chat is too long"
    // when the real fault is the configured output cap.
    return {
      messages: [...messages],
      elided: 0,
      exhausted: true,
      reason: 'budget-non-positive',
    }
  }
  const budget = rawBudget

  const working = [...messages]
  let elided = 0

  const fits = () => estimateRequestTokens(system, working, tools) <= budget
  if (fits()) return { messages: working, elided: 0, exhausted: false }

  // Pass one: tool results, oldest first, keeping the newest few intact.
  const toolIndexes = working
    .map((message, index) => ({ message, index }))
    .filter(entry => entry.message.role === 'tool')
    .map(entry => entry.index)

  const elidable = toolIndexes.slice(
    0,
    Math.max(0, toolIndexes.length - KEEP_RECENT_TOOL_RESULTS)
  )

  for (const index of elidable) {
    const message = working[index]
    if (isElided(message)) continue
    const candidate = stub(message as Extract<AgentMessage, { role: 'tool' }>)
    // Only worth it if the stub is actually smaller. A short tool result (an
    // error string, a boolean) can serialise to *more* tokens once wrapped in
    // the elision envelope, which would grow the request instead of
    // shrinking it.
    if (estimateTokens(candidate.content) >= messageTokens(message)) continue
    working[index] = candidate
    elided += 1
    if (fits()) return { messages: working, elided, exhausted: false }
  }

  // Pass two: assistant prose from the oldest turns, keeping the newest few
  // intact. Tool calls stay attached — an orphaned tool result is rejected by
  // every provider — and content is replaced with a short marker rather than
  // blanked, since an assistant message with no tool calls and empty content
  // is itself invalid and would be rejected the same way.
  const assistantIndexes = working
    .map((message, index) => ({ message, index }))
    .filter(entry => entry.message.role === 'assistant' && entry.message.content)
    .map(entry => entry.index)

  const elidableAssistants = assistantIndexes.slice(
    0,
    Math.max(0, assistantIndexes.length - KEEP_RECENT_ASSISTANT_TURNS)
  )

  for (const index of elidableAssistants) {
    const message = working[index] as Extract<AgentMessage, { role: 'assistant' }>
    // Symmetric to the pass-one guard above: a short reply (`'ok'`) is
    // already smaller than the marker that would replace it, so rewriting it
    // would grow the request instead of shrinking it.
    if (estimateTokens(ASSISTANT_ELISION_MARKER) >= estimateTokens(message.content)) {
      continue
    }
    working[index] = { ...message, content: ASSISTANT_ELISION_MARKER }
    if (fits()) return { messages: working, elided, exhausted: false }
  }

  return { messages: working, elided, exhausted: true }
}
