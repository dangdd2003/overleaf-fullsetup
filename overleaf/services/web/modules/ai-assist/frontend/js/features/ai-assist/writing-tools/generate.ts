import { AgentMessage, ProviderSettings } from '../providers/types'
import {
  buildRepairMessage,
  buildUserMessage,
  WRITING_TOOLS_SYSTEM,
  WritingRequest,
} from './prompt'
import { parseRewrite, parseSynonyms } from './parse-output'
import { checkLatex, LatexWarning } from './latex-check'
import { maxTokensFor, runWritingTool, StreamingClient } from './run-writing-tool'
import { scriptWarning, ScriptWarning } from './script-support'

export type WritingWarning =
  | LatexWarning
  | { kind: 'context'; message: string }
  | ScriptWarning

export type WritingOutcome =
  | { kind: 'rewrite'; text: string; warnings: WritingWarning[] }
  | { kind: 'unchanged' }
  | { kind: 'synonyms'; options: string[] }
  | { kind: 'cannot'; reason: string }
  | { kind: 'empty' }

export type WritingProgress =
  | { stage: 'writing'; text: string; options: string[] }
  | { stage: 'repairing'; text: string }

/** Problems worth one automatic repair turn; an added key may be intended. */
const REPAIRABLE = new Set<WritingWarning['kind']>([
  'droppedKey',
  'math',
  'environment',
  'braces',
  'context',
])

/** Long enough that a match is a copy, not a coincidence. */
const ECHO_CHARS = 30

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * The result repeats text from around the selection: the model continued
 * into the context instead of stopping at the selection's end, or started
 * before it. Pasting it would duplicate that text in the document.
 */
export function contextEchoes(
  original: string,
  result: string,
  before: string,
  after: string
): WritingWarning[] {
  const text = squash(result)
  const source = squash(original)
  const head = squash(after).slice(0, ECHO_CHARS)
  const tail = squash(before).slice(-ECHO_CHARS)
  const echoes = (piece: string) =>
    piece.length === ECHO_CHARS &&
    text.includes(piece) &&
    !source.includes(piece)
  return echoes(head) || echoes(tail)
    ? [
        {
          kind: 'context',
          message: 'The result repeats text from around the selection',
        },
      ]
    : []
}

function check(
  request: WritingRequest,
  original: string,
  result: string,
  doc: string | undefined
): WritingWarning[] {
  const warnings: WritingWarning[] = [
    ...checkLatex(original, result, {
      translate: request.action === 'translate',
    }),
    ...contextEchoes(original, result, request.before, request.after),
  ]
  if (request.action === 'translate' && doc !== undefined) {
    const script = scriptWarning(request.targetLanguage, doc)
    if (script) warnings.push(script)
  }
  return warnings
}

function repairable(warnings: WritingWarning[]): WritingWarning[] {
  return warnings.filter(warning => REPAIRABLE.has(warning.kind))
}

function splitEdges(text: string) {
  const lead = text.match(/^\s*/)?.[0] ?? ''
  const trail = text.slice(lead.length).match(/\s*$/)?.[0] ?? ''
  return { lead, trail }
}

/**
 * One writing-tool run: a single model call, its reply parsed and checked
 * deterministically, and — only when the check finds broken LaTeX or copied
 * context — one repair turn that shows the model its own reply and the
 * problems. The repaired version is kept only when it is better.
 *
 * `original` is the selection as it is in the document, surrounding
 * whitespace included; `request.selection` is the same text trimmed.
 */
export async function generate({
  request,
  original,
  doc,
  settings,
  signal,
  onProgress,
  client,
}: {
  request: WritingRequest
  original: string
  /** The open file, for checks that need the document's setup. */
  doc?: string
  settings: ProviderSettings
  signal?: AbortSignal
  onProgress: (progress: WritingProgress) => void
  client?: StreamingClient
}): Promise<WritingOutcome> {
  const user: AgentMessage = {
    role: 'user',
    content: buildUserMessage(request),
  }
  const call = (messages: AgentMessage[], onText: (text: string) => void) =>
    runWritingTool({
      settings,
      system: WRITING_TOOLS_SYSTEM,
      messages,
      maxTokens: maxTokensFor(request.selection),
      signal,
      onText,
      client,
    })

  if (request.action === 'synonyms') {
    const raw = await call([user], text => {
      const parsed = parseSynonyms(text, false)
      onProgress({
        stage: 'writing',
        text: '',
        options: parsed.kind === 'synonyms' ? parsed.options : [],
      })
    })
    const parsed = parseSynonyms(raw, true)
    if (parsed.kind === 'cannot') {
      return { kind: 'cannot', reason: parsed.reason }
    }
    const exclude = new Set(
      [request.selection, ...(request.previous ?? [])].map(option =>
        option.toLowerCase()
      )
    )
    const options = parsed.options.filter(
      option => !exclude.has(option.toLowerCase())
    )
    return options.length ? { kind: 'synonyms', options } : { kind: 'empty' }
  }

  const { lead, trail } = splitEdges(original)
  const raw = await call([user], text => {
    const parsed = parseRewrite(text, false)
    onProgress({
      stage: 'writing',
      text: parsed.kind === 'rewrite' ? parsed.text : '',
      options: [],
    })
  })
  const parsed = parseRewrite(raw, true)
  if (parsed.kind === 'cannot') {
    return { kind: 'cannot', reason: parsed.reason }
  }
  if (!parsed.text) return { kind: 'empty' }
  if (squash(parsed.text) === squash(request.selection)) {
    return { kind: 'unchanged' }
  }

  let text = lead + parsed.text + trail
  let warnings = check(request, original, text, doc)
  const problems = repairable(warnings)
  // The author's own instruction may ask for exactly what the check flags
  const custom =
    request.action === 'rephrase' && request.rephrase?.prompt?.trim()
  if (problems.length === 0 || custom) {
    return { kind: 'rewrite', text, warnings }
  }

  onProgress({ stage: 'repairing', text: parsed.text })
  let repairedRaw: string
  try {
    repairedRaw = await call(
      [
        user,
        { role: 'assistant', content: raw },
        {
          role: 'user',
          content: buildRepairMessage(problems.map(problem => problem.message)),
        },
      ],
      () => {}
    )
  } catch (error) {
    if (signal?.aborted) throw error
    // The first version, with its warnings, is still worth showing
    return { kind: 'rewrite', text, warnings }
  }
  const repaired = parseRewrite(repairedRaw, true)
  if (repaired.kind === 'rewrite' && repaired.text) {
    const repairedText = lead + repaired.text + trail
    const repairedWarnings = check(request, original, repairedText, doc)
    if (repairable(repairedWarnings).length < problems.length) {
      text = repairedText
      warnings = repairedWarnings
    }
  }
  return { kind: 'rewrite', text, warnings }
}
