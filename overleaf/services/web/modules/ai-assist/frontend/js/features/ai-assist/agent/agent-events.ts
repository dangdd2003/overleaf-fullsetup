import { EditRequest } from './project-handle'
import { ProviderErrorCode } from '../providers/types'
import { AgentMode } from './agent-mode'

export type ApprovalKind = 'edit' | 'settings' | 'plan'

export type SettingsApproval = {
  toolName: string
  args: Record<string, unknown>
}

export type AgentEvent =
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'toolCallStarted'; id: string; name: string; args: unknown }
  | { type: 'toolCallFinished'; id: string; result: unknown; isError: boolean }
  | {
      type: 'awaitingApproval'
      id: string
      kind?: ApprovalKind
      edit?: EditRequest
      settings?: SettingsApproval
      plan?: string
    }
  | { type: 'modeChanged'; mode: AgentMode; source: 'user' | 'planApproval' }
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
