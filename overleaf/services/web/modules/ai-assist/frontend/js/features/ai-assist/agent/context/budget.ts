import { AgentMessage, Limits, ToolSpec } from '../../providers/types'

/**
 * Text kinds the estimator tells apart. Mirrors the server's
 * AiAssistContextUsage.mjs: LaTeX and code are denser in tokens than prose,
 * JSON denser still.
 */
export type TextKind = 'prose' | 'latex' | 'json'

/** Chars per token of each kind, before any model adjustment. */
const BASE_CHARS_PER_TOKEN: Record<TextKind, number> = {
  prose: 4,
  latex: 3.5,
  json: 3,
}

/** Claude models on the newer tokenizer pack about a quarter more text per token. */
const NEW_TOKENIZER_SCALE = 0.75

/**
 * Claude models that still use the older tokenizer, after normalisation (see
 * `normalizeModelId`). The same list Claude Code keeps as `LU`: every other
 * Claude model counts with the newer tokenizer.
 */
export const LEGACY_CLAUDE_MODELS: ReadonlySet<string> = new Set([
  'claude-3-opus',
  'claude-3-sonnet',
  'claude-3-haiku',
  'claude-3-5-sonnet',
  'claude-3-5-haiku',
  'claude-3-7-sonnet',
  'claude-opus-4-0',
  'claude-opus-4-1',
  'claude-opus-4-5',
  'claude-opus-4-6',
  'claude-sonnet-4-0',
  'claude-sonnet-4-5',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
])

/** The provider and model a request is sent to; only the model sets the ratio. */
export type TokenizerModel = { provider?: string; model?: string }

/**
 * A model id as Claude Code compares it: lower case, from the `claude` part
 * on (so `anthropic/...`, `us.anthropic.claude-...` and `publishers/...`
 * prefixes drop), without the `[1m]` window suffix, the Bedrock `:0`/`-v1`
 * version, or the `-YYYYMMDD` date, with `.` and `_` as `-`.
 */
export function normalizeModelId(model: string): string {
  let id = model.trim().toLowerCase()
  const claude = id.indexOf('claude')
  if (claude > 0) id = id.slice(claude)
  return id
    .replace(/\[1m\]$/, '')
    .replace(/:\d+$/, '')
    .replace(/-v\d+$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/[._]/g, '-')
}

/**
 * An Anthropic model on the newer tokenizer: a named Claude model, served by
 * Anthropic, not on the legacy list.
 */
export function usesNewClaudeTokenizer(ref: TokenizerModel): boolean {
  if (ref.provider !== 'anthropic' || !ref.model) return false
  const id = normalizeModelId(ref.model)
  return id.startsWith('claude') && !LEGACY_CLAUDE_MODELS.has(id)
}

/** Chars per token for a kind of text sent to this model. */
export function charsPerToken(kind: TextKind, ref: TokenizerModel = {}): number {
  const base = BASE_CHARS_PER_TOKEN[kind]
  return usesNewClaudeTokenizer(ref) ? base * NEW_TOKENIZER_SCALE : base
}

/** The sample `detectTextKind` reads: the head of the text, as the server does. */
const KIND_SAMPLE_CHARS = 4096

/** LaTeX or code once this share of the sample is one of the markup characters. */
const MARKUP_SHARE = 0.02

const MARKUP_CHARS = new Set(['\\', '{', '}', '$', '&', '^', '_', '%'])

/** Prose, or LaTeX/code when markup characters make up 2% of the sample. */
export function detectTextKind(text: string): 'prose' | 'latex' {
  const sample = text.slice(0, KIND_SAMPLE_CHARS)
  if (sample.length === 0) return 'prose'
  let markup = 0
  for (const char of sample) {
    if (MARKUP_CHARS.has(char)) markup++
  }
  return markup / sample.length >= MARKUP_SHARE ? 'latex' : 'prose'
}

/**
 * Tokens of a text, estimated from its characters. The kind is detected from
 * the text unless given (JSON is always given). Every provider tokenises
 * differently, so this is a rough count, not a tokenizer.
 */
export function estimateTokens(
  text: string,
  ref: TokenizerModel = {},
  kind: TextKind = detectTextKind(text)
): number {
  return Math.ceil(text.length / charsPerToken(kind, ref))
}

/** Tokens of a JSON document: the serialised value, at the JSON ratio. */
export function estimateJsonTokens(
  value: unknown,
  ref: TokenizerModel = {}
): number {
  return estimateTokens(JSON.stringify(value) ?? '', ref, 'json')
}

/** The context thresholds for a window, as the server computes them. */
export type ContextThresholds = {
  /** The window less the output reservation. */
  effective: number
  /** At or above this, the chat is compacted before (or during) the next request. */
  autoCompactAt: number
  /** At or above this, the meter warns. */
  warnAt: number
  /** At or above this, the request is blocked unless compacted. */
  blockAt: number
}

/** Where a count sits against the thresholds. */
export type ContextState = 'ok' | 'warn' | 'compact' | 'blocked'

/**
 * Claude Code's thresholds: the output reservation (capped at 20k) comes off
 * the window, and the warn, auto-compact and block buffers are taken from the
 * rest, each capped so a small window (Ollama 8k/32k) keeps its headroom.
 * Mirrors `contextThresholds` in the server's AiAssistContextUsage.mjs.
 */
export function contextThresholds({
  contextWindow,
  maxOutputTokens,
}: {
  contextWindow: number
  maxOutputTokens: number
}): ContextThresholds {
  const reserve = Math.min(Math.max(0, maxOutputTokens), 20000)
  const effective = contextWindow - reserve
  const autoCompactBuf = Math.min(13000, Math.floor(effective * 0.15))
  const warnBuf = Math.min(20000, Math.floor(effective * 0.2))
  const blockBuf = Math.min(3000, Math.floor(effective * 0.03))
  return {
    effective,
    autoCompactAt: effective - autoCompactBuf,
    warnAt: effective - warnBuf,
    blockAt: effective - blockBuf,
  }
}

/** The state of a token count: blocked, compact, warn, or ok. */
export function contextStateFor(
  tokens: number,
  thresholds: ContextThresholds
): ContextState {
  if (tokens >= thresholds.blockAt) return 'blocked'
  if (tokens >= thresholds.autoCompactAt) return 'compact'
  if (tokens >= thresholds.warnAt) return 'warn'
  return 'ok'
}

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

function messageTokens(message: AgentMessage, ref: TokenizerModel): number {
  const content = estimateTokens(message.content ?? '', ref)
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return content + estimateJsonTokens(message.toolCalls, ref)
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
  tools: ToolSpec[] = [],
  ref: TokenizerModel = {}
): number {
  return (
    estimateTokens(system, ref) +
    messages.reduce(
      (total, message) => total + messageTokens(message, ref),
      0
    ) +
    (tools.length ? estimateJsonTokens(tools, ref) : 0)
  )
}

/** Indexes of the messages that pass `test`, in order. */
function indexesWhere(
  messages: AgentMessage[],
  test: (message: AgentMessage) => boolean
): number[] {
  const indexes: number[] = []
  messages.forEach((message, index) => {
    if (test(message)) indexes.push(index)
  })
  return indexes
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
 * Once trimming is needed, trim to this fraction of the budget instead of to
 * just under it. Every trim rewrites the prompt prefix and costs a full prompt
 * cache miss; trimming further in one go leaves room for the next several
 * steps to append without trimming again. Mirrors AiAssistRunManager.mjs.
 */
export const TRIM_TARGET_FRACTION = 0.7

/**
 * Trims a conversation to fit, deterministically.
 *
 * Order matters and is fixed: stale tool results first, then old assistant
 * text, then give up. Elision is monotonic — an elided result is already at its
 * smallest, so re-running this leaves it alone. Trimming only starts above the
 * budget and continues down to TRIM_TARGET_FRACTION of it, so the cache prefix
 * stays stable for the steps that follow.
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
  const ref: TokenizerModel = { provider: limits.provider, model: limits.model }
  // The hard budget is the block threshold: a request at or past it is not sent
  const budget = contextThresholds(limits).blockAt

  if (budget <= 0) {
    // The output reservation already consumes the whole context window on its
    // own: a misconfigured model (small window, large output cap), not a
    // conversation that grew too large. Flagged distinctly so the caller
    // doesn't tell the user "your chat is too long" when the real fault is the
    // configured output cap.
    return {
      messages: [...messages],
      elided: 0,
      exhausted: true,
      reason: 'budget-non-positive',
    }
  }

  const working = [...messages]
  // Per-message estimates kept in step with `working`, so each trim updates
  // the total instead of re-serialising the whole conversation.
  const sizes = working.map(message => messageTokens(message, ref))
  let total =
    estimateTokens(system, ref) +
    (tools.length ? estimateJsonTokens(tools, ref) : 0) +
    sizes.reduce((sum, size) => sum + size, 0)

  if (total <= budget) return { messages: working, elided: 0, exhausted: false }

  const target = Math.floor(budget * TRIM_TARGET_FRACTION)
  let elided = 0

  const replace = (index: number, message: AgentMessage) => {
    const size = messageTokens(message, ref)
    total += size - sizes[index]
    sizes[index] = size
    working[index] = message
  }

  // Pass one: tool results, oldest first, keeping the newest few intact.
  const toolIndexes = indexesWhere(working, message => message.role === 'tool')

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
    if (estimateTokens(candidate.content, ref) >= sizes[index]) continue
    replace(index, candidate)
    elided += 1
    if (total <= target) return { messages: working, elided, exhausted: false }
  }

  // Pass two: assistant prose from the oldest turns, keeping the newest few
  // intact. Tool calls stay attached — an orphaned tool result is rejected by
  // every provider — and content is replaced with a short marker rather than
  // blanked, since an assistant message with no tool calls and empty content
  // is itself invalid and would be rejected the same way.
  const assistantIndexes = indexesWhere(
    working,
    message => message.role === 'assistant' && Boolean(message.content)
  )

  const elidableAssistants = assistantIndexes.slice(
    0,
    Math.max(0, assistantIndexes.length - KEEP_RECENT_ASSISTANT_TURNS)
  )

  const markerTokens = estimateTokens(ASSISTANT_ELISION_MARKER, ref)
  for (const index of elidableAssistants) {
    const message = working[index] as Extract<
      AgentMessage,
      { role: 'assistant' }
    >
    // Symmetric to the pass-one guard above: a short reply (`'ok'`) is
    // already smaller than the marker that would replace it, so rewriting it
    // would grow the request instead of shrinking it.
    if (markerTokens >= estimateTokens(message.content, ref)) {
      continue
    }
    replace(index, { ...message, content: ASSISTANT_ELISION_MARKER })
    if (total <= target) return { messages: working, elided, exhausted: false }
  }

  return { messages: working, elided, exhausted: total > budget }
}
