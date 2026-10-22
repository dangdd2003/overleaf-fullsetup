import {
  latestCompactIndex,
  sentFromIndex,
  TranscriptEntry,
} from '../agent-messages'
import { renderCompactionMessage } from './compaction'
import { Limits } from './types'
import {
  TokenizerModel,
  contextStateFor,
  contextThresholds,
  estimateJsonTokens,
  estimateTokens,
} from './budget'
import {
  ContextBreakdown,
  ContextCategory,
  ContextCategoryId,
  ContextUsageRecord,
  ContextUsageSnapshot,
  ProviderUsage,
} from './context-usage-types'

/**
 * The dashboard's rows, in Claude Code's fixed display order (not by size).
 * The autocompact buffer (`reserved`) and free space close it.
 */
export const CONTEXT_CATEGORY_ORDER: ContextCategoryId[] = [
  'messages',
  'systemTools',
  'mcpTools',
  'skills',
  'systemPrompt',
  'memoryFiles',
  'mcpInstructions',
  'sinceLastUpdate',
  'reserved',
  'free',
]

/** The rows that hold tokens of the window, i.e. every row but the reserve and free space. */
type Part = Exclude<ContextCategoryId, 'reserved' | 'free'>
type Parts = Record<Part, number>

const PARTS: Part[] = CONTEXT_CATEGORY_ORDER.filter(
  (id): id is Part => id !== 'reserved' && id !== 'free'
)

/** Rows fixed by the system prompt and tool specs; they do not grow with the chat. */
const FIXED_PARTS: Part[] = [
  'systemTools',
  'mcpTools',
  'skills',
  'systemPrompt',
  'memoryFiles',
  'mcpInstructions',
]

type AssistantEntry = Extract<TranscriptEntry, { role: 'assistant' }>

const FORMATTER_THOUSANDS = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

const FORMATTER_UNITS = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
})

/**
 * Formats a token count the way Claude Code's context panel does: compact
 * notation, `1.2k` and `1M`. Thousands always show one decimal and then lose
 * a trailing `.0`, so 1000 is `1k` and 12345 is `12.3k`.
 */
export function formatTokens(n: number): string {
  const compact = (n >= 1000 ? FORMATTER_THOUSANDS : FORMATTER_UNITS)
    .format(n)
    .toLowerCase()
  // Only the `.0` right before a suffix or the end: `1.05` never occurs here,
  // and a `.0` inside a longer number must survive.
  return compact.replace(/\.0(?=[a-z]|$)/, '').replace(/m$/, 'M')
}

/** One decimal and a percent sign: `23.4%`. */
export function formatPercent(p: number): string {
  return `${p.toFixed(1)}%`
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 0
}

function emptyParts(): Parts {
  return Object.fromEntries(PARTS.map(id => [id, 0])) as Parts
}

function sumParts(parts: Parts, ids: Part[] = PARTS): number {
  return ids.reduce((total, id) => total + parts[id], 0)
}

/** The fixed rows of one request, from its breakdown. */
function fixedRows(breakdown: ContextBreakdown): Parts {
  const parts = emptyParts()
  parts.systemPrompt = count(breakdown.systemPrompt)
  parts.skills = count(breakdown.skills)
  parts.memoryFiles = count(breakdown.projectInstructions)
  parts.mcpInstructions = count(breakdown.connectorInstructions)
  parts.systemTools =
    count(breakdown.builtinTools) +
    count(breakdown.webTools) +
    count(breakdown.connectorHelperTools)
  parts.mcpTools = count(breakdown.connectorTools)
  return parts
}

/**
 * The conversation's estimated tokens in a breakdown: its variable estimates
 * plus the provider framing, as Claude Code folds overhead into Messages.
 */
function breakdownMessages(breakdown: ContextBreakdown): number {
  return (
    count(breakdown.userMessages) +
    count(breakdown.projectContext) +
    count(breakdown.assistantMessages) +
    count(breakdown.toolResults) +
    count(breakdown.images) +
    count(breakdown.overhead)
  )
}

/**
 * Splits `total` over `weights` in proportion. Whole tokens are handed out by
 * largest remainder, so the parts add up to `total` exactly. With no weight at
 * all the whole total lands on messages.
 */
function distribute(weights: Parts, total: number): Parts {
  const out = emptyParts()
  if (total <= 0) return out
  const weight = sumParts(weights)
  if (weight <= 0) {
    out.messages = total
    return out
  }
  const shares = PARTS.map(id => {
    const exact = (weights[id] * total) / weight
    const base = Math.floor(exact)
    return { id, base, fraction: exact - base }
  })
  for (const share of shares) out[share.id] = share.base
  let spare = total - shares.reduce((sum, share) => sum + share.base, 0)
  const byRemainder = [...shares].sort((a, b) => b.fraction - a.fraction)
  for (const share of byRemainder) {
    if (spare <= 0) break
    out[share.id] += 1
    spare -= 1
  }
  return out
}

/**
 * The breakdown of the very request this usage billed, or undefined. Pairing
 * is by step: a breakdown from another request says nothing about this one.
 */
export function pairedBreakdown(
  usage: ProviderUsage | undefined,
  breakdown: ContextBreakdown | undefined
): ContextBreakdown | undefined {
  return usage !== undefined &&
    breakdown !== undefined &&
    usage.step !== undefined &&
    breakdown.step === usage.step
    ? breakdown
    : undefined
}

/**
 * Chars/4 of what one transcript entry put into a request: the conversation
 * part only. Thinking is not sent back to the provider, so it is not counted.
 * Images are not estimated: their base64 length says nothing about their cost.
 */
function entryMessages(entry: TranscriptEntry, ref: TokenizerModel): number {
  // The boundary's summary is counted once, in `compactionTokens`
  if (entry.role === 'compact') return 0
  if (entry.role === 'user') {
    return (
      estimateTokens(entry.contextText ?? '', ref) +
      estimateTokens(entry.text ?? '', ref) +
      estimateTokens(entry.commandText ?? '', ref)
    )
  }
  let tokens = estimateTokens(entry.text ?? '', ref)
  for (const call of entry.toolCalls ?? []) {
    tokens += estimateJsonTokens(call.args, ref)
    if ('result' in call && call.result !== undefined) {
      tokens += estimateJsonTokens(call.result, ref)
    }
  }
  return tokens
}

function entriesMessages(
  entries: TranscriptEntry[],
  ref: TokenizerModel
): number {
  return entries.reduce(
    (total, entry) => total + entryMessages(entry, ref),
    0
  )
}

/** Usage a provider actually reported; an all-zero record says nothing. */
/** The assistant entry at `index`, if that is one. */
function assistantAt(
  transcript: TranscriptEntry[],
  index: number
): AssistantEntry | undefined {
  const entry = transcript[index]
  return entry?.role === 'assistant' ? entry : undefined
}

/** The compact entry at `index`, if that is one. */
function compactAt(
  transcript: TranscriptEntry[],
  index: number
): Extract<TranscriptEntry, { role: 'compact' }> | undefined {
  const entry = transcript[index]
  return entry?.role === 'compact' ? entry : undefined
}

function hasUsage(usage: ProviderUsage | undefined): boolean {
  return (
    usage !== undefined &&
    count(usage.inputTokens) +
      count(usage.outputTokens) +
      count(usage.cacheReadTokens) +
      count(usage.cacheCreationTokens) >
      0
  )
}

function lastIndexWhere(
  transcript: TranscriptEntry[],
  test: (entry: TranscriptEntry) => boolean
): number {
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (test(transcript[i])) return i
  }
  return -1
}

function percentOf(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0
}

/**
 * Works out how full the context window is, and how the full part splits,
 * the way Claude Code's `/context` does.
 *
 * Source, in order of preference:
 * - The newest `contextUsage` record (emitted before each provider request):
 *   its anchored total, plus the estimate of the entries after its entry.
 *   It is newer than the usage it was anchored on, so it wins when its step
 *   is higher than the newest usage's (or sits on a later entry, when the
 *   usage has no step). Exact when anchored on provider usage.
 * - Else the newest assistant entry with an exact `usage` (not `partialInput`):
 *   with I = input + cache read + cache write and O = output, the total is
 *   I + O plus the estimate of the entries after it. Exact.
 * - Else the newest assistant entry with `contextBreakdown` (also for a
 *   `partialInput` usage, which counts only part of the prompt): its fixed
 *   rows, and messages = its variable estimates plus its overhead. Not exact.
 * - After a compact boundary with no request since: the fixed rows of the
 *   last breakdown before it, and the compaction message plus the entries
 *   still sent. Not exact.
 * - Else no server data: the estimate of every entry still sent. Not exact.
 *
 * The categories split the total by the fixed rows of the same request where
 * known: the system prompt, skills, memory files, MCP instructions and the
 * tool specs stay as estimated, and messages takes what is left. The deferred
 * connector tools of the newest breakdown are reported beside the categories,
 * never in them.
 *
 * The window and output reservation come from `limits`, the saved provider's,
 * falling back to the newest breakdown's only when `limits` has no window.
 * The thresholds come from the same limits (`contextThresholds`). Budget is
 * the block threshold; the autocompact buffer is the window above the
 * auto-compact threshold, shown as its own row; the free space is what is
 * left after it.
 *
 * When the conversation is past the window, the parts are scaled down to fill
 * the window so the categories still sum to it, and `percentUsed` stops at 100.
 */
export function computeContextUsage({
  transcript,
  limits,
  model,
}: {
  transcript: TranscriptEntry[]
  limits: Limits
  model?: string
}): ContextUsageSnapshot {
  const ref: TokenizerModel = {
    provider: limits.provider,
    model: model ?? limits.model,
  }
  // Usage and breakdowns from before the newest compact boundary describe a
  // request that no longer exists, so only what follows it counts.
  const boundary = latestCompactIndex(transcript)
  const onlyAfterBoundary = (index: number) => (index > boundary ? index : -1)
  const usageIndex = onlyAfterBoundary(
    lastIndexWhere(
      transcript,
      entry => entry.role === 'assistant' && hasUsage(entry.usage)
    )
  )
  const contextIndex = onlyAfterBoundary(
    lastIndexWhere(
      transcript,
      entry => entry.role === 'assistant' && entry.contextUsage !== undefined
    )
  )
  const lastBreakdown = lastIndexWhere(
    transcript,
    entry => entry.role === 'assistant' && entry.contextBreakdown !== undefined
  )
  const breakdownIndex = onlyAfterBoundary(lastBreakdown)
  const boundaryEntry = compactAt(transcript, boundary)
  const compactionTokens = boundaryEntry
    ? estimateTokens(renderCompactionMessage(boundaryEntry), ref)
    : 0
  const usageEntry = assistantAt(transcript, usageIndex)
  const contextEntry = assistantAt(transcript, contextIndex)
  const breakdownEntry = assistantAt(transcript, breakdownIndex)
  const usage: ProviderUsage | undefined = usageEntry?.usage
  const contextRecord: ContextUsageRecord | undefined = contextEntry?.contextUsage
  const breakdown: ContextBreakdown | undefined =
    breakdownEntry?.contextBreakdown
  // Before the first request after a boundary: the system prompt and tools
  // of the last request still hold, its messages do not
  const staleIndex = boundary !== -1 && breakdownIndex === -1 ? lastBreakdown : -1
  const staleBreakdown = assistantAt(transcript, staleIndex)?.contextBreakdown

  // The record is newer than the usage when its request is later; a step
  // tie is the usage (it reports the request after the record was sent).
  const recordIsNewest =
    contextRecord !== undefined &&
    (usage === undefined
      ? true
      : usage.step !== undefined
        ? contextRecord.step > usage.step
        : contextIndex > usageIndex)

  // The saved provider's limits, not the last request's: the next request is
  // sent under them, so a model switch moves the meter at once. The server
  // resolves the same limits with the same formula, so they agree otherwise.
  const fromBreakdown =
    count(limits.contextWindow) > 0 ? undefined : (breakdown ?? staleBreakdown)
  const contextWindow = Math.max(
    1,
    fromBreakdown ? count(fromBreakdown.contextWindow) : count(limits.contextWindow)
  )
  const maxOutputTokens = fromBreakdown
    ? count(fromBreakdown.maxOutputTokens)
    : count(limits.maxOutputTokens)
  const thresholds = contextThresholds({ contextWindow, maxOutputTokens })
  const budget = thresholds.blockAt > 0 ? thresholds.blockAt : contextWindow

  // A partial count (Ollama) is a floor on the input, so it is not exact.
  const usageExact =
    usageEntry !== undefined && usage !== undefined && !usage.partialInput
  const exact =
    contextRecord !== undefined && recordIsNewest
      ? contextRecord.exact
      : usageExact
  let used: number
  let parts: Parts
  if (usageExact && usage && !recordIsNewest) {
    const inputSide =
      count(usage.inputTokens) +
      count(usage.cacheReadTokens) +
      count(usage.cacheCreationTokens)
    const outputSide = count(usage.outputTokens)
    const trailing = entriesMessages(transcript.slice(usageIndex + 1), ref)
    const paired = pairedBreakdown(usage, usageEntry?.usageBreakdown)
    const fixedSource = paired ?? breakdown
    const fixed = fixedSource ? fixedRows(fixedSource) : emptyParts()
    const fixedTotal = sumParts(fixed, FIXED_PARTS)

    if (fixedTotal <= inputSide) {
      parts = { ...fixed }
      parts.messages = inputSide - fixedTotal + outputSide
    } else {
      parts = distribute(fixed, inputSide)
      parts.messages = outputSide
    }
    parts.sinceLastUpdate = trailing
    used = inputSide + outputSide + trailing
  } else if (breakdown) {
    const trailing = entriesMessages(transcript.slice(breakdownIndex + 1), ref)
    parts = fixedRows(breakdown)
    parts.messages = breakdownMessages(breakdown)
    parts.sinceLastUpdate = trailing
    used = sumParts(parts)
  } else if (staleBreakdown) {
    parts = fixedRows(staleBreakdown)
    parts.sinceLastUpdate =
      compactionTokens +
      entriesMessages(transcript.slice(sentFromIndex(transcript)), ref)
    used = sumParts(parts)
  } else {
    parts = emptyParts()
    parts.messages =
      compactionTokens +
      entriesMessages(transcript.slice(sentFromIndex(transcript)), ref)
    used = sumParts(parts)
  }

  if (contextRecord && recordIsNewest) {
    // The newest count: its anchored total, the fixed rows of the request as
    // the breakdown has them, the rest as messages, and the entries since.
    const trailing = entriesMessages(transcript.slice(contextIndex + 1), ref)
    const fixedTotal = sumParts(parts, FIXED_PARTS)
    parts.messages = Math.max(0, contextRecord.tokens - fixedTotal)
    parts.sinceLastUpdate = trailing
    used = fixedTotal + parts.messages + trailing
  }

  // Past the window the parts are scaled to fill it, so the grid still adds up.
  const shown = used > contextWindow ? distribute(parts, contextWindow) : parts
  const shownTotal = Math.min(used, contextWindow)

  // The autocompact buffer: the window above the auto-compact threshold.
  const reserveWanted = Math.max(0, contextWindow - thresholds.autoCompactAt)
  const reserved = Math.min(reserveWanted, contextWindow - shownTotal)
  const free = contextWindow - shownTotal - reserved

  const categories: ContextCategory[] = CONTEXT_CATEGORY_ORDER.map(id => {
    const tokens =
      id === 'reserved' ? reserved : id === 'free' ? free : shown[id]
    return { id, tokens, percent: percentOf(tokens, contextWindow) }
  })

  const percentOfBudget = percentOf(used, budget)
  const deferredTokens = count(breakdown?.deferredConnectorTools)
  const deferredCount = count(breakdown?.deferredConnectorToolCount)

  return {
    usedTokens: used,
    contextWindow,
    maxOutputTokens,
    budget,
    thresholds,
    percentUsed: Math.min(100, percentOf(used, contextWindow)),
    percentOfBudget: Math.min(100, percentOfBudget),
    state: contextStateFor(used, thresholds),
    exact,
    usage,
    categories,
    breakdown,
    deferred:
      deferredTokens > 0
        ? [
            {
              id: 'deferredConnectorTools',
              tokens: deferredTokens,
              count: deferredCount,
            },
          ]
        : [],
    model: model ?? breakdown?.model,
    empty: !transcript.some(entry => entry.role === 'user'),
  }
}
