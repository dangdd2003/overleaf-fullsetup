import { EditOutcome, EditRequest } from './project-handle'
import { ChatImage, ProviderErrorCode, ProviderRetry } from '../providers/types'
import { AgentMode } from './agent-mode'
import { CompactEntry, ContextTrim } from './agent-messages'
import { ContextUsageEvent } from './context/context-usage-types'
import { SlashCommandInvocation } from './slash-commands/types'

/** What started a `/compact` run: the user, or the context budget. */
export type RunTrigger = 'manual' | 'auto'

export type ApprovalKind =
  | 'edit'
  | 'settings'
  | 'plan'
  | 'connector'
  | 'connectorAuth'

export type SettingsApproval = {
  toolName: string
  args: Record<string, unknown>
}

export type ConnectorApproval = {
  connectorId: string
  connectorName: string
  toolName: string
  toolTitle?: string
  args?: Record<string, unknown>
}

export type ApprovalDecision = {
  accepted: boolean
  always?: boolean
  note?: string
  nextMode?: AgentMode
}

/** What the chat shows while an approval is pending, beyond the call itself. */
export type ApprovalContext = {
  startLine?: number
  kind?: ApprovalKind
  connector?: Partial<ConnectorApproval>
}

export type CompactPhase = 'masking' | 'summarizing' | 'verifying' | 'repairing'

export type AgentEvent =
  | ContextUsageEvent
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | {
      type: 'toolCallStarted'
      id: string
      name: string
      args: unknown
      /** The provider request the call came from; see ToolCallRecord.step. */
      step?: number
    }
  | {
      type: 'toolCallFinished'
      id: string
      name?: string
      result: unknown
      isError: boolean
      mode?: AgentMode
    }
  | {
      type: 'awaitingApproval'
      id: string
      kind?: ApprovalKind
      edit?: EditRequest
      settings?: SettingsApproval
      plan?: string
      connector?: ConnectorApproval
    }
  | { type: 'modeChanged'; mode: AgentMode; source: 'user' | 'planApproval' }
  /**
   * A message the user sent while the run was going, at the moment the run
   * actually read it. The panel has already shown it optimistically; this
   * confirms delivery, and is what a reconnecting tab replays from. It carries
   * the envelope the run was sent, so a tab that never saw the message still
   * stores the turn the run read.
   */
  | {
      type: 'userMessage'
      id: string
      text: string
      contextText?: string
      commandText?: string
      command?: SlashCommandInvocation
      images?: ChatImage[]
    }
  | { type: 'chatTitle'; title: string; chatId?: string }
  /**
   * Replaces the text the current provider request has streamed so far: the
   * request was retried, or a tool call written as text was taken out of it.
   */
  | { type: 'stepText'; text: string }
  /** The run asked the model for the reply it ended without; see `nudge`. */
  | { type: 'nudge' }
  /** What the context budget has cut so far; see `contextTrim`. */
  | { type: 'contextTrimmed'; trim: ContextTrim }
  /** A server run asks the editor to compile, as its Recompile button would. */
  | { type: 'awaitingCompile'; id: string; clean: boolean }
  /** A `/compact` run started; see CompactPhase for the phases. */
  | { type: 'compactStarted'; trigger: RunTrigger }
  | {
      type: 'compactProgress'
      phase: CompactPhase
      chunk?: number
      chunks?: number
    }
  /** The new boundary. The server has assigned its id and creation time. */
  | { type: 'compactFinished'; entry: CompactEntry }
  /**
   * An automatic compaction mid-run failed (or had nothing to gain, or no
   * progress). The run goes on with the messages it had.
   */
  | {
      type: 'compactFailed'
      trigger: 'auto'
      code: 'compactFailed' | 'compactNoProgress' | 'compactNothing'
      message: string
    }
  /**
   * A provider request failed in a way that retries, and runs again after
   * `retryInMs`. Cleared by the next model output, tool call or the run's end;
   * see reduceAgentEvent.
   */
  | ({ type: 'retrying' } & ProviderRetry)
  | { type: 'turnFinished'; reason: 'stop' | 'aborted' | 'interrupted' }
  | {
      type: 'error'
      /** A provider failure, or how a `/compact` run ended without a boundary. */
      code: ProviderErrorCode | 'compactFailed' | 'compactNothing'
      message: string
      status?: number
      hint?: string
    }

export type AppliedEdit = Extract<EditOutcome, { status: 'applied' }> & {
  mode?: AgentMode
  detached?: boolean
}

export function isAppliedEdit(result: unknown): result is AppliedEdit {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { status?: unknown }).status === 'applied'
  )
}

/**
 * Tells the editor to glow the lines an applied `edit_file` / `create_file`
 * call changed. Other tools and unapplied results are ignored.
 */
export function dispatchAiEditHighlight(
  name: string,
  result: unknown,
  mode: AgentMode = 'manual',
  detached?: boolean
) {
  if (
    (name !== 'edit_file' && name !== 'create_file') ||
    !isAppliedEdit(result)
  ) {
    return
  }
  window.dispatchEvent(
    new CustomEvent('aiAssist:highlightAiEdit', {
      detail: {
        path: result.path,
        startLine: result.startLine,
        endLine: result.endLine,
        newText: result.newText,
        oldText: result.oldText,
        mode: result.mode || mode,
        detached: Boolean(detached || result.detached),
      },
    })
  )
}

