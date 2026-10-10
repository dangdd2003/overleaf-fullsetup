import { EditRequest } from './project-handle'
import { ProviderErrorCode } from '../providers/types'
import { AgentMode } from './agent-mode'
import { ContextTrim } from './agent-messages'

export type ApprovalKind = 'edit' | 'settings' | 'plan'

export type SettingsApproval = {
  toolName: string
  args: Record<string, unknown>
}

export type AgentEvent =
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
    }
  | { type: 'modeChanged'; mode: AgentMode; source: 'user' | 'planApproval' }
  /**
   * A message the user sent while the run was going, at the moment the run
   * actually read it. The panel has already shown it optimistically; this
   * confirms delivery, and is what a reconnecting tab replays from. It carries
   * the envelope the run was sent, so a tab that never saw the message still
   * stores the turn the run read.
   */
  | { type: 'userMessage'; id: string; text: string; contextText?: string }
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
  | { type: 'turnFinished'; reason: 'stop' | 'aborted' | 'interrupted' }
  | {
      type: 'error'
      code: ProviderErrorCode
      message: string
      status?: number
      hint?: string
      upstreamCode?: string
      upstreamType?: string
    }

/**
 * Tells the editor to glow the lines an applied `edit_file` / `create_file`
 * call changed. Other tools and unapplied results are ignored.
 */
export function dispatchAiEditHighlight(
  name: string,
  result: any,
  mode: AgentMode = 'manual',
  detached?: boolean
) {
  if (
    (name !== 'edit_file' && name !== 'create_file') ||
    result?.status !== 'applied'
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

