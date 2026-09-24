import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import './ModuleSettings.mjs'
import defaultStore from './AiAssistRunStore.mjs'
import defaultTools from './AiAssistTools.mjs'
import defaultChatHistoryStore from './AiAssistChatHistoryStore.mjs'
import { generateChatTitle } from './AiAssistChatTitler.mjs'
import { createProviderClient } from './AiAssistProviders.mjs'
import { renderToolResult } from './AiAssistToolRender.mjs'
import { SYSTEM_PROMPT, systemPromptFor } from './AiAssistSystemPrompt.mjs'
import { coerceToolArgs } from './AiAssistToolSchema.mjs'
import { AiAssistWebTools, WEB_TOOL_NAMES } from './AiAssistWebTools.mjs'
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


export function toAgentMessages(transcript) {
  if (!Array.isArray(transcript)) return []
  const messages = []

  transcript.forEach((entry, index) => {
    if (entry.role === 'user') {
      const content = entry.contextText
        ? `${entry.contextText}\n\n${entry.text}`
        : (entry.text || entry.content || '')
      messages.push({ role: 'user', content })
      return
    }

    const isLast = index === transcript.length - 1
    if (isLast && !entry.text && !entry.content && (!entry.toolCalls || entry.toolCalls.length === 0)) return

    if (!entry.toolCalls || entry.toolCalls.length === 0) {
      messages.push({ role: 'assistant', content: entry.text || entry.content || '' })
      return
    }

    messages.push({
      role: 'assistant',
      content: entry.text || entry.content || '',
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
          ? (typeof call.result === 'string' ? call.result : renderToolResult(call.name, call.result))
          : 'This tool call did not complete.',
        isError: finished ? Boolean(call.isError || call.result?.error) : true,
      })
    }
  })

  return messages
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
    rawLog: typeof outcome?.rawLog === 'string' ? outcome.rawLog.slice(-MAX_COMPILE_LOG_CHARS) : '',
  }
}

export const KEEP_RECENT_TOOL_RESULTS = 3
export const KEEP_RECENT_ASSISTANT_TURNS = 3
export const CHARS_PER_TOKEN = 3.7
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

const MAX_QUEUED_MESSAGE_BYTES = 200_000

/**
 * Normalises a message the user sent while the run was already going.
 *
 * `content` is assembled the same way toAgentMessages assembles a stored user
 * turn, so an injected message is indistinguishable from one the run started
 * with — same <project-context> envelope, same ordering.
 */
export function toQueuedMessage(message, index = 0) {
  const text = typeof message?.text === 'string' ? message.text : ''
  const contextText =
    typeof message?.contextText === 'string' ? message.contextText : ''
  const content = contextText ? `${contextText}\n\n${text}` : text
  return {
    id:
      typeof message?.id === 'string' && message.id
        ? message.id
        : `queued_${Date.now()}_${index}`,
    text,
    content: content.slice(0, MAX_QUEUED_MESSAGE_BYTES),
  }
}

export const IDENTICAL_FAILURE_LIMIT = 3
// Model turns in a row in which every tool call failed. Counted per turn, not
// per call: one reply with three parallel guesses that all miss is one wrong
// decision, not three.
export const FAILED_TURN_LIMIT = 4


export function estimateTokens(text) {
  return Math.ceil(((text && typeof text === 'string') ? text : '').length / CHARS_PER_TOKEN)
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
  const validTools = toolSpecs?.length ? new Set(toolSpecs.map(t => t.name)) : KNOWN_TOOLS

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
      if (name && validTools.has(name) && typeof args === 'object' && args !== null) {
        return {
          call: { id: `call_txt_${Date.now()}`, name, args },
          prose: text.slice(0, fenceMatch.index).trim(),
        }
      }
    } catch {}
  }

  // 2. <tool_call> or <function=name> XML tags used by open-source models
  const tagMatch = text.match(/<(?:tool_call|function(?:=([^>]+))?)>([\s\S]*?)<\/(?:tool_call|function)>/i)
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
      if (name && validTools.has(name) && typeof args === 'object' && args !== null) {
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
      if (name && validTools.has(name) && typeof args === 'object' && args !== null) {
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
  const rawBudget = contextWindow - maxOutputTokens - Math.ceil(contextWindow * MARGIN_FRACTION)

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
    if (estimateTokens(ASSISTANT_ELISION_MARKER) >= estimateTokens(msg.content)) continue
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

export class AiAssistRunManager {
  constructor({
    store = defaultStore,
    tools = defaultTools,
    clientFactory = createProviderClient,
    chatHistoryStore = defaultChatHistoryStore,
    approvalTimeoutMs = null,
    compileTimeoutMs = null,
    webToolsFactory = (settings, { userId } = {}) => new AiAssistWebTools(settings, { cacheOwner: userId }),
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

    this.activeRuns.set(runId, {
      controller,
      projectId,
      userId,
      mode: initialMode,
      approvalResolver: approvalPromiseResolvers,
      compileResolvers,
      queuedMessages,
    })

    await this.store.createRun({ runId, projectId, userId, mode: initialMode })

    const client = this.clientFactory(providerSettings)
    // Only runs whose user configured web search get the web tools, and the
    // prompt section describing them.
    const webTools = webSearchSettings ? this.webToolsFactory(webSearchSettings, { userId }) : null
    // Sources cited in earlier turns keep their numbers in this one
    webTools?.rememberSources?.(transcript)
    let messages = toAgentMessages(transcript)

    const DEFAULT_LIMITS = {
      openai: { contextWindow: 200000, maxOutputTokens: 32000 },
      anthropic: { contextWindow: 200000, maxOutputTokens: 32000 },
      google: { contextWindow: 1000000, maxOutputTokens: 65536 },
      ollama: { contextWindow: 256000, maxOutputTokens: 65536 },
    }
    const limits = DEFAULT_LIMITS[providerSettings?.type] ?? DEFAULT_LIMITS.openai
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

    // Streamed text and thinking are buffered and written in batches: every
    // appendEvent is INCR + RPUSH + PUBLISH, and the provider stream is not
    // read again until the write resolves. Only one kind is buffered at a
    // time, so a switch between thinking and text flushes first and order
    // is preserved.
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
            const existing = await this.chatHistoryStore.getChat(projectId, userId, chatId)
            if (existing?.titleGenerated) return

            const titlingClient = this.clientFactory(providerSettings)
            const generatedTitle = await generateChatTitle({
              client: titlingClient,
              firstMessageText: firstUser.text,
              signal: controller.signal,
            })

            if (generatedTitle && !controller.signal.aborted) {
              await this.chatHistoryStore.saveChatTitle(projectId, userId, chatId, generatedTitle, true)
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
      const requestId = id || `compile_${Date.now()}_${Math.random().toString(36).slice(2)}`

      await emitEvent({ type: 'awaitingCompile', id: requestId, clean: Boolean(clean) })
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
    const toolContext = call => ({ projectId, userId, callId: call.id, compileInEditor })
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
        if (timer) { clearTimeout(timer); timer = null }
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
      let shouldStop = false
      let userDeclinedEdit = false
      // The user reads the reply, not the tool cards. A model that spends the
      // turn on tools and then returns an empty final turn has told them
      // nothing, so ask once for the reply before ending the run.
      let toolsRanThisRun = false
      let finalReplyNudged = false
      const executedTools = []

      const finishWithError = async (code, message) => {
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
          const injected = queuedMessages.splice(0, queuedMessages.length)
          for (const queued of injected) {
            messages.push({ role: 'user', content: queued.content })
            await emitEvent({
              type: 'userMessage',
              id: queued.id,
              text: queued.text,
            })
          }
          userDeclinedEdit = false
          finalReplyNudged = false
          failedTurns = 0
          failedCallSignatures.clear()
          recentCallSignatures.length = 0
        }

        const calls = []
        let text = ''
        let truncated = false

        const currentMode = this.activeRuns.get(runId)?.mode || 'manual'
        const currentSystemPrompt = systemPromptFor(currentMode, { webTools: Boolean(webTools) })

        const allToolSpecs = [
          ...(this.tools?.getToolSpecs ? this.tools.getToolSpecs() : []),
          ...(webTools ? webTools.getToolSpecs() : []),
        ]
        const modeToolSpecs = toolSpecsFor(currentMode, allToolSpecs)

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

        messages = budgeted.messages

        const cacheHints = {
          cacheSystem: true,
          cacheTools: true,
          // Everything but the last message was sent in an earlier request, so it is
          // exactly the prefix worth caching. Same reasoning as build-request.ts.
          lastStableMessage: messages.length >= 2 ? messages.length - 2 : null,
          cacheKey: String(projectId),
        }

        let streamSucceeded = false
        let streamAttempts = 0
        // Hosted providers shed load with 5xx errors and dropped streams for
        // tens of seconds at a time, so a step keeps retrying for about a
        // minute (2s, 4s, 8s, 16s, 20s) before the run gives up.
        const MAX_STREAM_ATTEMPTS = 6

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
              } else if (chunk.type === 'stop' && chunk.reason === 'max_tokens') {
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

            const isNonRetryable =
              streamErr.status === 400 ||
              streamErr.status === 401 ||
              streamErr.status === 403 ||
              streamErr.status === 404 ||
              streamErr.code === 'providerAuth' ||
              streamErr.code === 'invalidProviderUrl' ||
              streamErr.code === 'restrictedProviderUrl' ||
              streamErr.code === 'contextExhausted'

            if (isNonRetryable) {
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
            const delay = Math.min(2000 * Math.pow(2, streamAttempts - 1) + Math.random() * 300, 20000)
            await new Promise(resolve => {
              const timer = setTimeout(resolve, delay)
              const onAbort = () => {
                clearTimeout(timer)
                resolve()
              }
              controller.signal.addEventListener('abort', onAbort, { once: true })
            })
          }
        }

        if (controller.signal.aborted) break

        if (calls.length === 0 && text) {
          const rescued = extractTextToolCall(text, modeToolSpecs)
          if (rescued) {
            calls.push(rescued.call)
            text = rescued.prose
          }
        }

        if (calls.length === 0) {
          if (!text.trim() && toolsRanThisRun && !truncated && !finalReplyNudged) {
            finalReplyNudged = true
            messages.push({ role: 'user', content: FINAL_REPLY_NUDGE })
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
            if (text) messages.push({ role: 'assistant', content: text })
            continue
          }
          await emitEvent({ type: 'turnFinished', reason: 'stop' })
          await this.store.updateStatus(runId, 'done')
          shouldStop = true
          break
        }

        const incomplete = classifyIncompleteCalls(calls, truncated, modeToolSpecs)

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
              if (editPlan?.status === 'ok' && editPlan.path && editPlan.path !== call.args.path) {
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
                error: 'The user declined an edit earlier in this turn, so file changes are blocked until they send a new message. Do not retry the edit. Say what you would change and why, or ask how they want to proceed.',
              }
            } else if (editPlan && editPlan.status !== 'ok') {
              result = editPlan
            } else {
              const isCreate = call.name === 'create_file'
              const resolvedOldText = editPlan?.oldText !== undefined ? editPlan.oldText : (isCreate ? '' : (call.args.oldText || ''))
              const resolvedNewText = editPlan?.newText !== undefined ? editPlan.newText : (isCreate ? (call.args.content || '') : (call.args.newText || ''))
              const action = isCreate
                ? 'create'
                : (!resolvedOldText ? 'append' : (!resolvedNewText ? 'delete' : 'edit'))
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
                ...(editPlan?.oldText !== undefined ? { oldText: editPlan.oldText } : {}),
                ...(editPlan?.newText !== undefined ? { newText: editPlan.newText } : {}),
              }

              if (verdict === 'allow') {
                // acceptEdits mode: auto-apply directly
                try {
                  result = await this.tools.execute(call.name, execArgs, { projectId, userId })
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
                  const userNote = decision?.note ? ` with note: "${decision.note}"` : ''
                  result = {
                    status: 'rejected',
                    message: `The user declined this change${userNote}. Do not attempt any further file modifications or repeat this edit in this turn. Acknowledge to the user that the edit was rejected, address their feedback, and explain alternatives or ask how they would like to proceed.`,
                    note: decision?.note,
                  }
                } else {
                  try {
                    result = await this.tools.execute(call.name, execArgs, { projectId, userId })
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
              const userNote = decision?.note ? ` with note: "${decision.note}"` : ''
              result = {
                status: 'rejected',
                message: `The user declined this settings change${userNote}. Do not retry it in this turn.`,
                note: decision?.note,
              }
            } else {
              try {
                result = await this.tools.execute(call.name, call.args, toolContext(call))
              } catch (err) {
                result = { error: err.message || 'Tool execution failed' }
                isError = true
              }
            }
          } else if (call.name === PLAN_TOOL && verdict === 'ask') {
            const planText = typeof call.args?.plan === 'string' ? call.args.plan : ''
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
              await emitEvent({ type: 'modeChanged', mode: nextMode, source: 'planApproval' })
              result = {
                status: 'approved',
                mode: nextMode,
                message: `The user approved the plan. You are now in ${modeLabel(nextMode)} mode: carry the plan out now, in this turn, then say what you changed.`,
              }
            } else {
              const userNote = decision?.note ? ` with note: "${decision.note}"` : ''
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

          await emitEvent({
            type: 'toolCallFinished',
            id: call.id,
            name: call.name,
            result,
            isError,
          })

          // "nothing compiled yet" (status 'none') is an answer, not a failure.
          const isFailed = Boolean(
            (isError && result?.status !== 'denied') ||
              result?.error ||
              result?.status === 'noMatch' ||
              result?.status === 'ambiguous'
          )

          if (isFailed) {
            turnFailed = true
            const callSig = `${call.name}:${JSON.stringify(call.args)}`
            const repeats = (failedCallSignatures.get(callSig) ?? 0) + 1
            failedCallSignatures.set(callSig, repeats)
            if (repeats >= IDENTICAL_FAILURE_LIMIT) {
              await finishWithError(
                'runawayToolLoop',
                `Stopped repeated failing call to ${call.name}. Please check the file contents or provide more specific instructions.`
              )
              break
            }
            if (repeats === IDENTICAL_FAILURE_LIMIT - 1 && result && typeof result === 'object') {
              result = {
                ...result,
                repeated: `This exact ${call.name} call has now failed ${repeats} times with the same arguments; one more identical failure ends the run. Change the arguments (re-read the file and copy its current text) or take a different approach.`,
              }
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
          recentCallSignatures.push({
            name: call.name,
            signature: `${call.name}:${JSON.stringify(call.args ?? {})}`,
          })
          if (recentCallSignatures.length >= 4) {
            const [a, b, c, d] = recentCallSignatures.slice(-4)
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
            isError: Boolean(isFailed),
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
    await this.store.appendEvent(runId, { type: 'turnFinished', reason: 'aborted' })
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
      await this.control.publish(runId, { action: 'approve', decision }).catch(() => {})
    }
  }

  /**
   * Adds a message the user sent while the run was already going.
   *
   * Local first, broadcast only if this process does not own the run, which is
   * the same shape as stop, approve and setMode. Returns true when the message
   * was handed to a running loop here; the caller has already checked the
   * stored status, so a false only means another instance owns it.
   */
  async queueMessage(runId, message) {
    const active = this.activeRuns.get(runId)
    if (active?.queuedMessages) {
      active.queuedMessages.push(toQueuedMessage(message, active.queuedMessages.length))
      return true
    }
    if (this.control) {
      await this.control.publish(runId, { action: 'message', message }).catch(() => {})
    }
    return false
  }

  async setMode(runId, mode) {
    const normalized = normalizeMode(mode)
    const active = this.activeRuns.get(runId)
    if (active) {
      active.mode = normalized
      await this.store.setMode(runId, normalized)
      await this.store.appendEvent(runId, { type: 'modeChanged', mode: normalized, source: 'user' })
      return
    }
    if (this.control) {
      await this.control.publish(runId, { action: 'setMode', mode: normalized }).catch(() => {})
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
      await this.control.publish(runId, { action: 'compile', id, outcome }).catch(() => {})
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
      if (active?.queuedMessages) {
        active.queuedMessages.push(
          toQueuedMessage(message, active.queuedMessages.length)
        )
      }
      return
    }
    if (action === 'compile') {
      this.activeRuns.get(runId)?.compileResolvers?.get(id)?.(sanitizeCompileOutcome(outcome))
      return
    }
    if (action === 'setMode') {
      const active = this.activeRuns.get(runId)
      if (active) {
        active.mode = mode
        void this.store.setMode(runId, mode).catch(() => {})
        void this.store.appendEvent(runId, { type: 'modeChanged', mode, source: 'user' }).catch(() => {})
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
