import { AgentMessage, ProviderSettings } from '../providers/types'
import { runWritingTool, StreamingClient } from '../writing-tools/run-writing-tool'
import { splitWhitespace } from '../writing-tools/prompt'
import { Expect, parseReply, ParsedReply } from './parse-output'
import { buildRepairMessage, TEXGPT_SYSTEM } from './prompt'
import {
  editWarnings,
  missingPackages,
  packageWarning,
  structureProblems,
  TexGptWarning,
} from './checks'

/** Room for a long table or figure; `runWritingTool` caps it at the model's limit. */
export const TEXGPT_MAX_TOKENS = 8192

export type TexGptOutcome =
  | {
      kind: 'latex'
      text: string
      /** Packages the code needs that the project does not load. */
      packages: string[]
      warnings: TexGptWarning[]
      /** The reply as sent, for a follow-up or retry conversation. */
      raw: string
    }
  | { kind: 'answer'; text: string; raw: string }
  | { kind: 'options'; options: string[]; raw: string }
  | { kind: 'unchanged' }
  | { kind: 'cannot'; reason: string }
  | { kind: 'empty' }

export type TexGptProgress =
  | { stage: 'writing'; reply: ParsedReply }
  | { stage: 'repairing' }

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * One TeXGPT request: a single model call, its reply parsed and checked
 * deterministically, and — only when the LaTeX structure is broken — one
 * repair turn that shows the model its own reply and the problems. The
 * repaired version is kept only when it is better.
 *
 * `original` is the text being replaced, as it is in the document
 * (surrounding whitespace included); empty when inserting.
 */
export async function generateTexGpt({
  messages,
  expect = 'latex',
  original = '',
  loaded,
  docClass,
  settings,
  signal,
  onProgress,
  client,
}: {
  messages: AgentMessage[]
  expect?: Expect
  original?: string
  loaded: Set<string>
  docClass: string | null
  settings: ProviderSettings
  signal?: AbortSignal
  onProgress: (progress: TexGptProgress) => void
  client?: StreamingClient
}): Promise<TexGptOutcome> {
  const call = (conversation: AgentMessage[], onText: (text: string) => void) =>
    runWritingTool({
      settings,
      system: TEXGPT_SYSTEM,
      messages: conversation,
      maxTokens: TEXGPT_MAX_TOKENS,
      signal,
      onText,
      client,
    })

  const raw = await call(messages, text =>
    onProgress({ stage: 'writing', reply: parseReply(text, false, expect) })
  )
  const reply = parseReply(raw, true, expect)
  if (reply.kind === 'cannot') return { kind: 'cannot', reason: reply.reason }
  if (reply.kind === 'answer') {
    return reply.text ? { kind: 'answer', text: reply.text, raw } : { kind: 'empty' }
  }
  if (reply.kind === 'options') {
    return reply.options.length
      ? { kind: 'options', options: reply.options, raw }
      : { kind: 'empty' }
  }
  if (!reply.text.trim()) return { kind: 'empty' }

  const replacing = original.trim() !== ''
  if (replacing && squash(reply.text) === squash(original)) {
    return { kind: 'unchanged' }
  }
  // The selection's surrounding whitespace is the document's; put it back
  const { lead, trail } = splitWhitespace(original)
  const shape = (text: string) => (replacing ? lead + text.trim() + trail : text)

  let text = shape(reply.text)
  let declared = reply.packages
  let finalRaw = raw
  const problems = structureProblems(original, text)
  if (problems.length > 0) {
    onProgress({ stage: 'repairing' })
    try {
      const repairedRaw = await call(
        [
          ...messages,
          { role: 'assistant', content: raw },
          { role: 'user', content: buildRepairMessage(problems) },
        ],
        () => {}
      )
      const repaired = parseReply(repairedRaw, true, 'latex')
      if (repaired.kind === 'latex' && repaired.text.trim()) {
        const repairedText = shape(repaired.text)
        if (structureProblems(original, repairedText).length < problems.length) {
          text = repairedText
          declared = repaired.packages.length ? repaired.packages : declared
          finalRaw = repairedRaw
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error
      // The first version, with its warnings, is still worth showing
    }
  }

  const warnings: TexGptWarning[] = [
    ...structureProblems(original, text).map(message => ({
      kind: 'structure' as const,
      message,
    })),
    ...(replacing ? editWarnings(original, text) : []),
  ]
  const missing = missingPackages(text, declared, loaded, docClass)
  const note = packageWarning(missing)
  if (note) warnings.push(note)
  return { kind: 'latex', text, packages: missing, warnings, raw: finalRaw }
}
