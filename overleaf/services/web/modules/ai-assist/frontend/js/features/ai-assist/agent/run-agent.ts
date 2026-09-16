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
import {
  extractFencedToolCall,
  parseWholeMessageToolCall,
} from './text-tool-call'

export const MAX_STEPS = 30

export async function* runAgent({
  client,
  handle,
  tools,
  transcript,
  limits = DEFAULT_LIMITS.openai,
  cacheKey,
  maxSteps = MAX_STEPS,
  signal,
  systemPrompt,
}: {
  client: ProviderClient
  handle: ProjectHandle
  tools: Record<string, AgentTool>
  transcript: TranscriptEntry[]
  limits?: Limits
  cacheKey?: string
  maxSteps?: number
  signal?: AbortSignal
  /** Lets a narrow run (the compile-log fix) swap in its own prompt. */
  systemPrompt?: string
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
    yield {
      type: 'error',
      code: 'contextExhausted',
      message:
        'This conversation no longer fits in the model context window. Start a new chat to continue.',
    }
    return yield { type: 'turnFinished', reason: 'stop' }
  }

  const system = request.system
  const messages: AgentMessage[] = request.messages

  let steps = 0
  let consecutiveFailures = 0
  const failedCallSignatures: string[] = []

  while (true) {
    let text = ''
    const calls: ToolCall[] = []
    let inThinkTag = false
    let held = ''
    let convertedThisTurn = false

    try {
      for await (const chunk of client.streamChat({
        system,
        messages,
        maxTokens: limits.maxOutputTokens,
        tools: specs.length ? specs : undefined,
        cacheHints: request.cacheHints,
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
          const id = chunk.id || `call_${Date.now()}_${calls.length}`
          calls.push({ id, name: chunk.name, args: chunk.args })
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
      return yield { type: 'turnFinished', reason: 'stop' }
    }

    messages.push({ role: 'assistant', content: text, toolCalls: calls })

    for (const call of calls) {
      if (steps >= maxSteps) {
        return yield { type: 'turnFinished', reason: 'budget' }
      }
      steps += 1

      yield {
        type: 'toolCallStarted',
        id: call.id,
        name: call.name,
        args: call.args,
      }

      const tool = tools[call.name]
      let result: unknown
      let isError = false

      if (!tool) {
        result = { error: `Unknown tool: ${call.name}` }
        isError = true
      } else {
        if (tool.suspends) {
          yield { type: 'awaitingApproval', id: call.id, edit: call.args as any }
        }
        try {
          const toolHandle = tool.mutates ? handle : readOnlyHandle(handle)
          result = await tool.execute(call.args, toolHandle)
          isError = Boolean((result as any)?.error)
        } catch (error: any) {
          // A broken tool is data for the model, never the end of the run.
          result = { error: error?.message ?? 'The tool failed.' }
          isError = true
        }
      }

      yield { type: 'toolCallFinished', id: call.id, result, isError }

      const isFailed =
        isError ||
        (result as any)?.status === 'noMatch' ||
        (result as any)?.status === 'ambiguous'

      if (isFailed) {
        consecutiveFailures += 1
        const callSig = `${call.name}:${JSON.stringify(call.args)}`
        failedCallSignatures.push(callSig)
        const identicalFailedCount = failedCallSignatures.filter(s => s === callSig).length

        if (identicalFailedCount >= 2) {
          yield {
            type: 'error',
            code: 'runawayToolLoop',
            message: `Stopped repeated failing call to ${call.name}. Please check the file contents or provide more specific instructions.`,
          }
          return yield { type: 'turnFinished', reason: 'stop' }
        }

        if (consecutiveFailures >= 3) {
          yield {
            type: 'error',
            code: 'consecutiveToolFailures',
            message: `Stopped after ${consecutiveFailures} consecutive failed tool operations. Please check the file contents or provide more specific instructions.`,
          }
          return yield { type: 'turnFinished', reason: 'stop' }
        }
      } else {
        consecutiveFailures = 0
      }

      const rendered =
        tool?.render && !isError ? tool.render(result) : JSON.stringify(result)

      const safeContent =
        typeof rendered === 'string' && rendered.trim().length > 0
          ? rendered
          : '(empty result)'

      messages.push({
        role: 'tool',
        toolCallId: call.id || `call_${Date.now()}`,
        name: call.name,
        content: safeContent,
        isError,
      })

      if (signal?.aborted) {
        return yield { type: 'turnFinished', reason: 'aborted' }
      }
    }
  }
}
