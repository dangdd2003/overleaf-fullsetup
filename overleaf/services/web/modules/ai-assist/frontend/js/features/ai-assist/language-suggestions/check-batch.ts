import { ProviderSettings } from '../providers/types'
import {
  runWritingTool,
  StreamingClient,
} from '../writing-tools/run-writing-tool'
import { editsForCheck, MaskedEdit } from './edits'
import type { MaskedText } from './masked-text'
import { ParsedSentence, parseReply } from './parse-reply'
import {
  buildUserMessage,
  LANGUAGE_SUGGESTIONS_SYSTEM,
  PROMPT_VERSION,
  PromptRequest,
} from './prompt'

export type CheckTarget = { id: string; masked: MaskedText }

/** Every language check shares its instructions: one prompt cache for all. */
export const LANGUAGE_CHECK_CACHE_KEY = `ai-assist:language-suggestions:${PROMPT_VERSION}`

/** A sentence's edits; [] when there is nothing to suggest. */
export type CheckResult = { id: string; edits: MaskedEdit[] }

/** Room for the changed sentences (twice with style), a little more than they take, and for any reasoning. */
export function maxTokensForBatch(targets: CheckTarget[], style = false): number {
  const chars = targets.reduce((n, target) => n + target.masked.text.length, 0)
  return Math.max(1024, Math.ceil((chars * (style ? 2 : 1)) / 3) + 256)
}

/**
 * Sends one batch and reports each target as soon as its sentence is
 * complete in the reply. Resolves `malformed` when the reply follows no part
 * of the contract (nothing reported then); a provider error rejects, after
 * the results already reported.
 */
export async function checkBatch({
  request,
  targets,
  settings,
  signal,
  client,
  onResult,
}: {
  request: PromptRequest
  targets: CheckTarget[]
  settings: ProviderSettings
  signal?: AbortSignal
  client?: StreamingClient
  onResult: (result: CheckResult) => void
}): Promise<{ malformed: boolean }> {
  const byId = new Map(targets.map(target => [target.id, target]))
  const reported = new Set<string>()

  const report = (id: string, edits: MaskedEdit[]) => {
    reported.add(id)
    onResult({ id, edits })
  }

  /**
   * Reports each sentence once its results are in: its rewording (which
   * comes after its correction), a later sentence, or the end of the reply.
   * Without style, the correction is all there is.
   */
  const reportReady = (sentences: ParsedSentence[], done: boolean) => {
    const byTarget = new Map<string, { grammar?: string; style?: string }>()
    const order: string[] = []
    for (const sentence of sentences) {
      if (!byTarget.has(sentence.id)) {
        byTarget.set(sentence.id, {})
        order.push(sentence.id)
      }
      byTarget.get(sentence.id)![sentence.kind] = sentence.text
    }
    order.forEach((id, k) => {
      const target = byTarget.get(id)!
      const ready = done || !request.style || target.style !== undefined || k < order.length - 1
      const unit = byId.get(id)
      if (!ready || !unit || reported.has(id)) return
      report(id, editsForCheck(unit.masked, request.style ? target : { grammar: target.grammar }) ?? [])
    })
  }

  const reply = await runWritingTool({
    settings,
    system: LANGUAGE_SUGGESTIONS_SYSTEM,
    messages: [{ role: 'user', content: buildUserMessage(request) }],
    maxTokens: maxTokensForBatch(targets, request.style),
    signal,
    client,
    cacheKey: LANGUAGE_CHECK_CACHE_KEY,
    onText: text => reportReady(parseReply(text, false).sentences, false),
  })

  const parsed = parseReply(reply, true)
  reportReady(parsed.sentences, true)
  if (parsed.malformed) return { malformed: true }
  for (const target of targets) {
    if (!reported.has(target.id)) report(target.id, [])
  }
  return { malformed: false }
}
