import { AgentEvent, ApprovalKind, SettingsApproval } from './agent-events'
import {
  TranscriptEntry,
  ToolCallRecord,
  AssistantBlock,
} from './agent-messages'
import { EditRequest } from './project-handle'
import { AgentMode } from './agent-mode'

export type PendingApproval = {
  id: string
  kind: ApprovalKind
  edit?: EditRequest
  settings?: SettingsApproval
  plan?: string
}

export type AgentState = {
  transcript: TranscriptEntry[]
  running: boolean
  mode: AgentMode
  stoppedByUser: boolean
  pendingApproval: PendingApproval | null
  error: {
    code: string
    message: string
    status?: number
    hint?: string
    upstreamCode?: string
    upstreamType?: string
  } | null
}

export function emptyAgentState(
  transcript: TranscriptEntry[] = [],
  mode: AgentMode = 'manual'
): AgentState {
  return {
    transcript,
    running: false,
    mode,
    stoppedByUser: false,
    pendingApproval: null,
    error: null,
  }
}

export function openAssistantTurn(
  transcript: TranscriptEntry[]
): TranscriptEntry[] {
  const last = transcript.at(-1)
  if (last && last.role === 'assistant') return transcript
  return [
    ...transcript,
    {
      id: `a${transcript.length}`,
      role: 'assistant',
      text: '',
      toolCalls: [],
      blocks: [],
    },
  ]
}

function finalizeThinkingBlock(
  blocks: AssistantBlock[],
  now: number = Date.now()
): AssistantBlock[] {
  const lastBlock = blocks.at(-1)
  if (lastBlock && lastBlock.type === 'thinking' && !lastBlock.elapsedMs) {
    const elapsedMs = Math.max(1000, now - (lastBlock.startedAt ?? now))
    return [
      ...blocks.slice(0, -1),
      {
        ...lastBlock,
        elapsedMs,
      },
    ]
  }
  return blocks
}

export function appendThinking(
  transcript: TranscriptEntry[],
  text: string,
  now: number = Date.now()
) {
  const opened = openAssistantTurn(transcript)
  const last = opened.at(-1) as Extract<TranscriptEntry, { role: 'assistant' }>
  const blocks: AssistantBlock[] = [...(last.blocks ?? [])]
  const lastBlock = blocks.at(-1)
  if (lastBlock && lastBlock.type === 'thinking') {
    blocks[blocks.length - 1] = {
      ...lastBlock,
      thinking: lastBlock.thinking + text,
    }
  } else {
    blocks.push({
      type: 'thinking',
      thinking: text,
      startedAt: now,
    })
  }
  return [
    ...opened.slice(0, -1),
    {
      ...last,
      thinking: (last.thinking ?? '') + text,
      blocks,
    },
  ]
}

export function appendText(
  transcript: TranscriptEntry[],
  text: string,
  now: number = Date.now()
) {
  const opened = openAssistantTurn(transcript)
  const last = opened.at(-1) as Extract<TranscriptEntry, { role: 'assistant' }>
  const blocks: AssistantBlock[] = finalizeThinkingBlock(
    [...(last.blocks ?? [])],
    now
  )
  const lastBlock = blocks.at(-1)
  if (lastBlock && lastBlock.type === 'text') {
    blocks[blocks.length - 1] = {
      ...lastBlock,
      text: lastBlock.text + text,
    }
  } else {
    blocks.push({ type: 'text', text })
  }
  return [
    ...opened.slice(0, -1),
    {
      ...last,
      text: last.text + text,
      blocks,
    },
  ]
}

export function appendToolCall(
  transcript: TranscriptEntry[],
  call: ToolCallRecord,
  now: number = Date.now()
) {
  const opened = openAssistantTurn(transcript)
  const last = opened.at(-1) as Extract<TranscriptEntry, { role: 'assistant' }>

  // If this tool call is already registered in last.toolCalls, update it rather than duplicating
  if (last.toolCalls.some(c => c.id === call.id)) {
    const updatedCalls = last.toolCalls.map(c => c.id === call.id ? { ...c, ...call } : c)
    const updatedBlocks = last.blocks?.map(b =>
      b.type === 'tool_call' && b.call.id === call.id
        ? { ...b, call: { ...b.call, ...call } }
        : b
    )
    return [
      ...opened.slice(0, -1),
      {
        ...last,
        toolCalls: updatedCalls,
        ...(updatedBlocks ? { blocks: updatedBlocks } : {}),
      },
    ]
  }

  const blocks: AssistantBlock[] = finalizeThinkingBlock(
    [...(last.blocks ?? [])],
    now
  )
  blocks.push({ type: 'tool_call', call })
  return [
    ...opened.slice(0, -1),
    {
      ...last,
      toolCalls: [...last.toolCalls, call],
      blocks,
    },
  ]
}

export function finishToolCall(
  transcript: TranscriptEntry[],
  id: string,
  result: unknown,
  isError: boolean
) {
  return transcript.map(entry => {
    if (entry.role !== 'assistant') return entry
    const toolCalls = (entry.toolCalls || []).map(call =>
      call?.id === id ? { ...call, result, isError } : call
    )
    const blocks = entry.blocks?.map(block =>
      block && block.type === 'tool_call' && block.call && block.call.id === id
        ? { ...block, call: { ...block.call, result, isError } }
        : block
    )
    return {
      ...entry,
      toolCalls,
      ...(blocks ? { blocks } : {}),
    }
  })
}

export function cancelPendingToolCalls(
  transcript: TranscriptEntry[]
): TranscriptEntry[] {
  return transcript.map(entry => {
    if (entry.role !== 'assistant') return entry
    let changed = false
    const toolCalls = (entry.toolCalls || []).map(call => {
      if (!('result' in call) || call.result === undefined) {
        changed = true
        return { ...call, result: { status: 'stopped' }, isError: false }
      }
      return call
    })
    const blocks = entry.blocks?.map(block => {
      if (
        block &&
        block.type === 'tool_call' &&
        block.call &&
        (!('result' in block.call) || block.call.result === undefined)
      ) {
        changed = true
        return {
          ...block,
          call: { ...block.call, result: { status: 'stopped' }, isError: false },
        }
      }
      return block
    })
    if (!changed) return entry
    return {
      ...entry,
      toolCalls,
      ...(blocks ? { blocks } : {}),
    }
  })
}

export function reduceAgentEvent(
  state: AgentState,
  event: AgentEvent
): AgentState {
  switch (event.type) {
    case 'thinking':
      return {
        ...state,
        transcript: appendThinking(state.transcript, event.text),
      }
    case 'text':
      return { ...state, transcript: appendText(state.transcript, event.text) }
    case 'toolCallStarted':
      return {
        ...state,
        transcript: appendToolCall(state.transcript, {
          id: event.id,
          name: event.name,
          args: event.args,
        }),
      }
    case 'toolCallFinished':
      return {
        ...state,
        pendingApproval:
          state.pendingApproval?.id === event.id ? null : state.pendingApproval,
        transcript: finishToolCall(
          state.transcript,
          event.id,
          event.result,
          event.isError
        ),
      }
    case 'modeChanged':
      return { ...state, mode: event.mode }
    case 'awaitingApproval':
      return {
        ...state,
        pendingApproval: {
          id: event.id,
          kind: event.kind || 'edit',
          edit: event.edit,
          settings: event.settings,
          plan: event.plan,
        },
      }
    case 'turnFinished': {
      const last = state.transcript.at(-1)
      let nextTranscript = state.transcript
      if (last && last.role === 'assistant' && last.blocks) {
        const finalizedBlocks = finalizeThinkingBlock(last.blocks)
        nextTranscript = [
          ...state.transcript.slice(0, -1),
          {
            ...last,
            blocks: finalizedBlocks,
          },
        ]
      }
      const stoppedByUser = event.reason === 'aborted'
      const interrupted = event.reason === 'interrupted'
      if (stoppedByUser || interrupted) {
        nextTranscript = cancelPendingToolCalls(nextTranscript)
      }
      return {
        ...state,
        transcript: nextTranscript,
        running: false,
        stoppedByUser,
        pendingApproval: null,
        error: stoppedByUser
          ? null
          : interrupted
            ? { code: 'interrupted', message: 'This run was interrupted.' }
            : state.error,
      }
    }
    case 'error':
      return {
        ...state,
        transcript: cancelPendingToolCalls(state.transcript),
        running: false,
        pendingApproval: null,
        error: {
          code: event.code,
          message: event.message,
          ...(event.status != null ? { status: event.status } : {}),
          ...(event.hint != null ? { hint: event.hint } : {}),
          ...(event.upstreamCode != null ? { upstreamCode: event.upstreamCode } : {}),
          ...(event.upstreamType != null ? { upstreamType: event.upstreamType } : {}),
        },
      }
    default:
      return state
  }
}
