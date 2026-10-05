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
  chatTitle?: string
  isTitleGenerated?: boolean
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
  mode: AgentMode = 'manual',
  chatTitle: string = ''
): AgentState {
  return {
    transcript,
    running: false,
    mode,
    chatTitle,
    isTitleGenerated: false,
    stoppedByUser: false,
    pendingApproval: null,
    error: null,
  }
}

/** Messages at the end still queued, which the live reply is shown above. */
export function countTrailingPendingUserEntries(
  transcript: TranscriptEntry[]
): number {
  let count = 0
  for (let i = transcript.length - 1; i >= 0; i--) {
    const entry = transcript[i]
    if (entry.role === 'user' && entry.pending) {
      count++
    } else {
      break
    }
  }
  return count
}

/**
 * The transcript without the reply a live run is still writing: the
 * assistant entry above any messages still queued. A run replayed from its
 * first event rebuilds that reply, so keeping it would show it twice.
 */
export function withoutLiveReply(
  transcript: TranscriptEntry[]
): TranscriptEntry[] {
  const at = transcript.length - 1 - countTrailingPendingUserEntries(transcript)
  if (at < 0 || transcript[at].role !== 'assistant') return transcript
  return [...transcript.slice(0, at), ...transcript.slice(at + 1)]
}

export function openAssistantTurn(
  transcript: TranscriptEntry[]
): { transcript: TranscriptEntry[]; targetIndex: number } {
  const pendingCount = countTrailingPendingUserEntries(transcript)
  if (pendingCount > 0) {
    const insertIdx = transcript.length - pendingCount
    const prev = insertIdx > 0 ? transcript[insertIdx - 1] : null
    if (prev && prev.role === 'assistant') {
      return { transcript, targetIndex: insertIdx - 1 }
    }
    const newEntry: TranscriptEntry = {
      id: `a${insertIdx}`,
      role: 'assistant',
      text: '',
      toolCalls: [],
      blocks: [],
    }
    const updated = [
      ...transcript.slice(0, insertIdx),
      newEntry,
      ...transcript.slice(insertIdx),
    ]
    return { transcript: updated, targetIndex: insertIdx }
  }

  const last = transcript.at(-1)
  if (last && last.role === 'assistant') {
    return { transcript, targetIndex: transcript.length - 1 }
  }
  const newEntry: TranscriptEntry = {
    id: `a${transcript.length}`,
    role: 'assistant',
    text: '',
    toolCalls: [],
    blocks: [],
  }
  return {
    transcript: [...transcript, newEntry],
    targetIndex: transcript.length,
  }
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
  const { transcript: opened, targetIndex } = openAssistantTurn(transcript)
  const target = opened[targetIndex] as Extract<
    TranscriptEntry,
    { role: 'assistant' }
  >
  const blocks: AssistantBlock[] = [...(target.blocks ?? [])]
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
  const updated = [...opened]
  updated[targetIndex] = {
    ...target,
    thinking: (target.thinking ?? '') + text,
    blocks,
  }
  return updated
}

export function appendText(
  transcript: TranscriptEntry[],
  text: string,
  now: number = Date.now()
) {
  const { transcript: opened, targetIndex } = openAssistantTurn(transcript)
  const target = opened[targetIndex] as Extract<
    TranscriptEntry,
    { role: 'assistant' }
  >
  const blocks: AssistantBlock[] = finalizeThinkingBlock(
    [...(target.blocks ?? [])],
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
  const updated = [...opened]
  updated[targetIndex] = {
    ...target,
    text: target.text + text,
    blocks,
  }
  return updated
}

/**
 * Records that the run has read a message the user sent mid-run.
 *
 * The panel adds the entry optimistically the moment it is sent, so the usual
 * case is clearing `pending` on an entry that is already here. A tab that was
 * not the sender — or one replaying the run after a reconnect — has never seen
 * it, and adds it instead.
 *
 * Either way the entry lands after everything already delivered and ahead of
 * what is still queued, which is the order the run read them in, and keeps
 * the envelope the run was sent. The stored transcript then rebuilds into the
 * messages the run sent, and the next run reads them from the provider's
 * cache.
 */
export function deliverUserMessage(
  transcript: TranscriptEntry[],
  message: { id: string; text: string; contextText?: string }
): TranscriptEntry[] {
  const index = transcript.findIndex(entry => entry.id === message.id)
  const found = index === -1 ? null : transcript[index]
  if (found && (found.role !== 'user' || !found.pending)) return transcript

  const { pending: _pending, ...entry } =
    found && found.role === 'user'
      ? found
      : { id: message.id, role: 'user' as const, text: message.text }
  const delivered: TranscriptEntry = {
    ...entry,
    ...(message.contextText !== undefined
      ? { contextText: message.contextText }
      : {}),
    sentDuringRun: true,
  }

  const rest =
    index === -1
      ? transcript
      : [...transcript.slice(0, index), ...transcript.slice(index + 1)]
  const at = rest.length - countTrailingPendingUserEntries(rest)
  return [...rest.slice(0, at), delivered, ...rest.slice(at)]
}

export function appendToolCall(
  transcript: TranscriptEntry[],
  call: ToolCallRecord,
  now: number = Date.now()
) {
  const { transcript: opened, targetIndex } = openAssistantTurn(transcript)
  const last = opened[targetIndex] as Extract<
    TranscriptEntry,
    { role: 'assistant' }
  >

  // If this tool call is already registered in last.toolCalls, update it rather than duplicating
  if (last.toolCalls.some(c => c.id === call.id)) {
    const updatedCalls = last.toolCalls.map(c =>
      c.id === call.id ? { ...c, ...call } : c
    )
    const updatedBlocks = last.blocks?.map(b =>
      b.type === 'tool_call' && b.call.id === call.id
        ? { ...b, call: { ...b.call, ...call } }
        : b
    )
    const updated = [...opened]
    updated[targetIndex] = {
      ...last,
      toolCalls: updatedCalls,
      ...(updatedBlocks ? { blocks: updatedBlocks } : {}),
    }
    return updated
  }

  const blocks: AssistantBlock[] = finalizeThinkingBlock(
    [...(last.blocks ?? [])],
    now
  )
  blocks.push({ type: 'tool_call', call })
  const updated = [...opened]
  updated[targetIndex] = {
    ...last,
    toolCalls: [...last.toolCalls, call],
    blocks,
  }
  return updated
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
          call: {
            ...block.call,
            result: { status: 'stopped' },
            isError: false,
          },
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

type AssistantEntry = Extract<TranscriptEntry, { role: 'assistant' }>

function updateAssistantTurn(
  transcript: TranscriptEntry[],
  update: (entry: AssistantEntry) => AssistantEntry
): TranscriptEntry[] {
  const { transcript: opened, targetIndex } = openAssistantTurn(transcript)
  const updated = [...opened]
  updated[targetIndex] = update(opened[targetIndex] as AssistantEntry)
  return updated
}

/**
 * Replaces the text of the provider request still going: the text blocks
 * after the turn's last tool call. Thinking stays, as it was shown.
 */
export function replaceStepText(
  transcript: TranscriptEntry[],
  text: string
): TranscriptEntry[] {
  return updateAssistantTurn(transcript, entry => {
    const blocks = [...(entry.blocks ?? [])]
    let start = blocks.length
    while (start > 0 && blocks[start - 1].type !== 'tool_call') start--
    let removed = 0
    let at = -1
    const kept: AssistantBlock[] = []
    blocks.slice(start).forEach(block => {
      if (block.type === 'text') {
        removed += block.text.length
        if (at === -1) at = kept.length
      } else {
        kept.push(block)
      }
    })
    if (text) {
      kept.splice(at === -1 ? kept.length : at, 0, { type: 'text', text })
    }
    return {
      ...entry,
      text: entry.text.slice(0, entry.text.length - removed) + text,
      blocks: [...blocks.slice(0, start), ...kept],
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
          ...(event.step !== undefined ? { step: event.step } : {}),
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
    case 'userMessage':
      return {
        ...state,
        transcript: deliverUserMessage(state.transcript, event),
      }
    case 'stepText':
      return {
        ...state,
        transcript: replaceStepText(state.transcript, event.text),
      }
    case 'nudge':
      return {
        ...state,
        transcript: updateAssistantTurn(state.transcript, entry => {
          const lastCall = [...(entry.blocks ?? [])]
            .reverse()
            .find(block => block.type === 'tool_call')
          const after =
            lastCall?.type === 'tool_call'
              ? lastCall.call.id
              : (entry.toolCalls.at(-1)?.id ?? null)
          return { ...entry, nudge: { after } }
        }),
      }
    case 'contextTrimmed':
      return {
        ...state,
        transcript: updateAssistantTurn(state.transcript, entry => ({
          ...entry,
          contextTrim: event.trim,
        })),
      }
    case 'chatTitle':
      return { ...state, chatTitle: event.title, isTitleGenerated: true }
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
          ...(event.upstreamCode != null
            ? { upstreamCode: event.upstreamCode }
            : {}),
          ...(event.upstreamType != null
            ? { upstreamType: event.upstreamType }
            : {}),
        },
      }
    default:
      return state
  }
}
