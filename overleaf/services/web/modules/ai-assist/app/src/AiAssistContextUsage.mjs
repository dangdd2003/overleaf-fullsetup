import { createHash } from 'node:crypto'
import { IMAGE_TOKEN_ESTIMATE, imageDimensions } from './AiAssistImages.mjs'
import { estimateImageTokens, imagePolicyFor } from './AiAssistImagePolicy.mjs'
import { toolWireSpec } from './AiAssistProviders.mjs'
import { slashCommandsSection } from './AiAssistSystemPrompt.mjs'

// The run's own estimate of what a request holds. The budget trims by it and
// the context dashboard shows it, so both read the same numbers.
export const MARGIN_FRACTION = 0.1

/**
 * Characters per token, by kind of text. The flat chars/4 this used to apply
 * is too low for JSON and LaTeX, which pack more tokens into each character.
 *
 * - Prose: 4. The common rule of thumb, and what Claude Code uses by default.
 * - JSON (tool specs, tool-call arguments, JSON tool results): 3. Claude Code
 *   uses 2 here, the conservative end. Tool specs are JSON whose strings are
 *   English descriptions, which run near 4 characters a token, while the
 *   braces, quotes and keys cost more; 3 sits between the two. A judgement,
 *   not a tokenizer measurement.
 * - LaTeX and code: 3.5, between prose and JSON. Text counts as LaTeX or code
 *   when its syntax characters are dense enough (SYNTAX_DENSITY).
 *
 * Claude models on the newer tokenizer (see usesNewerTokenizer) take the
 * same ratios scaled by NEWER_TOKENIZER_SCALE; charsPerToken picks them.
 *
 * Where a provider's count API answers, its exact counts replace the estimate
 * for the system prompt and the tool specs (see withExactFixed).
 */
export const PROSE_CHARS_PER_TOKEN = 4
export const JSON_CHARS_PER_TOKEN = 3
export const LATEX_CHARS_PER_TOKEN = 3.5
/** Share of syntax characters (\ { } $ & ^ _ %) that marks LaTeX or code. */
export const SYNTAX_DENSITY = 0.02
// Only the head of a long text is scanned for its density
const DENSITY_SAMPLE_CHARS = 4096
const SYNTAX_CHARS = /[\\{}$&^_%]/g

/**
 * Framing each provider adds that no part of the breakdown holds. These are
 * approximations taken from each provider's documented token accounting, not
 * measurements, and they are small against the window.
 *
 * - Anthropic: a fixed preamble the API puts before the tools when any are
 *   offered (346), and about 4 tokens of role and turn wrapping per message.
 * - OpenAI: 3 per message, 3 to prime the reply, and a few for the functions
 *   wrapper around a tool list (8, once).
 * - Google: about 2 per turn for the role and part wrappers.
 * - Ollama: 0. Its chat templates differ per model and are not counted.
 */
export const ANTHROPIC_TOOL_PREAMBLE_TOKENS = 346
export const ANTHROPIC_MESSAGE_FRAMING_TOKENS = 4
export const OPENAI_MESSAGE_FRAMING_TOKENS = 3
export const OPENAI_REPLY_PRIMING_TOKENS = 3
export const OPENAI_TOOLS_FRAMING_TOKENS = 8
export const GOOGLE_MESSAGE_FRAMING_TOKENS = 2
export const OLLAMA_MESSAGE_FRAMING_TOKENS = 0

function syntaxDenseText(text) {
  const sample =
    text.length > DENSITY_SAMPLE_CHARS
      ? text.slice(0, DENSITY_SAMPLE_CHARS)
      : text
  const syntax = (sample.match(SYNTAX_CHARS) ?? []).length
  return syntax / sample.length >= SYNTAX_DENSITY
}

/**
 * Claude Code's legacy tokenizer models (its LU set). Claude models outside
 * this list use the newer tokenizer, which packs about a quarter more tokens
 * into the same characters.
 */
export const LEGACY_TOKENIZER_MODELS = new Set([
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
/** Chars per token scale for the newer Claude tokenizer (see charsPerToken). */
export const NEWER_TOKENIZER_SCALE = 0.75

/**
 * A model id as the legacy list spells it: lower case, no provider prefix,
 * no date suffix, with dots and underscores as dashes.
 */
function canonicalModelId(model) {
  if (typeof model !== 'string') return ''
  const id = model.trim().toLowerCase()
  return id
    .slice(id.lastIndexOf('/') + 1)
    .replace(/-\d{8}$/, '')
    .replace(/[._]/g, '-')
}

/**
 * True for a Claude model on the newer tokenizer: an Anthropic request whose
 * model is named and not in LEGACY_TOKENIZER_MODELS. Other providers and
 * unnamed models keep the base ratios.
 */
export function usesNewerTokenizer({ provider, model } = {}) {
  if (provider !== 'anthropic') return false
  const id = canonicalModelId(model)
  return id !== '' && !LEGACY_TOKENIZER_MODELS.has(id)
}

/**
 * Characters per token for a kind of text ('prose', 'latex' or 'json') as a
 * request's provider and model count them. The base ratios above, scaled for
 * the newer Claude tokenizer (see usesNewerTokenizer). With no pricing, the
 * base ratios.
 */
export function charsPerToken(kind, pricing = null) {
  const base =
    kind === 'json'
      ? JSON_CHARS_PER_TOKEN
      : kind === 'latex'
        ? LATEX_CHARS_PER_TOKEN
        : PROSE_CHARS_PER_TOKEN
  return usesNewerTokenizer(pricing ?? {}) ? base * NEWER_TOKENIZER_SCALE : base
}

/**
 * Tokens in a piece of prose, LaTeX or code (see the constants above).
 * `pricing` is { provider, model }, which picks the ratio (charsPerToken).
 */
export function estimateTokens(text, pricing = null) {
  if (typeof text !== 'string' || text.length === 0) return 0
  const kind = syntaxDenseText(text) ? 'latex' : 'prose'
  return Math.ceil(text.length / charsPerToken(kind, pricing))
}

/** Tokens in JSON: a value (serialised here) or a string already in JSON. */
export function estimateJsonTokens(value, pricing = null) {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
  return Math.ceil(text.length / charsPerToken('json', pricing))
}

// A tool result that is a JSON object or array, the shape the tools return
function looksLikeJson(text) {
  if (typeof text !== 'string') return false
  const trimmed = text.trim()
  return (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  )
}

const imageSizes = new WeakMap()

function sizeOfImage(image) {
  if (Number.isFinite(image.width) && Number.isFinite(image.height)) {
    return { width: image.width, height: image.height }
  }
  if (!imageSizes.has(image)) imageSizes.set(image, imageDimensions(image))
  return imageSizes.get(image)
}

/**
 * What one image costs in tokens. An image that carries its cost (tool images,
 * see detachToolImages) keeps it. Otherwise its size is read from the bytes
 * and priced for the provider; with no size or provider it takes the flat
 * estimate.
 */
function imageTokens(image, pricing) {
  if (!image || typeof image !== 'object') return IMAGE_TOKEN_ESTIMATE
  if (Number.isFinite(image.tokens)) return image.tokens
  if (!pricing?.provider) return IMAGE_TOKEN_ESTIMATE
  const size = sizeOfImage(image)
  if (!size) return IMAGE_TOKEN_ESTIMATE
  const choice = imagePolicyFor({
    type: pricing.provider,
    model: pricing.model,
  })
  return estimateImageTokens({
    width: size.width,
    height: size.height,
    provider: pricing.provider,
    model: pricing.model,
    detail: choice.mediaResolution ?? choice.detail,
  })
}

/**
 * The tokens of one message's own content, tool-call arguments and images.
 * `pricing` is { provider, model }, the provider a request goes to: it prices
 * the images. Without one an image takes the flat estimate. Without a provider
 * the framing and tool rules fall back to OpenAI's, the client default.
 * Framing is not in it; see messageFramingTokens.
 */
export function estimateMessageTokens(message, pricing = null) {
  return (
    messageTextTokens(message, pricing) + messageImageTokens(message, pricing)
  )
}

// A message's content and tool-call arguments, images aside
function messageTextTokens(message, pricing) {
  let count =
    message.role === 'tool' && looksLikeJson(message.content)
      ? estimateJsonTokens(message.content, pricing)
      : estimateTokens(message.content, pricing)
  if (message.role === 'assistant' && message.toolCalls?.length) {
    count += estimateJsonTokens(message.toolCalls, pricing)
  }
  return count
}

function messageImageTokens(message, pricing) {
  if (!Array.isArray(message.images)) return 0
  let count = 0
  for (const image of message.images) count += imageTokens(image, pricing)
  return count
}

/**
 * The tokens of one tool spec, in the wire shape its provider takes. `model`
 * is optional: without it the base ratios apply.
 */
export function estimateToolTokens(tool, provider, model) {
  return estimateJsonTokens(toolWireSpec(provider, tool), { provider, model })
}

export function estimateToolsTokens(tools = [], provider, model) {
  let total = 0
  for (const tool of tools) total += estimateToolTokens(tool, provider, model)
  return total
}

/** Framing per message, see the constants above. */
export function messageFramingTokens(provider) {
  switch (provider) {
    case 'anthropic':
      return ANTHROPIC_MESSAGE_FRAMING_TOKENS
    case 'google':
      return GOOGLE_MESSAGE_FRAMING_TOKENS
    case 'ollama':
      return OLLAMA_MESSAGE_FRAMING_TOKENS
    default:
      return OPENAI_MESSAGE_FRAMING_TOKENS
  }
}

/** Framing for the request as a whole, whatever its message count. */
export function fixedOverheadTokens(provider, { hasTools }) {
  switch (provider) {
    case 'anthropic':
      return hasTools ? ANTHROPIC_TOOL_PREAMBLE_TOKENS : 0
    case 'google':
    case 'ollama':
      return 0
    default:
      return (
        OPENAI_REPLY_PRIMING_TOKENS +
        (hasTools ? OPENAI_TOOLS_FRAMING_TOKENS : 0)
      )
  }
}

/**
 * Splits `total` across `weights` in proportion, with largest-remainder
 * rounding so the parts are whole and sum to `total` exactly. With no weight
 * the whole total goes to the first part.
 */
export function allocateByShare(total, weights) {
  if (weights.length === 0) return []
  const sum = weights.reduce((a, b) => a + b, 0)
  if (sum <= 0) return weights.map((_, i) => (i === 0 ? total : 0))
  const raw = weights.map(w => (total * w) / sum)
  const parts = raw.map(Math.floor)
  let left = total - parts.reduce((a, b) => a + b, 0)
  const order = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index)
  for (let k = 0; k < order.length && left > 0; k++, left--) {
    parts[order[k].index]++
  }
  return parts
}

/**
 * What a request holds, in the estimate the budget trims by: the system
 * prompt, the tool specs, the fixed framing and every message with its
 * framing. The breakdown's categories and overhead add up to this figure.
 */
export function estimateRequestTokens({
  system = '',
  messages = [],
  tools = [],
  provider,
  model,
}) {
  const pricing = { provider, model }
  const framing = messageFramingTokens(provider)
  let total =
    estimateTokens(system, pricing) +
    estimateToolsTokens(tools, provider, model) +
    fixedOverheadTokens(provider, { hasTools: tools.length > 0 })
  for (const message of messages) {
    total += estimateMessageTokens(message, pricing) + framing
  }
  return total
}

/**
 * The context thresholds, as Claude Code sets them. The window less a reserve
 * for the reply is the effective window; three buffers below it mark when the
 * meter warns, when a chat is compacted, and when the run is blocked. Each
 * buffer is a share of the effective window, capped, and the caps keep the
 * small windows of local models usable (an 8k window gets a 900-token buffer
 * for compaction, not 13,000).
 */
export const RESERVE_CAP_TOKENS = 20000
export const AUTO_COMPACT_BUFFER_CAP = 13000
export const AUTO_COMPACT_BUFFER_SHARE = 0.15
export const WARN_BUFFER_CAP = 20000
export const WARN_BUFFER_SHARE = 0.2
export const BLOCK_BUFFER_CAP = 3000
export const BLOCK_BUFFER_SHARE = 0.03

export function contextThresholds({ contextWindow, maxOutputTokens }) {
  const reserve = Math.min(maxOutputTokens, RESERVE_CAP_TOKENS)
  const effective = contextWindow - reserve
  const autoCompactBuffer = Math.min(
    AUTO_COMPACT_BUFFER_CAP,
    Math.floor(effective * AUTO_COMPACT_BUFFER_SHARE)
  )
  const warnBuffer = Math.min(
    WARN_BUFFER_CAP,
    Math.floor(effective * WARN_BUFFER_SHARE)
  )
  const blockBuffer = Math.min(
    BLOCK_BUFFER_CAP,
    Math.floor(effective * BLOCK_BUFFER_SHARE)
  )
  return {
    effective,
    autoCompactAt: effective - autoCompactBuffer,
    warnAt: effective - warnBuffer,
    blockAt: effective - blockBuffer,
  }
}

/** 'blocked', 'compact', 'warn' or 'ok', for a count against the thresholds. */
export function contextState(tokens, thresholds) {
  if (tokens >= thresholds.blockAt) return 'blocked'
  if (tokens >= thresholds.autoCompactAt) return 'compact'
  if (tokens >= thresholds.warnAt) return 'warn'
  return 'ok'
}

/**
 * The tokens a request may hold before it is trimmed: the blockAt threshold.
 * Kept for callers that want the single figure; contextThresholds has the rest.
 */
export function contextBudget(limits) {
  return contextThresholds(limits).blockAt
}

// The leading <project-context> envelope of a user turn (see userTurnContent),
// or 0 when the turn has none
const CONTEXT_OPEN = '<project-context'
const CONTEXT_CLOSE = '</project-context>'
function envelopeLength(content) {
  if (typeof content !== 'string' || !content.startsWith(CONTEXT_OPEN)) {
    return 0
  }
  const close = content.indexOf(CONTEXT_CLOSE)
  return close === -1 ? 0 : close + CONTEXT_CLOSE.length
}

const MAX_CONNECTOR_DETAILS = 1000
const MAX_RESULT_DETAILS = 20

/**
 * Framing the request holds beyond its parts: the fixed part per provider and
 * the per-message framing. The budget and the breakdown both use it.
 */
export function requestOverheadTokens(provider, { hasTools, messageCount }) {
  return (
    fixedOverheadTokens(provider, { hasTools }) +
    messageCount * messageFramingTokens(provider)
  )
}

/**
 * What one provider request held, as the ContextBreakdown the dashboard reads.
 * Pure: every count is an estimate over the messages and specs as they are
 * sent, in each provider's wire shape. `withExactFixed` then replaces the
 * fixed parts with the provider's counts when it has them.
 *
 * - `system`: the blocks from systemBlocksFor. Its `shared` block already
 *   contains the connectors block and the slash commands section, so both are
 *   subtracted from it; the slash commands count as `skills`.
 * - `messages`: the budgeted messages, the ones this request sends.
 * - `tools`: the tool specs this request offers. `webToolNames`,
 *   `connectorToolNames` and `helperToolNames` say which of them are web,
 *   connector or connector helper tools; the rest are built in.
 * - `connectorCatalog`: every connector tool the session offers, sent or
 *   deferred (ConnectorSession.catalog): { name, originalName, server, spec,
 *   deferred }. The sent ones are in `tools` already; the deferred ones are
 *   counted apart, as they are not in the window.
 * - `trim`: the contextTrim record, for the elided and dropped counts.
 * - `step`: the provider request this describes (ProviderUsage.step pairs).
 */
export function contextBreakdownFor({
  system = {},
  messages = [],
  tools = [],
  webToolNames = [],
  connectorToolNames = [],
  helperToolNames = [],
  connectorCatalog = [],
  trim = null,
  limits = {},
  model,
  provider,
  step,
}) {
  const pricing = { provider, model }
  const connectorInstructions = estimateTokens(system.connectors, pricing)
  const web = new Set(webToolNames)
  const connector = new Set(connectorToolNames)
  const helper = new Set(helperToolNames)

  let builtinTools = 0
  let webTools = 0
  let connectorHelperTools = 0
  let connectorTools = 0
  for (const spec of tools) {
    const tokens = estimateToolTokens(spec, provider, model)
    if (helper.has(spec.name)) {
      connectorHelperTools += tokens
    } else if (connector.has(spec.name)) {
      connectorTools += tokens
    } else if (web.has(spec.name)) {
      webTools += tokens
    } else {
      builtinTools += tokens
    }
  }

  const connectorToolDetails = []
  let deferredConnectorTools = 0
  let deferredConnectorToolCount = 0
  for (const row of connectorCatalog) {
    const tokens = estimateToolTokens(row.spec, provider, model)
    const deferred = row.deferred === true
    connectorToolDetails.push({
      name: row.originalName,
      server: row.server,
      tokens,
      deferred,
    })
    if (deferred) {
      deferredConnectorTools += tokens
      deferredConnectorToolCount++
    }
  }
  // Sent tools first, each group largest first
  connectorToolDetails.sort(
    (a, b) => Number(a.deferred) - Number(b.deferred) || b.tokens - a.tokens
  )

  let userMessages = 0
  let projectContext = 0
  let assistantMessages = 0
  let toolResults = 0
  let images = 0
  const resultsByName = new Map()
  for (const message of messages) {
    const text = messageTextTokens(message, pricing)
    images += messageImageTokens(message, pricing)
    if (message.role === 'tool') {
      toolResults += text
      const name = message.name || 'tool'
      const entry = resultsByName.get(name) ?? { name, tokens: 0, count: 0 }
      entry.tokens += text
      entry.count += 1
      resultsByName.set(name, entry)
    } else if (message.role === 'user') {
      // The envelope alone can price denser than the whole turn, so it is
      // capped at the turn and its own words never go below zero
      const context = Math.min(
        text,
        estimateTokens(
          message.content?.slice(0, envelopeLength(message.content)),
          pricing
        )
      )
      projectContext += context
      userMessages += text - context
    } else {
      assistantMessages += text
    }
  }

  const byTokens = (a, b) => b.tokens - a.tokens
  const budget = contextBudget({
    contextWindow: limits.contextWindow,
    maxOutputTokens: limits.maxOutputTokens,
  })
  const modelName = typeof model === 'string' ? model.trim() : ''
  // The slash commands catalogue is in the shared block, so it is measured
  // apart and taken out of the system prompt
  const skills = estimateTokens(slashCommandsSection(system), pricing)

  return {
    systemPrompt: Math.max(
      0,
      estimateTokens(system.shared, pricing) - connectorInstructions - skills
    ),
    skills,
    projectInstructions: estimateTokens(system.instructions, pricing),
    connectorInstructions,
    builtinTools,
    webTools,
    connectorHelperTools,
    connectorTools,
    connectorToolDetails: connectorToolDetails.slice(0, MAX_CONNECTOR_DETAILS),
    overhead: requestOverheadTokens(provider, {
      hasTools: tools.length > 0,
      messageCount: messages.length,
    }),
    exactFixed: false,
    userMessages,
    projectContext,
    assistantMessages,
    toolResults,
    toolResultDetails: [...resultsByName.values()]
      .sort(byTokens)
      .slice(0, MAX_RESULT_DETAILS),
    images,
    deferredConnectorTools,
    deferredConnectorToolCount,
    elidedMessages: trim?.elided?.length ?? 0,
    droppedMessages: trim?.dropped ?? 0,
    contextWindow: limits.contextWindow,
    maxOutputTokens: limits.maxOutputTokens,
    budget,
    ...(modelName ? { model: modelName } : {}),
    ...(Number.isInteger(step) ? { step } : {}),
  }
}

/**
 * Replaces the estimates of the fixed parts with the provider's counts.
 *
 * `system` is the system prompt as sent and `tools` the tool specs as sent,
 * each counted net of the base message (countFixedTokens). Each count is
 * split across its categories by estimate share, as Claude Code does. The
 * system count is split first between the system prompt with its skills and
 * the project and connector instructions, then the skills part is split from
 * the system prompt by estimate share. The sent connector tool rows take the
 * split of connectorTools; the deferred rows stay estimates, as they are not
 * sent. `overheadInTools` is framing the tools count already holds
 * (Anthropic's preamble), so it comes off the overhead rather than being
 * counted twice.
 */
export function withExactFixed(
  breakdown,
  { system, tools, overheadInTools = 0 }
) {
  const out = { ...breakdown, exactFixed: true }

  const skillsEstimate = out.skills ?? 0
  const systemSplit = allocateByShare(system, [
    out.systemPrompt + skillsEstimate,
    out.projectInstructions,
    out.connectorInstructions,
  ])
  const [promptAndSkills, projectInstructions, connectorInstructions] =
    systemSplit
  const [systemPrompt, skills] = allocateByShare(promptAndSkills, [
    out.systemPrompt,
    skillsEstimate,
  ])
  Object.assign(out, {
    systemPrompt,
    projectInstructions,
    connectorInstructions,
  })
  if (breakdown.skills !== undefined) out.skills = skills

  const toolKeys = [
    'builtinTools',
    'webTools',
    'connectorHelperTools',
    'connectorTools',
  ]
  const toolSplit = allocateByShare(
    tools,
    toolKeys.map(key => out[key] ?? 0)
  )
  toolKeys.forEach((key, i) => {
    out[key] = toolSplit[i]
  })

  if (out.connectorToolDetails) {
    const sent = out.connectorToolDetails.filter(row => !row.deferred)
    const split = allocateByShare(
      out.connectorTools,
      sent.map(row => row.tokens)
    )
    let i = 0
    out.connectorToolDetails = out.connectorToolDetails.map(row =>
      row.deferred ? row : { ...row, tokens: split[i++] }
    )
  }

  out.overhead = Math.max(0, (out.overhead ?? 0) - overheadInTools)
  return out
}

// Exact counts: the provider's own count of the system prompt and the tool
// specs, measured in the background and kept in a small LRU.
export const EXACT_COUNT_TIMEOUT_MS = 5000
const EXACT_CACHE_LIMIT = 16
const exactCache = new Map()

// Puts `key` last in an LRU map, dropping the oldest entry once past `limit`
function rememberLru(map, limit, key, value) {
  map.delete(key)
  map.set(key, value)
  if (map.size > limit) map.delete(map.keys().next().value)
}

function knownExact(key) {
  const counts = exactCache.get(key)
  // Touch: the most recently used entry is the last one in the map
  if (counts) rememberLru(exactCache, EXACT_CACHE_LIMIT, key, counts)
  return counts ?? null
}

/** A count API this long unsupported on its endpoint stays so (see rememberCountFailure). */
export const COUNT_UNSUPPORTED_TTL_MS = 24 * 60 * 60 * 1000
/** A failed count is not asked again for this long, so a busy step is not made slower. */
export const COUNT_FAILURE_TTL_MS = 10 * 60 * 1000
const BASE_COUNT_LIMIT = 32
// (type, baseURL) -> the time until which its count API is not asked
const unsupportedUntil = new Map()
// exact key -> the time until which that count is not asked again
const failedUntil = new Map()
// (type, baseURL, model) -> the provider's count of the base (no system, no tools)
const baseCounts = new Map()

export function clearExactCountCache() {
  exactCache.clear()
  unsupportedUntil.clear()
  failedUntil.clear()
  baseCounts.clear()
}

/**
 * The cache key of a request's fixed parts: the provider, its model and
 * endpoint, the system prompt and the tool specs in their wire shape.
 */
export function exactCountKey({ type, model, baseUrl, system, tools = [] }) {
  const wire = JSON.stringify([
    type,
    model,
    baseUrl,
    system,
    tools.map(tool => toolWireSpec(type, tool)),
  ])
  return createHash('sha256').update(wire).digest('hex')
}

/**
 * True when a count failure says the endpoint has no count API: 404, 405 or
 * 501, or a 400 whose message says the route or model is not found or not
 * supported.
 */
export function isCountUnsupported(err) {
  if ([404, 405, 501].includes(err?.status)) return true
  return (
    err?.status === 400 &&
    /not found|not supported|unsupported/i.test(String(err.message ?? ''))
  )
}

function countEndpointKey(type, baseUrl) {
  return `${type}|${baseUrl}`
}

// Sets a hold-off and drops the expired ones, which lookup treats as absent.
// Each map has one TTL, so re-inserting keeps it in expiry order and the scan
// stops at the first live entry.
function holdOff(map, key, until, now) {
  for (const [held, heldUntil] of map) {
    if (heldUntil > now) break
    map.delete(held)
  }
  map.delete(key)
  map.set(key, until)
}

/**
 * Records why a count failed. An endpoint without a count API is marked
 * unsupported for COUNT_UNSUPPORTED_TTL_MS. Any other failure holds that
 * request's count back for COUNT_FAILURE_TTL_MS. Estimates stand meanwhile.
 */
function rememberCountFailure({ type, baseUrl, key, err, now }) {
  if (isCountUnsupported(err)) {
    holdOff(
      unsupportedUntil,
      countEndpointKey(type, baseUrl),
      now + COUNT_UNSUPPORTED_TTL_MS,
      now
    )
  } else {
    holdOff(failedUntil, key, now + COUNT_FAILURE_TTL_MS, now)
  }
}

/**
 * The provider's counts of the system prompt and of the tool specs. The base
 * (no system, no tools, one word of user turn) is counted once per (type,
 * baseURL, model) and kept; subtracting it removes the framing and the user
 * turn, so no fixed constant is assumed. A new system prompt or tool set then
 * costs one call each: two calls for a new tool set, not three.
 *
 * Throws on any failure or after EXACT_COUNT_TIMEOUT_MS.
 */
export async function countFixedTokens(
  client,
  { type, system = '', tools = [] }
) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), EXACT_COUNT_TIMEOUT_MS)
  timer.unref?.()
  const signal = controller.signal
  try {
    const baseKey = JSON.stringify([type, client.baseURL, client.model])
    const knownBase = baseCounts.get(baseKey)
    // The three counts are independent, so they share the timeout in parallel
    const [base, systemCount, toolsCount] = await Promise.all([
      knownBase !== undefined
        ? knownBase
        : client
            .countTokens({ system: '', tools: [], signal })
            .then(count => {
              rememberLru(baseCounts, BASE_COUNT_LIMIT, baseKey, count)
              return count
            }),
      system ? client.countTokens({ system, tools: [], signal }) : null,
      tools.length ? client.countTokens({ system: '', tools, signal }) : null,
    ])
    const withSystem = system ? systemCount : base
    const withTools = tools.length ? toolsCount : base
    return {
      system: Math.max(0, withSystem - base),
      tools: Math.max(0, withTools - base),
      // Anthropic's count of tools includes its preamble (see
      // fixedOverheadTokens), which the overhead then leaves out
      overheadInTools:
        type === 'anthropic' && tools.length ? ANTHROPIC_TOOL_PREAMBLE_TOKENS : 0,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The exact-count side of one run. `lookup` returns { key, counts } for the
 * parts it is given: counts from the cache when they are known, else null,
 * with a measure started in the background. When that measure lands and its
 * key is still the one asked for, `onReady(counts, key)` runs, so the run can
 * emit the breakdown again. It never waits, and a failure is only reported
 * to `onError`. A client without a count API, or an endpoint marked
 * unsupported or a key in its failure hold-off (see rememberCountFailure),
 * gets null from lookup.
 */
export function createExactCounter({ client, type, onReady, onError }) {
  const supported =
    typeof client?.countTokens === 'function' &&
    client.exactCountsSupported === true
  let inFlight = null
  return {
    supported,
    lookup({ system, tools }) {
      if (!supported) return null
      const key = exactCountKey({
        type,
        model: client.model,
        baseUrl: client.baseURL,
        system,
        tools,
      })
      const known = knownExact(key)
      if (known) return { key, counts: known }
      const now = Date.now()
      if ((unsupportedUntil.get(countEndpointKey(type, client.baseURL)) ?? 0) > now) {
        return null
      }
      if ((failedUntil.get(key) ?? 0) > now) return null
      if (inFlight !== key) {
        inFlight = key
        countFixedTokens(client, { type, system, tools }).then(
          counts => {
            rememberLru(exactCache, EXACT_CACHE_LIMIT, key, counts)
            if (inFlight === key) {
              inFlight = null
              onReady?.(counts, key)
            }
          },
          err => {
            if (inFlight === key) inFlight = null
            rememberCountFailure({
              type,
              baseUrl: client.baseURL,
              key,
              err,
              now: Date.now(),
            })
            onError?.(err)
          }
        )
      }
      return { key, counts: null }
    },
  }
}
