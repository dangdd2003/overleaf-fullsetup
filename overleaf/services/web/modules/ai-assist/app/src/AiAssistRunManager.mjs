import crypto from 'node:crypto'
import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import './ModuleSettings.mjs'
import defaultStore from './AiAssistRunStore.mjs'
import defaultTools from './AiAssistTools.mjs'
import defaultChatHistoryStore, {
  hydrateTranscript,
} from './AiAssistChatHistoryStore.mjs'
import { generateChatTitle } from './AiAssistChatTitler.mjs'
import { createProviderClient } from './AiAssistProviders.mjs'
import { renderToolResult, withNotice } from './AiAssistToolRender.mjs'
import { systemBlocksFor, joinSystemBlocks, systemPromptFor } from './AiAssistSystemPrompt.mjs'
import { coerceToolArgs } from './AiAssistToolSchema.mjs'
import { AiAssistWebTools, WEB_TOOL_NAMES } from './AiAssistWebTools.mjs'
import { cacheKeyFor } from './web-fetch/urls.mjs'
import {
  decide,
  toolSpecsFor,
  normalizeMode,
  modeLabel,
  FILE_EDIT_TOOLS,
  READ_ONLY_TOOLS,
  SETTINGS_TOOLS,
  PLAN_TOOL,
} from './AiAssistModePolicy.mjs'

/**
 * Follows a message the user sent while a run was going, so the model deals
 * with it and then finishes what it was doing rather than dropping it. Claude
 * Code frames a queued message the same way. It belongs to the stored turn
 * (see userTurnContent), so a rebuilt transcript gives the same bytes.
 */
export const SENT_DURING_RUN_NOTE =
  '[Sent while you were working. Address this, then carry on with the rest of the task unless it says otherwise.]'

/**
 * The text of a user turn, as the provider is sent it. The live run and a
 * transcript rebuilt for the next run both use this, so the same turn gives
 * the same bytes and the provider's cached prefix survives.
 */
export function userTurnContent(entry) {
  const text = entry?.text || entry?.content || ''
  const body = entry?.sentDuringRun
    ? `${text}\n\n${SENT_DURING_RUN_NOTE}`
    : text
  return entry?.contextText ? `${entry.contextText}\n\n${body}` : body
}

/**
 * The provider requests an assistant entry was made of, in order.
 *
 * The panel keeps a whole run in one assistant entry, but the run sent one
 * assistant message per request, each followed by its own tool results.
 * Rebuilt as one message holding every call, the next run's prefix would stop
 * matching the cached one at the run's second request. Calls record the
 * request they came from (`step`) and the blocks keep text and calls in
 * order, so the entry splits back into what was sent. Entries stored before
 * calls carried a step rebuild as one message, the same bytes as before.
 */
export function modelSteps(entry) {
  const calls = Array.isArray(entry.toolCalls) ? entry.toolCalls : []
  const whole = [{ text: entry.text || entry.content || '', calls }]
  const blocks = Array.isArray(entry.blocks) ? entry.blocks : []
  if (
    calls.length === 0 ||
    blocks.length === 0 ||
    !calls.every(call => Number.isInteger(call?.step))
  ) {
    return whole
  }

  const unplaced = new Map(calls.map(call => [call.id, call]))
  const steps = []
  let current = null
  for (const block of blocks) {
    if (block?.type === 'tool_call') {
      const call = unplaced.get(block.call?.id)
      if (!call) return whole
      unplaced.delete(call.id)
      if (
        !current ||
        (current.calls.length > 0 && current.calls[0].step !== call.step)
      ) {
        current = { text: '', calls: [] }
        steps.push(current)
      }
      current.calls.push(call)
    } else if (block?.type === 'text' || block?.type === 'thinking') {
      // A request streams its text before its calls, so text or thinking
      // after a call belongs to the next request
      if (!current || current.calls.length > 0) {
        current = { text: '', calls: [] }
        steps.push(current)
      }
      if (block.type === 'text') current.text += block.text || ''
    }
  }
  if (unplaced.size > 0) return whole
  return steps.filter(step => step.calls.length > 0 || step.text)
}

/**
 * The messages a transcript stands for, byte for byte what its runs sent:
 * user turns through userTurnContent and assistant entries split back into
 * their requests by modelSteps. The chat's history is the only record of a
 * conversation, as Claude Code's session log is, so every run rebuilds from
 * it and its first request reads the whole conversation from the cache.
 */
export function toAgentMessages(transcript) {
  const messages = []
  if (!Array.isArray(transcript)) return messages

  transcript.forEach(entry => {
    if (entry.role === 'user') {
      messages.push({ role: 'user', content: userTurnContent(entry) })
      return
    }

    // Where the run asked for a reply it did not get (FINAL_REPLY_NUDGE):
    // after the results of this call, or at the start of the entry
    const nudgeAfter = entry.nudge ? (entry.nudge.after ?? null) : undefined
    if (nudgeAfter === null) {
      messages.push({ role: 'user', content: FINAL_REPLY_NUDGE })
    }

    if (!entry.toolCalls || entry.toolCalls.length === 0) {
      // A request that produced no text added nothing to the run's messages,
      // so it adds nothing here either
      const content = entry.text || entry.content || ''
      if (content) messages.push({ role: 'assistant', content })
      return
    }

    for (const step of modelSteps(entry)) {
      if (step.calls.length === 0) {
        messages.push({ role: 'assistant', content: step.text })
        continue
      }

      messages.push({
        role: 'assistant',
        content: step.text,
        toolCalls: step.calls.map(call => ({
          id: call.id,
          name: call.name,
          args: call.args,
        })),
      })

      for (const call of step.calls) {
        const finished = 'result' in call
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          // Rendered as the run rendered it, strings included
          content: finished
            ? renderToolResult(call.name, call.result)
            : 'This tool call did not complete.',
          isError: finished
            ? toolMessageIsError(call.result, call.isError)
            : true,
        })
      }
      if (nudgeAfter && step.calls.some(call => call.id === nudgeAfter)) {
        messages.push({ role: 'user', content: FINAL_REPLY_NUDGE })
      }
    }
  })

  return messages
}

/** Identifies a message, to check a recorded trim still fits the messages. */
function messageFingerprint(message) {
  return crypto
    .createHash('sha1')
    .update(
      [
        message?.role ?? '',
        message?.toolCallId ?? '',
        (message?.toolCalls ?? []).map(call => call.id).join(','),
        typeof message?.content === 'string'
          ? message.content
          : JSON.stringify(message?.content ?? ''),
      ].join('\u0000')
    )
    .digest('base64')
}

/** The trim the chat's runs last recorded (see applyContextTrim). */
export function latestContextTrim(transcript) {
  if (!Array.isArray(transcript)) return null
  for (let i = transcript.length - 1; i >= 0; i--) {
    const trim = transcript[i]?.contextTrim
    if (trim && typeof trim === 'object') return trim
  }
  return null
}

/**
 * Cuts a rebuilt conversation the way the context budget had cut it when the
 * last run sent it.
 *
 * A run that trims keeps the trimmed messages and only appends to them, but a
 * new run rebuilds the whole chat and would trim it afresh, further than
 * before, rewriting messages the provider has cached. Claude Code keeps its
 * compacted history in the session log for the same reason. A trim is
 * recorded in positions on the whole conversation: how many messages were
 * dropped from the front, which were elided, and the last message at the
 * time, which has to match for the positions to be trusted.
 *
 * Returns { messages, trim }, trim being null when it was not applied.
 */
export function applyContextTrim(messages, trim) {
  const none = { messages, trim: null }
  if (!trim || typeof trim !== 'object') return none
  const total = Number(trim.total)
  if (
    !Number.isInteger(total) ||
    total < 1 ||
    total > messages.length ||
    messageFingerprint(messages[total - 1]) !== trim.anchor
  ) {
    return none
  }
  const dropped = Number.isInteger(trim.dropped) ? trim.dropped : 0
  // Only ever at the start of a turn, as the budget drops them
  if (dropped < 0 || dropped >= total || messages[dropped]?.role !== 'user') {
    return none
  }
  const elided = new Set(
    (Array.isArray(trim.elided) ? trim.elided : []).filter(
      index => Number.isInteger(index) && index >= dropped && index < total
    )
  )
  const cut = messages.slice(dropped).map((message, offset) => {
    if (!elided.has(dropped + offset)) return message
    if (message.role === 'tool') {
      return isElided(message) ? message : stubToolMessage(message)
    }
    if (message.role === 'assistant' && message.content) {
      return { ...message, content: ASSISTANT_ELISION_MARKER }
    }
    return message
  })
  return {
    messages: cut,
    trim: { total, anchor: trim.anchor, dropped, elided: [...elided] },
  }
}

/**
 * Adds what one applyContextBudget call cut to the trim recorded so far.
 * `before` is the list it was given, `after` what it returned; both start at
 * position `trim.dropped` on the whole conversation.
 */
export function recordContextTrim(trim, before, after) {
  const base = trim?.dropped ?? 0
  const cut = before.length - after.length
  const elided = new Set(trim?.elided ?? [])
  let changed = cut > 0
  after.forEach((message, index) => {
    if (message !== before[index + cut]) {
      elided.add(base + cut + index)
      changed = true
    }
  })
  if (!changed || before.length === 0) return trim
  const dropped = base + cut
  return {
    total: base + before.length,
    anchor: messageFingerprint(before[before.length - 1]),
    dropped,
    elided: [...elided].filter(index => index >= dropped).sort((a, b) => a - b),
  }
}

const MAX_COMPILE_ENTRIES = 200
const MAX_COMPILE_LOG_CHARS = 2_000_000

/** Keeps only the fields a compile outcome has; it arrives from the browser. */
export function sanitizeCompileOutcome(outcome) {
  const entries = list =>
    (Array.isArray(list) ? list : []).slice(0, MAX_COMPILE_ENTRIES).map(e => {
      const entry = {
        file: typeof e?.file === 'string' ? e.file : null,
        line: Number.isInteger(e?.line) ? e.line : null,
        message: typeof e?.message === 'string' ? e.message : '',
      }
      if (typeof e?.excerpt === 'string') entry.excerpt = e.excerpt
      return entry
    })
  return {
    status: typeof outcome?.status === 'string' ? outcome.status : 'failure',
    errors: entries(outcome?.errors),
    warnings: entries(outcome?.warnings),
    rawLog:
      typeof outcome?.rawLog === 'string'
        ? outcome.rawLog.slice(-MAX_COMPILE_LOG_CHARS)
        : '',
  }
}

export const KEEP_RECENT_TOOL_RESULTS = 3
export const KEEP_RECENT_ASSISTANT_TURNS = 3
export const CHARS_PER_TOKEN = 4
export const MARGIN_FRACTION = 0.1
export const ASSISTANT_ELISION_MARKER = '[earlier reply elided]'
// Once trimming is needed, trim to this fraction of the budget instead of to
// just under it. See applyContextBudget.
export const TRIM_TARGET_FRACTION = 0.7

// Re-export mode policy constants for backward compatibility
export { FILE_EDIT_TOOLS, READ_ONLY_TOOLS }

// The same failing call, arguments and all: the second failure carries a
// warning in its result, the third ends the run.
/**
 * Sent once, as a user turn, when the model runs tools and then closes the run
 * with an empty reply. Without it the panel shows a row of tool cards and
 * nothing else, which reads as the assistant having ignored the request.
 * Mirrors FINAL_REPLY_NUDGE in run-agent.ts.
 */
export const FINAL_REPLY_NUDGE =
  'You ended the turn without replying, so nothing was shown to the user except the tool calls. Write the reply now, in one to three sentences: what you did or found, in which files, and anything they need to know. Do not call any more tools.'

/**
 * Normalises a message the user sent while the run was already going.
 *
 * `content` is assembled by userTurnContent, as toAgentMessages assembles the
 * stored turn the panel keeps for it, so the next run rebuilds the bytes this
 * run sent. Nothing is cut here for the same reason; the controller refuses a
 * message that is too large instead.
 */
export function toQueuedMessage(message, index = 0) {
  const text = typeof message?.text === 'string' ? message.text : ''
  const contextText =
    typeof message?.contextText === 'string' ? message.contextText : ''
  return {
    id:
      typeof message?.id === 'string' && message.id
        ? message.id
        : `queued_${Date.now()}_${index}`,
    text,
    contextText,
    content: userTurnContent({ text, contextText, sentDuringRun: true }),
  }
}

export const IDENTICAL_FAILURE_LIMIT = 3
// Model turns in a row in which every tool call failed. Counted per turn, not
// per call: one reply with three parallel guesses that all miss is one wrong
// decision, not three.
export const FAILED_TURN_LIMIT = 4
// Web calls for one instruction after which the model is told, once, to answer
// with what it has. Nothing is blocked: a hard question may need more.
export const WEB_CALL_NUDGE = 8

/** The document a web_fetch call reads, however the model spelled its URL. */
function fetchedPageKey(args) {
  const raw = typeof args?.url === 'string' ? args.url.trim() : ''
  if (!raw) return ''
  return cacheKeyFor(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`)
}

export function estimateTokens(text) {
  return Math.ceil(
    (text && typeof text === 'string' ? text : '').length / CHARS_PER_TOKEN
  )
}

export function estimateMessageTokens(message) {
  let count = estimateTokens(message.content)
  if (message.role === 'assistant' && message.toolCalls?.length) {
    count += estimateTokens(JSON.stringify(message.toolCalls))
  }
  return count
}

export function estimateMessagesTokens(system, messages, tools = []) {
  let total = estimateTokens(system)
  for (const m of messages) {
    total += estimateMessageTokens(m)
  }
  if (tools.length) {
    total += estimateTokens(JSON.stringify(tools))
  }
  return total
}

/**
 * Whether a tool message tells the provider the call failed. The live run and
 * a transcript rebuilt on the next run both use this, so the same call gives
 * the same bytes and the cached prefix survives.
 */
export function toolMessageIsError(result, isError) {
  return Boolean(
    (isError && result?.status !== 'denied') ||
      result?.error ||
      result?.status === 'noMatch' ||
      result?.status === 'ambiguous'
  )
}

export function isElided(message) {
  if (message.role !== 'tool') return false
  try {
    return JSON.parse(message.content)?.elided === true
  } catch {
    return false
  }
}

export const KNOWN_TOOLS = new Set([
  'edit_file',
  'create_file',
  'read_file',
  'search_text',
  'compile_project',
  'get_compile_result',
  'get_outline',
  'get_packages',
  'get_references',
  'get_project_settings',
  'configure_compiler_settings',
  'configure_appearance_settings',
  'configure_editor_settings',
  'list_available_settings',
])

export function extractTextToolCall(text, toolSpecs = []) {
  if (!text || typeof text !== 'string') return null
  const validTools = toolSpecs?.length
    ? new Set(toolSpecs.map(t => t.name))
    : KNOWN_TOOLS

  // 1. Fenced JSON block: ```json\n{ "name": "...", "arguments": { ... } }\n```
  const fenceMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i)
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim())
      const name = parsed.name || parsed.tool
      let args = parsed.arguments ?? parsed.parameters ?? parsed.args
      if (!args && parsed.name) {
        const copy = { ...parsed }
        delete copy.name
        delete copy.tool
        args = copy
      }
      if (
        name &&
        validTools.has(name) &&
        typeof args === 'object' &&
        args !== null
      ) {
        return {
          call: { id: `call_txt_${Date.now()}`, name, args },
          prose: text.slice(0, fenceMatch.index).trim(),
        }
      }
    } catch {}
  }

  // 2. <tool_call> or <function=name> XML tags used by open-source models
  const tagMatch = text.match(
    /<(?:tool_call|function(?:=([^>]+))?)>([\s\S]*?)<\/(?:tool_call|function)>/i
  )
  if (tagMatch) {
    try {
      const explicitName = tagMatch[1]?.trim()
      const body = JSON.parse(tagMatch[2].trim())
      const name = explicitName || body.name || body.tool
      let args = body.arguments ?? body.parameters ?? body.args
      if (!args && (body.name || body.tool)) {
        const copy = { ...body }
        delete copy.name
        delete copy.tool
        args = copy
      }
      if (
        name &&
        validTools.has(name) &&
        typeof args === 'object' &&
        args !== null
      ) {
        return {
          call: { id: `call_txt_${Date.now()}`, name, args },
          prose: text.slice(0, tagMatch.index).trim(),
        }
      }
    } catch {}
  }

  // 3. Whole message is bare JSON
  const trimmed = text.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed)
      const name = parsed.name || parsed.tool
      let args = parsed.arguments ?? parsed.parameters ?? parsed.args
      if (!args && (parsed.name || parsed.tool)) {
        const copy = { ...parsed }
        delete copy.name
        delete copy.tool
        args = copy
      }
      if (
        name &&
        validTools.has(name) &&
        typeof args === 'object' &&
        args !== null
      ) {
        return {
          call: { id: `call_txt_${Date.now()}`, name, args },
          prose: '',
        }
      }
    } catch {}
  }

  return null
}

export function stubToolMessage(message) {
  return {
    ...message,
    content: JSON.stringify({
      elided: true,
      summary: `${message.name || 'tool'} result — content elided to fit the context window. Call ${message.name || 'the tool'} again if you need it.`,
    }),
  }
}

export function applyContextBudget({ system, messages, limits, tools = [] }) {
  const contextWindow = limits?.contextWindow ?? 200000
  const maxOutputTokens = limits?.maxOutputTokens ?? 32000
  const rawBudget =
    contextWindow - maxOutputTokens - Math.ceil(contextWindow * MARGIN_FRACTION)

  if (rawBudget <= 0) {
    return { messages: [...messages], exhausted: true }
  }

  const working = [...messages]
  // Per-message estimates kept in step with `working`, so a trim updates the
  // total instead of re-serialising the whole conversation.
  const sizes = working.map(estimateMessageTokens)
  let total =
    estimateTokens(system) +
    (tools.length ? estimateTokens(JSON.stringify(tools)) : 0) +
    sizes.reduce((sum, size) => sum + size, 0)

  if (total <= rawBudget) {
    return { messages: working, exhausted: false }
  }

  // Trimming rewrites the prompt prefix, which throws away the provider's
  // prompt cache from that point on. Trim well below the limit in one go, so
  // the next several steps append to a stable prefix instead of each step
  // eliding one more result and missing the cache every time.
  const target = Math.floor(rawBudget * TRIM_TARGET_FRACTION)

  const replace = (index, message) => {
    const size = estimateMessageTokens(message)
    total += size - sizes[index]
    sizes[index] = size
    working[index] = message
  }

  // Pass 1: Elide older tool results (keep latest KEEP_RECENT_TOOL_RESULTS)
  const toolIndices = working
    .map((m, idx) => ({ m, idx }))
    .filter(({ m }) => m.role === 'tool')
    .map(({ idx }) => idx)

  const elidableTools = toolIndices.slice(
    0,
    Math.max(0, toolIndices.length - KEEP_RECENT_TOOL_RESULTS)
  )

  for (const idx of elidableTools) {
    const msg = working[idx]
    if (isElided(msg)) continue
    const stub = stubToolMessage(msg)
    if (estimateTokens(stub.content) >= sizes[idx]) continue
    replace(idx, stub)
    if (total <= target) return { messages: working, exhausted: false }
  }

  // Pass 2: Elide older assistant prose (keep latest KEEP_RECENT_ASSISTANT_TURNS)
  const assistantIndices = working
    .map((m, idx) => ({ m, idx }))
    .filter(({ m }) => m.role === 'assistant' && m.content)
    .map(({ idx }) => idx)

  const elidableAssistants = assistantIndices.slice(
    0,
    Math.max(0, assistantIndices.length - KEEP_RECENT_ASSISTANT_TURNS)
  )

  for (const idx of elidableAssistants) {
    const msg = working[idx]
    if (estimateTokens(ASSISTANT_ELISION_MARKER) >= estimateTokens(msg.content))
      continue
    replace(idx, { ...msg, content: ASSISTANT_ELISION_MARKER })
    if (total <= target) return { messages: working, exhausted: false }
  }

  // Pass 3: drop whole turns from the front, only when eliding could not get
  // under the budget, and then down to the target. A turn runs from a user
  // message up to the next one. Cutting inside a turn leaves an assistant
  // message or a tool result without the message it answers, which providers
  // reject with a 400. If only one turn is left and it still does not fit,
  // report exhaustion.
  if (total > rawBudget) {
    while (total > target) {
      const nextUser = working.findIndex(
        (message, index) => index > 0 && message.role === 'user'
      )
      if (nextUser === -1) break
      working.splice(0, nextUser)
      total -= sizes.splice(0, nextUser).reduce((sum, size) => sum + size, 0)
    }
  }

  return {
    messages: working,
    exhausted: total > rawBudget,
  }
}

/**
 * Finds the tool calls that must not run, and strips the provider parser's
 * markers from every call's arguments.
 *
 * A call is incomplete when the reply was cut off at the output limit inside
 * it (always the last call of a cut-off reply), when its arguments were not
 * valid JSON, or when a file change's arguments only parsed after repair.
 * Running it would act on half an argument, e.g. write a cut-off newText into
 * the document. Its arguments are reduced to the path, so a long cut-off text
 * is not re-sent on every later request.
 *
 * Complete calls also have their arguments coerced to the types the tool
 * declares, so a model that emits `"True"` for a boolean is not failed over a
 * call that was otherwise correct.
 *
 * Returns a Map from each incomplete call to 'cutOff' or 'invalid'.
 */
export function classifyIncompleteCalls(calls, truncated, toolSpecs = []) {
  const specsByName = new Map(
    (toolSpecs ?? []).filter(spec => spec?.name).map(spec => [spec.name, spec])
  )
  const incomplete = new Map()
  calls.forEach((call, index) => {
    const args =
      call.args && typeof call.args === 'object' && !Array.isArray(call.args)
        ? { ...call.args }
        : {}
    const parseError = Boolean(args._parseError)
    const repaired = Boolean(args._repaired)
    delete args._parseError
    delete args._raw
    delete args._repaired
    const cutOff = truncated && index === calls.length - 1
    if (cutOff || parseError || (repaired && FILE_EDIT_TOOLS.has(call.name))) {
      incomplete.set(call, cutOff || repaired ? 'cutOff' : 'invalid')
      call.args = typeof args.path === 'string' ? { path: args.path } : {}
    } else {
      call.args = coerceToolArgs(args, specsByName.get(call.name)?.parameters)
    }
  })
  return incomplete
}

export function incompleteCallError(call, reason, maxTokens) {
  return reason === 'cutOff'
    ? `This ${call.name} call was cut off at the ${maxTokens}-token output limit, so its arguments are incomplete and it was not run. Make the change in smaller pieces: replace a smaller line range per edit_file call, or create the file with part of its content and add the rest with edit_file.`
    : `The arguments of this ${call.name} call were not valid JSON, so it was not run. Send the call again with complete arguments.`
}

// Used when the provider settings do not set a context window or output limit
const DEFAULT_LIMITS = {
  openai: { contextWindow: 200000, maxOutputTokens: 32000 },
  anthropic: { contextWindow: 200000, maxOutputTokens: 32000 },
  google: { contextWindow: 1000000, maxOutputTokens: 65536 },
  ollama: { contextWindow: 256000, maxOutputTokens: 65536 },
}

// Hosted providers shed load with 5xx errors and dropped streams for tens of
// seconds at a time, so a step keeps retrying for about a minute (2s, 4s, 8s,
// 16s, 20s) before the run gives up.
const MAX_STREAM_ATTEMPTS = 6
const NON_RETRYABLE_STATUSES = new Set([400, 401, 403, 404])
const NON_RETRYABLE_CODES = new Set([
  'providerAuth',
  'invalidProviderUrl',
  'restrictedProviderUrl',
  'contextExhausted',
])

// Cycle detection compares the last four calls, so no more are kept
const CYCLE_WINDOW = 4

export class AiAssistRunManager {
  constructor({
    store = defaultStore,
    tools = defaultTools,
    clientFactory = createProviderClient,
    chatHistoryStore = defaultChatHistoryStore,
    approvalTimeoutMs = null,
    compileTimeoutMs = null,
    webToolsFactory = (settings, { userId, contextWindow } = {}) =>
      new AiAssistWebTools(settings, {
        cacheOwner: userId,
        contextWindow,
        prefetch: Settings.aiAssist?.webPrefetchResults,
      }),
  } = {}) {
    this.store = store
    this.tools = tools
    this.webToolsFactory = webToolsFactory
    this.clientFactory = clientFactory
    this.chatHistoryStore = chatHistoryStore
    this.activeRuns = new Map()
    this.control = null
    this.approvalTimeoutMs =
      approvalTimeoutMs ??
      (Settings.aiAssist?.approvalTimeoutSeconds ?? 600) * 1000
    // Longer than the editor's own budget (wait for a running build, then the
    // compile, then the log), so the editor reports its timeout first.
    this.compileTimeoutMs = compileTimeoutMs ?? 360_000
  }

  attachControl(control) {
    this.control = control
  }

  /**
   * The panel's transcript, with what its local copy lost restored from the
   * chat's history on disk (see hydrateTranscript). Never fails a run.
   */
  async _withStoredHistory(projectId, userId, chatId, transcript) {
    if (!chatId || !userId || !this.chatHistoryStore?.getChat) {
      return transcript
    }
    try {
      const chat = await this.chatHistoryStore.getChat(
        projectId,
        userId,
        chatId
      )
      return hydrateTranscript(transcript, chat?.transcript)
    } catch (err) {
      logger.warn({ err, projectId, chatId }, '[AiAssist] chat history not read')
      return transcript
    }
  }

  /** The project's AGENTS.md, or null. Never fails a run. */
  async _projectInstructions(projectId) {
    if (typeof this.tools?.getProjectInstructions !== 'function') return null
    try {
      return await this.tools.getProjectInstructions(projectId)
    } catch (err) {
      logger.warn({ err, projectId }, '[AiAssist] AGENTS.md not loaded')
      return null
    }
  }

  async startRun({
    runId,
    projectId,
    userId,
    transcript,
    providerSettings,
    mode = 'manual',
    chatId = null,
    webSearchSettings = null,
  }) {
    const controller = new AbortController()
    const approvalPromiseResolvers = { resolve: null }
    const compileResolvers = new Map()
    const initialMode = normalizeMode(mode)
    // Messages the user sent while this run was already going. Drained at the
    // top of the loop, which is the only point at which the model is between
    // requests and a new user turn can be added without splitting a turn.
    const queuedMessages = []

    const activeRun = {
      controller,
      projectId,
      userId,
      mode: initialMode,
      approvalResolver: approvalPromiseResolvers,
      compileResolvers,
      queuedMessages,
      acceptsMessages: true,
    }
    this.activeRuns.set(runId, activeRun)
    // Called, with no await before it, once the loop has looked at the queue
    // for the last time. A message arriving after that would never be read,
    // so it is refused instead and the panel starts a run of its own for it.
    const closeQueue = () => {
      activeRun.acceptsMessages = false
    }

    await this.store.createRun({ runId, projectId, userId, mode: initialMode })

    const client = this.clientFactory(providerSettings)
    const limits =
      DEFAULT_LIMITS[providerSettings?.type] ?? DEFAULT_LIMITS.openai
    const maxTokens =
      Number(providerSettings?.maxOutputTokens) > 0
        ? Number(providerSettings.maxOutputTokens)
        : limits.maxOutputTokens
    const resolvedLimits = {
      ...limits,
      maxOutputTokens: maxTokens,
      contextWindow:
        Number(providerSettings?.contextWindow) > 0
          ? Number(providerSettings.contextWindow)
          : limits.contextWindow,
    }
    // Only runs whose user configured web search get the web tools, and the
    // prompt section describing them. Fetched pages are cut to fit the model.
    const webTools = webSearchSettings
      ? this.webToolsFactory(webSearchSettings, {
          userId,
          contextWindow: resolvedLimits.contextWindow,
        })
      : null
    transcript = await this._withStoredHistory(
      projectId,
      userId,
      chatId,
      transcript
    )
    // Sources cited in earlier turns keep their numbers in this one
    webTools?.rememberSources?.(transcript)

    // Rebuilt byte for byte from the chat's history, cut where the last run
    // had cut it, so this run's first request reads the whole conversation
    // from the cache. From here on the run only appends to `messages`,
    // keeping every earlier request a prefix of the next.
    const rebuilt = applyContextTrim(
      toAgentMessages(transcript),
      latestContextTrim(transcript)
    )
    let messages = rebuilt.messages
    let contextTrim = rebuilt.trim

    // Streamed text and thinking are buffered and written in batches: every
    // appendEvent is INCR + RPUSH + PUBLISH, and the provider stream is not
    // read again until the write resolves. Only one kind is buffered at a
    // time, so a switch between thinking and text flushes first and order
    // is preserved.
    let pendingType = null
    let pendingText = ''
    let flushTimer = null
    let flushChain = Promise.resolve()
    const FLUSH_MS = 16
    const FLUSH_CHARS = 8

    const write = event => {
      flushChain = flushChain.then(() => this.store.appendEvent(runId, event))
      return flushChain
    }

    const flushText = () => {
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      if (!pendingText) return Promise.resolve()
      const chunk = pendingText
      const type = pendingType
      pendingText = ''
      pendingType = null
      return write({ type, text: chunk })
    }

    const armTimer = () => {
      if (flushTimer) return
      flushTimer = setTimeout(() => {
        flushTimer = null
        void flushText().catch(() => {})
      }, FLUSH_MS)
      flushTimer.unref?.()
    }

    const emitChunk = async (type, text) => {
      if (!text) return
      if (pendingType && pendingType !== type) {
        await flushText()
      }
      pendingType = type
      pendingText += text
      if (pendingText.length >= FLUSH_CHARS) {
        await flushText()
        return
      }
      armTimer()
    }

    const emitEvent = async event => {
      await flushText()
      await write(event)
    }

    // Asynchronously auto-generate the chat title directly from the first prompt (like Claude AI).
    // The first prompt shows the full scheme of the chat; this reorganizes it into a concise title
    // and emits it immediately so the session name updates right away.
    if (chatId && userId && projectId) {
      const firstUser = transcript.find(
        e => e?.role === 'user' && typeof e.text === 'string' && e.text.trim()
      )
      if (firstUser) {
        void (async () => {
          try {
            const existing = await this.chatHistoryStore.getChat(
              projectId,
              userId,
              chatId
            )
            if (existing?.titleGenerated) return

            // A title is a few words; it runs at the provider's default effort
            const titlingClient = this.clientFactory({
              ...providerSettings,
              reasoningEffort: undefined,
              thinking: undefined,
            })
            const generatedTitle = await generateChatTitle({
              client: titlingClient,
              firstMessageText: firstUser.text,
              signal: controller.signal,
            })

            if (generatedTitle && !controller.signal.aborted) {
              await this.chatHistoryStore.saveChatTitle(
                projectId,
                userId,
                chatId,
                generatedTitle,
                true
              )
              await emitEvent({
                type: 'chatTitle',
                chatId,
                title: generatedTitle,
              })
            }
          } catch (err) {
            logger.warn({ err, chatId }, '[AiAssist] Title generation error')
          }
        })()
      }
    }

    // Asks the editor watching this run to compile, through the same compiler
    // as its Recompile button, and waits for the outcome. Resolves null when no
    // editor is watching, so the tool can compile on the server instead.
    const compileInEditor = async ({ id, clean }) => {
      if (!this.store.getWatcherCount) return null
      if ((await this.store.getWatcherCount(runId)) === 0) return null
      const requestId =
        id || `compile_${Date.now()}_${Math.random().toString(36).slice(2)}`

      await emitEvent({
        type: 'awaitingCompile',
        id: requestId,
        clean: Boolean(clean),
      })
      await this.store.touchHeartbeat?.(runId, 0)

      const outcome = await new Promise(resolve => {
        let settled = false
        let timer = null
        let onAbort = null
        const settle = value => {
          if (settled) return
          settled = true
          if (timer) clearTimeout(timer)
          controller.signal.removeEventListener('abort', onAbort)
          compileResolvers.delete(requestId)
          resolve(value)
        }
        compileResolvers.set(requestId, settle)
        timer = setTimeout(
          () => settle({ status: 'timedout', errors: [], warnings: [] }),
          this.compileTimeoutMs
        )
        timer.unref?.()
        onAbort = () => settle({ status: 'timedout', errors: [], warnings: [] })
        if (controller.signal.aborted) onAbort()
        else controller.signal.addEventListener('abort', onAbort)
      })
      await this.store.touchHeartbeat?.(runId, 0)
      return outcome
    }
    const toolContext = call => ({
      projectId,
      userId,
      callId: call.id,
      compileInEditor,
    })
    const runTool = call =>
      webTools && WEB_TOOL_NAMES.has(call.name)
        ? webTools.execute(call.name, call.args, { signal: controller.signal })
        : this.tools.execute(call.name, call.args, toolContext(call))

    const awaitUserApproval = async approvalData => {
      await this.store.setPendingApproval(runId, approvalData)
      await emitEvent({
        type: 'awaitingApproval',
        ...approvalData,
      })

      let timer = null
      let onAbort = null
      let settled = false

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        if (onAbort) {
          controller.signal.removeEventListener('abort', onAbort)
          onAbort = null
        }
        approvalPromiseResolvers.resolve = null
      }

      await this.store.touchHeartbeat?.(runId, 0)
      const decision = await new Promise(resolve => {
        const settle = value => {
          if (settled) return
          settled = true
          cleanup()
          resolve(value)
        }
        approvalPromiseResolvers.resolve = settle
        timer = setTimeout(
          () => settle({ accepted: false, note: 'Approval timed out' }),
          this.approvalTimeoutMs
        )
        timer.unref?.()
        onAbort = () => settle({ accepted: false, note: 'Run stopped' })
        if (controller.signal.aborted) onAbort()
        else controller.signal.addEventListener('abort', onAbort)
      })
      await this.store.touchHeartbeat?.(runId, 0)
      return decision
    }

    try {
      let steps = 0
      let failedTurns = 0
      const failedCallSignatures = new Map()
      const recentCallSignatures = []
      let webCalls = 0
      // Documents web_fetch has read this run: more pages or a find of one
      // come from the cache, so they do not count towards WEB_CALL_NUDGE
      const fetchedPages = new Set()
      let shouldStop = false
      let userDeclinedEdit = false
      // The user reads the reply, not the tool cards. A model that spends the
      // turn on tools and then returns an empty final turn has told them
      // nothing, so ask once for the reply before ending the run.
      let toolsRanThisRun = false
      let finalReplyNudged = false
      const executedTools = []
      // The tools and the system prompt start every request, ahead of the
      // conversation, so they are settled once for the run and sent the same
      // way at every step: the same in every mode (see toolSpecsFor), and
      // AGENTS.md read once, as Claude Code reads CLAUDE.md once a session.
      // An edit to it, or a search backend dropping out, applies from the
      // next run instead of throwing away the cached conversation mid-run.
      const modeToolSpecs = toolSpecsFor(initialMode, [
        ...(this.tools?.getToolSpecs ? this.tools.getToolSpecs() : []),
        ...(webTools ? webTools.getToolSpecs() : []),
      ])
      const systemBlocks = systemBlocksFor(initialMode, {
        webTools: Boolean(webTools),
        webSearch: webTools?.canSearch ? webTools.canSearch() : Boolean(webTools),
        projectInstructions: await this._projectInstructions(projectId),
      })
      const currentSystemPrompt = joinSystemBlocks(systemBlocks)

      // Which provider request a tool call came from, so the stored
      // transcript can be split back into the messages sent (modelSteps)
      let modelStep = 0

      const finishWithError = async (code, message) => {
        closeQueue()
        await emitEvent({ type: 'error', code, message })
        await emitEvent({ type: 'turnFinished', reason: 'stop' })
        await this.store.updateStatus(runId, 'done')
        shouldStop = true
      }

      while (true) {
        if (controller.signal.aborted || shouldStop) break

        // Anything the user typed while the model was busy goes in here, before
        // the next request is built. A new instruction also resets the run's
        // guard rails: the decline block, the repeat-failure counters and the
        // reply nudge were all reasoning about the previous instruction.
        if (queuedMessages.length > 0) {
          await flushText().catch(() => {})
          const injected = queuedMessages.splice(0, queuedMessages.length)
          for (const queued of injected) {
            // Appended after the tool results, never inserted earlier: the
            // prefix the provider cached is untouched.
            messages.push({ role: 'user', content: queued.content })
            // Everything a tab needs to store the turn byte for byte, even
            // one that never saw it sent
            await emitEvent({
              type: 'userMessage',
              id: queued.id,
              text: queued.text,
              ...(queued.contextText
                ? { contextText: queued.contextText }
                : {}),
            })
          }
          userDeclinedEdit = false
          finalReplyNudged = false
          failedTurns = 0
          failedCallSignatures.clear()
          recentCallSignatures.length = 0
          webCalls = 0
        }

        const calls = []
        let text = ''
        let truncated = false

        const budgeted = applyContextBudget({
          system: currentSystemPrompt,
          messages,
          limits: resolvedLimits,
          tools: modeToolSpecs,
        })

        if (budgeted.exhausted) {
          await finishWithError(
            'contextExhausted',
            'This conversation no longer fits in the model context window. Start a new chat to continue.'
          )
          break
        }

        // Recorded with the transcript, so the next run cuts the rebuilt
        // conversation the same way instead of trimming it afresh
        const trimmed = recordContextTrim(
          contextTrim,
          messages,
          budgeted.messages
        )
        if (trimmed !== contextTrim) {
          contextTrim = trimmed
          await emitEvent({ type: 'contextTrimmed', trim: contextTrim })
        }
        messages = budgeted.messages

        const cacheHints = {
          cacheSystem: true,
          cacheTools: true,
          // Everything but the last message was sent in an earlier request, so it is
          // exactly the prefix worth caching. Same reasoning as build-request.ts.
          lastStableMessage: messages.length >= 2 ? messages.length - 2 : null,
          cacheKey: String(projectId),
          // The shared block, cached on its own where the provider allows it
          systemPrefix: systemBlocks.shared,
        }

        let streamSucceeded = false
        let streamAttempts = 0
        modelStep++

        while (!streamSucceeded && streamAttempts < MAX_STREAM_ATTEMPTS) {
          if (controller.signal.aborted || shouldStop) break
          streamAttempts++
          text = ''
          calls.length = 0
          truncated = false

          try {
            for await (const chunk of client.streamChat({
              system: currentSystemPrompt,
              messages,
              maxTokens,
              contextWindow: resolvedLimits.contextWindow,
              tools: modeToolSpecs,
              cacheHints,
              signal: controller.signal,
            })) {
              if (controller.signal.aborted) break
              if (chunk.type === 'thinking') {
                await emitChunk('thinking', chunk.text)
              } else if (chunk.type === 'text') {
                text += chunk.text
                await emitChunk('text', chunk.text)
              } else if (chunk.type === 'tool_call') {
                calls.push(chunk)
              } else if (
                chunk.type === 'stop' &&
                chunk.reason === 'max_tokens'
              ) {
                truncated = true
              }
            }
            streamSucceeded = true
          } catch (streamErr) {
            if (
              controller.signal.aborted ||
              streamErr.code === 'aborted' ||
              streamErr.name === 'AbortError' ||
              streamAttempts >= MAX_STREAM_ATTEMPTS
            ) {
              throw streamErr
            }

            if (
              NON_RETRYABLE_STATUSES.has(streamErr.status) ||
              NON_RETRYABLE_CODES.has(streamErr.code)
            ) {
              throw streamErr
            }

            logger.warn(
              {
                runId,
                attempt: streamAttempts,
                status: streamErr.status,
                message: streamErr.message,
              },
              '[AiAssist] Transient error from provider during tool run, auto-retrying'
            )
            // The retry streams the reply afresh; what the failed attempt
            // streamed is dropped from the panel too, so its stored text is
            // the text this run sends
            if (text) {
              await emitEvent({ type: 'stepText', text: '' }).catch(() => {})
            }
            const delay = Math.min(
              2000 * Math.pow(2, streamAttempts - 1) + Math.random() * 300,
              20000
            )
            await new Promise(resolve => {
              const onAbort = () => {
                clearTimeout(timer)
                resolve()
              }
              const timer = setTimeout(() => {
                controller.signal.removeEventListener('abort', onAbort)
                resolve()
              }, delay)
              controller.signal.addEventListener('abort', onAbort, {
                once: true,
              })
            })
          }
        }

        if (controller.signal.aborted) break

        if (calls.length === 0 && text) {
          const rescued = extractTextToolCall(text, modeToolSpecs)
          if (rescued) {
            calls.push(rescued.call)
            text = rescued.prose
            // The call is sent as a call, not as the text it came in
            await emitEvent({ type: 'stepText', text })
          }
        }

        if (calls.length === 0) {
          // A message waiting in the queue gets the reply instead; nudging
          // first would only add a turn the user never wrote
          if (
            !text.trim() &&
            toolsRanThisRun &&
            !truncated &&
            !finalReplyNudged &&
            queuedMessages.length === 0
          ) {
            finalReplyNudged = true
            messages.push({ role: 'user', content: FINAL_REPLY_NUDGE })
            // Stored with the turn, so the next run rebuilds it (toAgentMessages)
            await emitEvent({ type: 'nudge' })
            continue
          }
          if (truncated) {
            await emitEvent({
              type: 'error',
              code: 'outputTruncated',
              message: `The reply was cut off at the ${maxTokens}-token output limit. Raise "Max output tokens" in the AI provider settings, or ask for a shorter answer.`,
            })
          }
          // The user may have sent something while this reply was streaming.
          // Answer it in this run rather than ending and making them resend.
          if (queuedMessages.length > 0) {
            await flushText().catch(() => {})
            if (text) messages.push({ role: 'assistant', content: text })
            continue
          }
          if (text) messages.push({ role: 'assistant', content: text })
          closeQueue()
          await emitEvent({ type: 'turnFinished', reason: 'stop' })
          await this.store.updateStatus(runId, 'done')
          shouldStop = true
          break
        }

        const incomplete = classifyIncompleteCalls(
          calls,
          truncated,
          modeToolSpecs
        )

        toolsRanThisRun = true
        messages.push({ role: 'assistant', content: text, toolCalls: calls })

        // The reads a model asks for together are independent, so run the ones
        // at the start of the turn at the same time. Stop at the first call
        // that is not read-only: a read listed after an edit expects to see it.
        const prefetched = new Map()
        const leadingReads = []
        for (const call of calls) {
          if (!READ_ONLY_TOOLS.has(call.name) || incomplete.has(call)) break
          leadingReads.push(call)
        }
        if (leadingReads.length > 1) {
          await Promise.all(
            leadingReads.map(async call => {
              try {
                const value = await runTool(call)
                prefetched.set(call, { result: value, isError: false })
              } catch (err) {
                prefetched.set(call, {
                  result: { error: err.message || 'Tool execution failed' },
                  isError: true,
                })
              }
            })
          )
        }

        let turnSucceeded = false
        let turnFailed = false

        for (const call of calls) {
          if (controller.signal.aborted || shouldStop) break
          steps++
          const callId = call.id || `call_${steps}_${runId}`
          call.id = callId

          // Plan the edit before anything is shown to the user: an edit that
          // cannot apply goes straight back to the model, and one that applies
          // to a different file than named is shown under its real path.
          let editPlan = null
          if (
            call.name === 'edit_file' &&
            this.tools?.checkEdit &&
            !incomplete.has(call) &&
            !userDeclinedEdit
          ) {
            try {
              editPlan = await this.tools.checkEdit(call.args, { projectId })
              if (
                editPlan?.status === 'ok' &&
                editPlan.path &&
                editPlan.path !== call.args.path
              ) {
                call.args.path = editPlan.path
              }
            } catch {
              editPlan = null
            }
          }

          executedTools.push(call.name)
          await emitEvent({
            type: 'toolCallStarted',
            id: callId,
            name: call.name,
            args: call.args,
            step: modelStep,
          })

          let result = null
          let isError = false

          const liveMode = this.activeRuns.get(runId)?.mode || 'manual'
          const verdict = decide(liveMode, call.name)

          if (incomplete.has(call)) {
            result = {
              status: 'error',
              error: incompleteCallError(call, incomplete.get(call), maxTokens),
            }
            isError = true
          } else if (verdict === 'deny') {
            result = {
              status: 'denied',
              error: `${call.name} is not available in ${modeLabel(liveMode)} mode.${liveMode === 'plan' ? ' Research with the read-only tools, then call present_plan with what you would change.' : ''}`,
            }
            isError = true
          } else if (call.name === 'edit_file' || call.name === 'create_file') {
            if (userDeclinedEdit) {
              result = {
                status: 'rejected',
                error:
                  'The user declined an edit earlier in this turn, so file changes are blocked until they send a new message. Do not retry the edit. Say what you would change and why, or ask how they want to proceed.',
              }
            } else if (editPlan && editPlan.status !== 'ok') {
              result = editPlan
            } else {
              const isCreate = call.name === 'create_file'
              const resolvedOldText =
                editPlan?.oldText !== undefined
                  ? editPlan.oldText
                  : isCreate
                    ? ''
                    : call.args.oldText || ''
              const resolvedNewText =
                editPlan?.newText !== undefined
                  ? editPlan.newText
                  : isCreate
                    ? call.args.content || ''
                    : call.args.newText || ''
              const action = isCreate
                ? 'create'
                : !resolvedOldText
                  ? 'append'
                  : !resolvedNewText
                    ? 'delete'
                    : 'edit'
              const approvalEdit = {
                ...call.args,
                path: editPlan?.path || call.args.path,
                oldText: resolvedOldText,
                newText: resolvedNewText,
                startLine: editPlan?.startLine,
                action,
                toolName: call.name,
              }

              const execArgs = {
                ...call.args,
                path: editPlan?.path || call.args.path,
                ...(editPlan?.oldText !== undefined
                  ? { oldText: editPlan.oldText }
                  : {}),
                ...(editPlan?.newText !== undefined
                  ? { newText: editPlan.newText }
                  : {}),
              }

              if (verdict === 'allow') {
                // acceptEdits mode: auto-apply directly
                try {
                  result = await this.tools.execute(call.name, execArgs, {
                    projectId,
                    userId,
                  })
                } catch (err) {
                  result = { error: err.message || 'Tool execution failed' }
                  isError = true
                }
              } else {
                // manual mode: ask for approval
                const decision = await awaitUserApproval({
                  id: call.id,
                  kind: 'edit',
                  edit: approvalEdit,
                })

                if (!decision?.accepted) {
                  userDeclinedEdit = true
                  const userNote = decision?.note
                    ? ` with note: "${decision.note}"`
                    : ''
                  result = {
                    status: 'rejected',
                    message: `The user declined this change${userNote}. Do not attempt any further file modifications or repeat this edit in this turn. Acknowledge to the user that the edit was rejected, address their feedback, and explain alternatives or ask how they would like to proceed.`,
                    note: decision?.note,
                  }
                } else {
                  try {
                    result = await this.tools.execute(call.name, execArgs, {
                      projectId,
                      userId,
                    })
                  } catch (err) {
                    result = { error: err.message || 'Tool execution failed' }
                    isError = true
                  }
                }
              }
            }
          } else if (SETTINGS_TOOLS.has(call.name) && verdict === 'ask') {
            const decision = await awaitUserApproval({
              id: call.id,
              kind: 'settings',
              settings: { toolName: call.name, args: call.args },
            })

            if (!decision?.accepted) {
              const userNote = decision?.note
                ? ` with note: "${decision.note}"`
                : ''
              result = {
                status: 'rejected',
                message: `The user declined this settings change${userNote}. Do not retry it in this turn.`,
                note: decision?.note,
              }
            } else {
              try {
                result = await this.tools.execute(
                  call.name,
                  call.args,
                  toolContext(call)
                )
              } catch (err) {
                result = { error: err.message || 'Tool execution failed' }
                isError = true
              }
            }
          } else if (call.name === PLAN_TOOL && verdict === 'ask') {
            const planText =
              typeof call.args?.plan === 'string' ? call.args.plan : ''
            const decision = await awaitUserApproval({
              id: call.id,
              kind: 'plan',
              plan: planText,
            })

            if (decision?.accepted) {
              const nextMode = normalizeMode(decision.nextMode || 'manual')
              const active = this.activeRuns.get(runId)
              if (active) active.mode = nextMode
              await this.store.setMode(runId, nextMode)
              await emitEvent({
                type: 'modeChanged',
                mode: nextMode,
                source: 'planApproval',
              })
              result = {
                status: 'approved',
                mode: nextMode,
                message: `The user approved the plan. You are now in ${modeLabel(nextMode)} mode: carry the plan out now, in this turn, then say what you changed.`,
              }
            } else {
              const userNote = decision?.note
                ? ` with note: "${decision.note}"`
                : ''
              result = {
                status: 'keepPlanning',
                note: decision?.note,
                message: `The user wants you to keep planning${userNote}. Revise the plan using their feedback and call present_plan again.`,
              }
            }
          } else if (prefetched.has(call)) {
            const done = prefetched.get(call)
            result = done.result
            isError = done.isError
          } else {
            try {
              result = await runTool(call)
            } catch (err) {
              result = { error: err.message || 'Tool execution failed' }
              isError = true
            }
          }

          // "nothing compiled yet" (status 'none') is an answer, not a failure.
          const isFailed = toolMessageIsError(result, isError)
          const callSig = `${call.name}:${JSON.stringify(call.args ?? {})}`
          let repeats = 0
          if (isFailed) {
            repeats = (failedCallSignatures.get(callSig) ?? 0) + 1
            failedCallSignatures.set(callSig, repeats)
            if (
              repeats === IDENTICAL_FAILURE_LIMIT - 1 &&
              result &&
              typeof result === 'object'
            ) {
              result = {
                ...result,
                repeated: `This exact ${call.name} call has now failed ${repeats} times with the same arguments; one more identical failure ends the run. Change the arguments (re-read the file and copy its current text) or take a different approach.`,
              }
            }
          }

          // Everything the model is told about this call is in `result` before
          // it is emitted, so the stored transcript rebuilds the same message.
          const notices = []
          const liveRun = this.activeRuns.get(runId)
          if (liveRun?.modeNotice) {
            notices.push(
              `The user switched to ${modeLabel(liveRun.modeNotice)} mode.`
            )
            liveRun.modeNotice = null
          }
          const fetched =
            call.name === 'web_fetch' ? fetchedPageKey(call.args) : ''
          const readingOn = Boolean(fetched) && fetchedPages.has(fetched)
          if (fetched && !isFailed) fetchedPages.add(fetched)
          if (
            webTools &&
            WEB_TOOL_NAMES.has(call.name) &&
            !readingOn &&
            ++webCalls === WEB_CALL_NUDGE
          ) {
            notices.push(
              `That is ${WEB_CALL_NUDGE} web calls for this request. Answer with what you have unless one missing fact is essential.`
            )
          }
          if (notices.length) result = withNotice(result, notices.join(' '))

          await emitEvent({
            type: 'toolCallFinished',
            id: call.id,
            name: call.name,
            result,
            isError,
          })

          if (isFailed) {
            turnFailed = true
            if (repeats >= IDENTICAL_FAILURE_LIMIT) {
              await finishWithError(
                'runawayToolLoop',
                `Stopped repeated failing call to ${call.name}. Please check the file contents or provide more specific instructions.`
              )
              break
            }
          } else {
            turnSucceeded = true
            // The project changed, so a call that failed before may succeed now.
            if (result?.status === 'applied') failedCallSignatures.clear()
          }

          // Cycle detection: X, Y, X, Y with identical names AND arguments is a
          // loop making no progress (compile -> read result -> compile -> read
          // result). Comparing names alone would also stop edit -> compile ->
          // edit -> compile, which is how compile errors get fixed.
          recentCallSignatures.push({ name: call.name, signature: callSig })
          if (recentCallSignatures.length > CYCLE_WINDOW) {
            recentCallSignatures.shift()
          }
          if (recentCallSignatures.length === CYCLE_WINDOW) {
            const [a, b, c, d] = recentCallSignatures
            if (
              a.signature === c.signature &&
              b.signature === d.signature &&
              a.signature !== b.signature
            ) {
              await finishWithError(
                'runawayToolLoop',
                `Stopped repeated alternating tool loop between ${a.name} and ${b.name}.`
              )
              break
            }
          }

          messages.push({
            role: 'tool',
            toolCallId: call.id,
            // Gemini names the functionResponse after this, and Anthropic's
            // is_error comes from isError; without them every result looks like
            // a successful call to a function named "tool".
            name: call.name,
            content: renderToolResult(call.name, result),
            isError: isFailed,
          })
        }

        if (shouldStop || controller.signal.aborted) break

        if (turnSucceeded) {
          failedTurns = 0
        } else if (turnFailed) {
          failedTurns += 1
          if (failedTurns >= FAILED_TURN_LIMIT) {
            await finishWithError(
              'consecutiveToolFailures',
              `Stopped after ${failedTurns} turns in a row in which every tool call failed. Please check the file contents or provide more specific instructions.`
            )
            break
          }
        }
      }

      closeQueue()
      if (controller.signal.aborted) {
        await emitEvent({ type: 'turnFinished', reason: 'aborted' })
        await this.store.updateStatus(runId, 'stopped')
      } else if (!shouldStop) {
        await emitEvent({
          type: 'turnFinished',
          reason: 'stop',
        })
        await this.store.updateStatus(runId, 'done')
      }
    } catch (err) {
      closeQueue()
      if (
        controller.signal.aborted ||
        err.name === 'AbortError' ||
        err.code === 'aborted' ||
        err.code === 'ERR_ABORTED' ||
        err.message?.includes('aborted')
      ) {
        await emitEvent({ type: 'turnFinished', reason: 'aborted' })
        await this.store.updateStatus(runId, 'stopped')
        return
      }
      const code =
        err.code ||
        (err.status === 401 || err.status === 403
          ? 'providerAuth'
          : 'providerError')
      await emitEvent({
        type: 'error',
        code,
        status: err.status,
        message: err.message,
      })
      await this.store.updateStatus(runId, 'error', { message: err.message })
    } finally {
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      await flushText().catch(() => {})
      await flushChain.catch(() => {})
      // Belt and braces: if the loop exits through an unexpected path while an
      // approval is pending, the timer and listener must not outlive the run.
      approvalPromiseResolvers.resolve?.({ accepted: false, note: 'Run ended' })
      this.activeRuns.delete(runId)
    }
  }

  /** Aborts a run this process owns. Never publishes. Idempotent. */
  async stopLocalRun(runId) {
    const active = this.activeRuns.get(runId)
    if (!active) return false
    // A stopped run reads nothing more; the panel sends what it had queued
    active.acceptsMessages = false
    active.controller.abort()
    active.approvalResolver?.resolve?.({ accepted: false })
    // The run loop owns the terminal event (see startRun's aborted branch).
    return true
  }

  /**
   * Entry point for an HTTP stop. Acts locally if we own the run; otherwise
   * broadcasts so the owning instance can act.
   *
   * This deliberately revises Task 3 step 4. Task 3's version is correct for a
   * single process and its tests must pass as written there; once stop is
   * broadcast, writing status/events in the !owned branch would happen once per
   * instance for one stop, so that write moves out.
   */
  async stopRun(runId) {
    if (await this.stopLocalRun(runId)) return

    if (this.control) {
      await this.control.publish(runId, { action: 'stop' }).catch(() => {})
      return
    }

    // No control channel (single process, or a unit test constructing the
    // manager directly). Fall back to Task 3's behaviour so those tests pass.
    await this.store.updateStatus(runId, 'stopped')
    await this.store.appendEvent(runId, {
      type: 'turnFinished',
      reason: 'aborted',
    })
  }

  /** Same shape for approval: local first, broadcast only if not ours. */
  async approveEdit(runId, decision) {
    const active = this.activeRuns.get(runId)
    if (active?.approvalResolver?.resolve) {
      await this.store.clearPendingApproval(runId, 'running')
      active.approvalResolver.resolve(decision)
      return
    }
    if (this.control) {
      await this.control
        .publish(runId, { action: 'approve', decision })
        .catch(() => {})
    }
  }

  /**
   * Adds a message the user sent while the run was already going.
   *
   * Local first, broadcast only if this process does not own the run, which is
   * the same shape as stop, approve and setMode. Returns false when the run
   * has looked at its queue for the last time (it is finishing or stopped), so
   * the caller can turn the message away rather than let it sit unread.
   */
  async queueMessage(runId, message) {
    const active = this.activeRuns.get(runId)
    if (active?.queuedMessages) {
      if (!active.acceptsMessages) return false
      active.queuedMessages.push(
        toQueuedMessage(message, active.queuedMessages.length)
      )
      return true
    }
    if (this.control) {
      try {
        await this.control.publish(runId, { action: 'message', message })
        return true
      } catch {
        return false
      }
    }
    return false
  }

  /**
   * Takes back a message the run has not read yet, as Claude Code lets you
   * take back what you queued. True when it was removed, false when the run
   * has already read it, null when another instance owns the run and was
   * asked to remove it.
   */
  async unqueueMessage(runId, messageId) {
    const active = this.activeRuns.get(runId)
    if (active?.queuedMessages) {
      const index = active.queuedMessages.findIndex(m => m.id === messageId)
      if (index === -1) return false
      active.queuedMessages.splice(index, 1)
      return true
    }
    if (this.control) {
      await this.control
        .publish(runId, { action: 'unqueue', id: messageId })
        .catch(() => {})
      return null
    }
    return false
  }

  async setMode(runId, mode) {
    const normalized = normalizeMode(mode)
    const active = this.activeRuns.get(runId)
    if (active) {
      active.mode = normalized
      active.modeNotice = normalized
      await this.store.setMode(runId, normalized)
      await this.store.appendEvent(runId, {
        type: 'modeChanged',
        mode: normalized,
        source: 'user',
      })
      return
    }
    if (this.control) {
      await this.control
        .publish(runId, { action: 'setMode', mode: normalized })
        .catch(() => {})
    } else {
      await this.store.setMode(runId, normalized)
    }
  }

  /**
   * Delivers the editor's outcome for a compile the run asked it to do. Local
   * first, broadcast only if not ours. An id that is no longer pending (a
   * replayed request, a second tab) is ignored.
   */
  async submitCompileResult(runId, { id, outcome }) {
    const settle = this.activeRuns.get(runId)?.compileResolvers?.get(id)
    if (settle) {
      settle(sanitizeCompileOutcome(outcome))
      return
    }
    if (this.control) {
      await this.control
        .publish(runId, { action: 'compile', id, outcome })
        .catch(() => {})
    }
  }

  /** Handles a command received from the control channel. NEVER re-broadcasts. */
  onCommand({ runId, action, decision, id, outcome, mode, message }) {
    if (action === 'stop') {
      void this.stopLocalRun(runId).catch(() => {})
      return
    }
    if (action === 'message') {
      const active = this.activeRuns.get(runId)
      if (active?.queuedMessages && active.acceptsMessages) {
        active.queuedMessages.push(
          toQueuedMessage(message, active.queuedMessages.length)
        )
      }
      return
    }
    if (action === 'unqueue') {
      const queue = this.activeRuns.get(runId)?.queuedMessages
      const index = queue ? queue.findIndex(m => m.id === id) : -1
      if (index !== -1) queue.splice(index, 1)
      return
    }
    if (action === 'compile') {
      this.activeRuns.get(runId)?.compileResolvers?.get(id)?.(
        sanitizeCompileOutcome(outcome)
      )
      return
    }
    if (action === 'setMode') {
      const active = this.activeRuns.get(runId)
      if (active) {
        active.mode = mode
        active.modeNotice = mode
        void this.store.setMode(runId, mode).catch(() => {})
        void this.store
          .appendEvent(runId, { type: 'modeChanged', mode, source: 'user' })
          .catch(() => {})
      }
      return
    }
    if (action === 'approve') {
      // Resolve locally only. Do not call approveEdit — it would re-publish
      // when this instance does not own the run, which is the normal case for
      // a broadcast, and loop.
      const active = this.activeRuns.get(runId)
      if (active?.approvalResolver?.resolve) {
        void this.store
          .clearPendingApproval(runId, 'running')
          .then(() => active.approvalResolver.resolve(decision))
          .catch(() => {})
      }
    }
  }
}

export default new AiAssistRunManager()
