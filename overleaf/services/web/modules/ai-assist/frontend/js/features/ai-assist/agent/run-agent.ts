import {
  AgentMessage,
  DEFAULT_LIMITS,
  Limits,
  ProviderClient,
  ProviderError,
  ToolCall,
} from '../providers/types'
import { AgentEvent } from './agent-events'
import { AgentTool } from './tools/registry'
import { ProjectHandle } from './project-handle'
import { readOnlyHandle } from './readonly-handle'
import { TranscriptEntry } from './agent-messages'
import { buildRequest } from './context/build-request'
import { applyBudget } from './context/budget'
import {
  extractFencedToolCall,
  nextToolCallId,
  parseWholeMessageToolCall,
} from './text-tool-call'

/**
 * The same failing call, arguments and all: the second failure carries a
 * warning in its result, the third ends the run. Mirrors AiAssistRunManager.mjs.
 */
const IDENTICAL_FAILURE_LIMIT = 3
/**
 * Model turns in a row in which every tool call failed. Counted per turn, not
 * per call. Mirrors AiAssistRunManager.mjs.
 */
const FAILED_TURN_LIMIT = 4

/** The tools that change files. Their repaired arguments are never trusted. */
const FILE_EDIT_TOOLS = new Set(['edit_file', 'create_file'])

const CONTEXT_EXHAUSTED_MESSAGE =
  'This conversation no longer fits in the model context window. Start a new chat to continue.'

type StopReason = {
  code: 'runawayToolLoop' | 'consecutiveToolFailures'
  message: string
}

/**
 * Finds the tool calls that must not run, and strips the provider parser's
 * markers (`_parseError`, `_raw`, `_repaired`) from every call's arguments.
 * Mirrors classifyIncompleteCalls in AiAssistRunManager.mjs.
 */
function classifyIncompleteCalls(
  calls: ToolCall[],
  truncated: boolean
): Map<ToolCall, 'cutOff' | 'invalid'> {
  const incomplete = new Map<ToolCall, 'cutOff' | 'invalid'>()
  calls.forEach((call, index) => {
    const args: Record<string, unknown> =
      call.args && typeof call.args === 'object' && !Array.isArray(call.args)
        ? { ...(call.args as Record<string, unknown>) }
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
      call.args = args
    }
  })
  return incomplete
}

function incompleteCallError(
  call: ToolCall,
  reason: 'cutOff' | 'invalid',
  maxTokens: number
): string {
  return reason === 'cutOff'
    ? `This ${call.name} call was cut off at the ${maxTokens}-token output limit, so its arguments are incomplete and it was not run. Make the change in smaller pieces: replace a smaller line range per edit_file call, or create the file with part of its content and add the rest with edit_file.`
    : `The arguments of this ${call.name} call were not valid JSON, so it was not run. Send the call again with complete arguments.`
}

export async function* runAgent({
  client,
  handle,
  tools,
  transcript,
  limits = DEFAULT_LIMITS.openai,
  cacheKey,
  signal,
  systemPrompt,
  requireTool,
}: {
  client: ProviderClient
  handle: ProjectHandle
  tools: Record<string, AgentTool>
  transcript: TranscriptEntry[]
  limits?: Limits
  cacheKey?: string
  signal?: AbortSignal
  /** Lets a narrow run (the compile-log fix) swap in its own prompt. */
  systemPrompt?: string
  /**
   * A tool the run exists to call. If the model tries to finish without ever
   * calling it, the loop sends one follow-up turn asking for the call instead
   * of ending on prose.
   */
  requireTool?: string
}): AsyncGenerator<AgentEvent> {
  const specs = Object.values(tools).map(tool => tool.spec)

  const request = buildRequest({
    transcript,
    limits,
    cacheKey,
    tools: specs.length ? specs : undefined,
    systemPrompt,
  })

  if (request.exhausted) {
    yield { type: 'error', code: 'contextExhausted', message: CONTEXT_EXHAUSTED_MESSAGE }
    return yield { type: 'turnFinished', reason: 'stop' }
  }

  const system = request.system
  let messages: AgentMessage[] = request.messages

  let failedTurns = 0
  const failedCallSignatures = new Map<string, number>()
  const recentCallSignatures: { name: string; signature: string }[] = []
  let requiredToolCalled = false
  let requiredToolNudged = false

  while (true) {
    // Tool results added during this run count against the window too, so
    // the budget is checked before every request, not only the first.
    const budgeted = applyBudget({ system, messages, limits, tools: specs })
    if (budgeted.exhausted) {
      yield { type: 'error', code: 'contextExhausted', message: CONTEXT_EXHAUSTED_MESSAGE }
      return yield { type: 'turnFinished', reason: 'stop' }
    }
    messages = budgeted.messages

    let text = ''
    const calls: ToolCall[] = []
    let inThinkTag = false
    let held = ''
    let convertedThisTurn = false
    let truncated = false

    try {
      for await (const chunk of client.streamChat({
        system,
        messages,
        maxTokens: limits.maxOutputTokens,
        contextWindow: limits.contextWindow,
        tools: specs.length ? specs : undefined,
        cacheHints: {
          ...request.cacheHints,
          lastStableMessage: messages.length >= 2 ? messages.length - 2 : null,
        },
        signal,
      })) {
        if (chunk.type === 'thinking') {
          yield { type: 'thinking', text: chunk.text }
        } else if (chunk.type === 'text') {
          let raw = chunk.text
          while (raw.length > 0) {
            if (!inThinkTag) {
              const startIdx = raw.indexOf('<think>')
              if (startIdx === -1) {
                held += raw
                const found = convertedThisTurn
                  ? null
                  : extractFencedToolCall(held, tools)
                if (found) {
                  if (found.before) yield { type: 'text', text: found.before }
                  text += found.before
                  calls.push(found.call)
                  convertedThisTurn = true
                  held = found.after
                } else if (held.includes('```json') && !held.slice(held.indexOf('```json') + 7).includes('```')) {
                  // Fence open but not closed: yield what precedes it and hold
                  // the rest until the closing fence arrives.
                  const open = held.indexOf('```json')
                  if (open > 0) {
                    yield { type: 'text', text: held.slice(0, open) }
                    text += held.slice(0, open)
                  }
                  held = held.slice(open)
                } else {
                  yield { type: 'text', text: held }
                  text += held
                  held = ''
                }
                break
              } else {
                const before = raw.slice(0, startIdx)
                if (before) {
                  text += before
                  yield { type: 'text', text: before }
                }
                inThinkTag = true
                raw = raw.slice(startIdx + '<think>'.length)
              }
            } else {
              const endIdx = raw.indexOf('</think>')
              if (endIdx === -1) {
                yield { type: 'thinking', text: raw }
                break
              } else {
                const thinkPart = raw.slice(0, endIdx)
                if (thinkPart) {
                  yield { type: 'thinking', text: thinkPart }
                }
                inThinkTag = false
                raw = raw.slice(endIdx + '</think>'.length)
              }
            }
          }
        } else if (chunk.type === 'tool_call') {
          const id = chunk.id || nextToolCallId('call')
          calls.push({ id, name: chunk.name, args: chunk.args })
        } else if (chunk.type === 'stop') {
          truncated = true
        }
      }
    } catch (error: any) {
      if (error instanceof ProviderError && error.code === 'aborted') {
        return yield { type: 'turnFinished', reason: 'aborted' }
      }
      yield {
        type: 'error',
        code: error?.code ?? 'providerError',
        message: error?.message ?? 'The provider request failed.',
        status: error?.status,
        hint: error?.hint,
        upstreamCode: error?.upstreamCode,
        upstreamType: error?.upstreamType,
      }
      return yield { type: 'turnFinished', reason: 'stop' }
    }

    if (signal?.aborted) {
      return yield { type: 'turnFinished', reason: 'aborted' }
    }

    if (held) {
      yield { type: 'text', text: held }
      text += held
      held = ''
    }

    if (calls.length === 0 && !convertedThisTurn) {
      const rescued = parseWholeMessageToolCall(text, tools)
      if (rescued) {
        calls.push(rescued)
        text = ''
      }
    }

    if (calls.length === 0) {
      messages.push({ role: 'assistant', content: text })
      if (
        requireTool &&
        tools[requireTool] &&
        !requiredToolCalled &&
        !requiredToolNudged
      ) {
        requiredToolNudged = true
        messages.push({
          role: 'user',
          content: `You ended without calling ${requireTool}. Do not explain again — call ${requireTool} now with the change, then write one short sentence on what it changes.`,
        })
        continue
      }
      if (truncated) {
        yield {
          type: 'error',
          code: 'outputTruncated',
          message: `The reply was cut off at the ${limits.maxOutputTokens}-token output limit. Raise "Max output tokens" in the AI provider settings, or ask for a shorter answer.`,
        }
      }
      return yield { type: 'turnFinished', reason: 'stop' }
    }

    const incomplete = classifyIncompleteCalls(calls, truncated)

    messages.push({ role: 'assistant', content: text, toolCalls: calls })

    let turnSucceeded = false
    let turnFailed = false

    for (const call of calls) {
      yield {
        type: 'toolCallStarted',
        id: call.id,
        name: call.name,
        args: call.args,
      }

      const tool = tools[call.name]
      let result: unknown
      let isError = false

      const reason = incomplete.get(call)
      if (reason) {
        result = {
          status: 'error',
          error: incompleteCallError(call, reason, limits.maxOutputTokens),
        }
        isError = true
      } else if (!tool) {
        result = { error: `Unknown tool: ${call.name}` }
        isError = true
      } else {
        if (call.name === requireTool) requiredToolCalled = true
        if (tool.suspends) {
          yield { type: 'awaitingApproval', id: call.id, edit: call.args as any }
        }
        try {
          const toolHandle = tool.mutates ? handle : readOnlyHandle(handle)
          result = await tool.execute(call.args, toolHandle, { signal })
          isError = Boolean((result as any)?.error)
        } catch (error: any) {
          // A broken tool is data for the model, never the end of the run.
          result = { error: error?.message ?? 'The tool failed.' }
          isError = true
        }
      }

      const status = (result as any)?.status
      const isFailed =
        isError ||
        status === 'noMatch' ||
        status === 'ambiguous'
      let stop: StopReason | null = null

      if (isFailed) {
        turnFailed = true
        const callSig = `${call.name}:${JSON.stringify(call.args)}`
        const repeats = (failedCallSignatures.get(callSig) ?? 0) + 1
        failedCallSignatures.set(callSig, repeats)

        if (repeats >= IDENTICAL_FAILURE_LIMIT) {
          stop = {
            code: 'runawayToolLoop',
            message: `Stopped repeated failing call to ${call.name}. Please check the file contents or provide more specific instructions.`,
          }
        } else if (repeats === IDENTICAL_FAILURE_LIMIT - 1 && result && typeof result === 'object') {
          result = {
            ...(result as object),
            repeated: `This exact ${call.name} call has now failed ${repeats} times with the same arguments; one more identical failure ends the run. Change the arguments (re-read the file and copy its current text) or take a different approach.`,
          }
        }
      } else {
        turnSucceeded = true
        // The project changed, so a call that failed before may succeed now.
        if (status === 'applied') failedCallSignatures.clear()
      }

      // X, Y, X, Y with identical names and arguments makes no progress.
      // Mirrors the server loop.
      if (!stop) {
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
            stop = {
              code: 'runawayToolLoop',
              message: `Stopped repeated alternating tool loop between ${a.name} and ${b.name}.`,
            }
          }
        }
      }

      yield { type: 'toolCallFinished', id: call.id, result, isError }

      const rendered =
        tool?.render && !isError ? tool.render(result) : JSON.stringify(result)

      const safeContent =
        typeof rendered === 'string' && rendered.trim().length > 0
          ? rendered
          : '(empty result)'

      messages.push({
        role: 'tool',
        toolCallId: call.id || nextToolCallId('call'),
        name: call.name,
        content: safeContent,
        isError,
      })

      if (stop) {
        // Every tool call the assistant made needs a result, or the next
        // message in this conversation is rejected by the provider.
        for (const skipped of calls.slice(calls.indexOf(call) + 1)) {
          messages.push({
            role: 'tool',
            toolCallId: skipped.id || nextToolCallId('call'),
            name: skipped.name,
            content: JSON.stringify({ error: 'Not run: the turn was stopped.' }),
            isError: true,
          })
        }
        yield { type: 'error', ...stop }
        return yield { type: 'turnFinished', reason: 'stop' }
      }

      if (signal?.aborted) {
        return yield { type: 'turnFinished', reason: 'aborted' }
      }
    }

    if (turnSucceeded) {
      failedTurns = 0
    } else if (turnFailed) {
      failedTurns += 1
      if (failedTurns >= FAILED_TURN_LIMIT) {
        yield {
          type: 'error',
          code: 'consecutiveToolFailures',
          message: `Stopped after ${failedTurns} turns in a row in which every tool call failed. Please check the file contents or provide more specific instructions.`,
        }
        return yield { type: 'turnFinished', reason: 'stop' }
      }
    }
  }
}
