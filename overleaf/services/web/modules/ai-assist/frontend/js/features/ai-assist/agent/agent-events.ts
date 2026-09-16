import { EditRequest } from './project-handle'
import { ProviderErrorCode } from '../providers/types'

export type AgentEvent =
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'toolCallStarted'; id: string; name: string; args: unknown }
  | { type: 'toolCallFinished'; id: string; result: unknown; isError: boolean }
  | { type: 'awaitingApproval'; id: string; edit: EditRequest }
  | { type: 'turnFinished'; reason: 'stop' | 'budget' | 'aborted' }
  | {
      type: 'error'
      code: ProviderErrorCode
      message: string
      status?: number
      hint?: string
      upstreamCode?: string
      upstreamType?: string
    }
