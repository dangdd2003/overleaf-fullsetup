import { AgentMessage } from '../providers/types'

/** Where a generator's card is, from the first request to the result. */
export type GeneratorPhase<Reply> =
  | { name: 'consent' }
  | { name: 'noProvider' }
  | { name: 'streaming'; reply: Reply | null; repairing: boolean }
  | { name: 'ready' }
  | { name: 'cannot'; reason: string }
  | { name: 'imageUnsupported' }
  | { name: 'empty' }
  | { name: 'error'; message: string; hint?: string }

export type GeneratorProgress<Reply> =
  | { stage: 'writing'; reply: Reply }
  | { stage: 'repairing' }

/** Outcomes without a result to show. */
export type NonResult =
  | { kind: 'cannot'; reason: string }
  | { kind: 'imageUnsupported' }
  | { kind: 'empty' }

/** One result, with the conversation that produced it (for follow-ups and retries). */
export type Versioned<Result> = Result & { messages: AgentMessage[] }

export function isNonResult<R>(outcome: R | NonResult): outcome is NonResult {
  const kind = (outcome as { kind?: string }).kind
  return kind === 'cannot' || kind === 'imageUnsupported' || kind === 'empty'
}
