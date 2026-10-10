import { AgentMessage, ProviderSettings } from '../providers/types'
import { runWritingTool, StreamingClient } from '../writing-tools/run-writing-tool'
import { missingPackages, packageWarning } from '../texgpt/checks'
import { CursorWhere } from './context'
import {
  EquationForm,
  hasEquationBlock,
  ParsedEquation,
  parseEquationReply,
} from './parse-output'
import { buildEquationRepair, EQUATION_SYSTEM } from './prompt'
import { alignEdges, guardPassage, normalizeSlots, SLOT } from './checks'
import { MathProblems, previewTex } from './math-render'
import {
  isBlockForm,
  isNumbered,
  joinAround,
  normalizeBody,
  resolveForm,
  uniqueLabel,
  wrapEquation,
} from './wrap'

/** An equation and its passage are short; `runWritingTool` caps it at the model's limit. */
export const EQUATION_MAX_TOKENS = 4096

export type EquationWarning = {
  kind: 'form' | 'label' | 'math' | 'package'
  message: string
}

/** What the harness knows about the request, gathered when Generate was pressed. */
export type EquationFacts = {
  where: CursorWhere
  /** The passage, split at the anchor (the selection taken out). */
  before: string
  selection: string
  after: string
  /** Indentation of the anchor's line, for block forms. */
  indent: string
  /** Labels the project already uses. */
  labels: Set<string>
  parenInline: boolean
  loaded: Set<string>
  docClass: string | null
}

export type EquationResult = {
  kind: 'equation'
  form: EquationForm
  label: string | null
  body: string
  /** The equation as inserted. */
  wrapped: string
  /** The passage's new text, with the edits around the equation. */
  withEdits: string
  /** The passage's new text with the equation alone. */
  equationOnly: string
  /** Runs of edits outside the equation; 0 hides the checkbox. */
  editCount: number
  /** The guards dropped the model's edits. */
  editsSkipped: boolean
  /** Packages the equation needs that the project does not load. */
  packages: string[]
  notes: string | null
  warnings: EquationWarning[]
  /** The reply as sent, for follow-up and retry conversations. */
  raw: string
}

export type EquationOutcome =
  | EquationResult
  | { kind: 'cannot'; reason: string }
  | { kind: 'imageUnsupported' }
  | { kind: 'empty' }

export type EquationProgress =
  | { stage: 'writing'; reply: ParsedEquation }
  | { stage: 'repairing' }

/** A complete reply, turned into what the card shows. Pure. */
export function buildResult(
  parsed: Extract<ParsedEquation, { kind: 'equation' }>,
  raw: string,
  facts: EquationFacts
): EquationResult | { kind: 'empty' } {
  const normalized = normalizeBody(parsed.body)
  if (!normalized.body) return { kind: 'empty' }
  const warnings: EquationWarning[] = []

  const { form, coerced } = resolveForm(parsed.form, normalized.body, facts.where)
  if (coerced && facts.where.kind === 'text') {
    warnings.push({ kind: 'form', message: 'Placed as inline math: display math cannot go here.' })
  }

  let label: string | null = null
  const wanted = parsed.label ?? normalized.label
  if (wanted && isNumbered(form)) {
    label = uniqueLabel(wanted, facts.labels)
    if (label !== wanted) {
      warnings.push({
        kind: 'label',
        message: `Label renamed to ${label}: ${wanted} is already used.`,
      })
    }
  }

  const wrapped = wrapEquation({
    form,
    body: normalized.body,
    label,
    indent: facts.indent,
    parenInline: facts.parenInline,
  })
  const block = isBlockForm(form)
  const equationOnly = joinAround(facts.before, wrapped, facts.after, block)

  let withEdits = equationOnly
  let editCount = 0
  let editsSkipped = false
  if (parsed.passage !== null) {
    const reply = alignEdges(normalizeSlots(parsed.passage), facts.before + SLOT + facts.after)
    const guard = guardPassage(facts, reply)
    if (guard.ok) {
      const [left, right] = reply.split(SLOT)
      withEdits = joinAround(left, wrapped, right, block)
      editCount = guard.editCount
    } else {
      editsSkipped = true
    }
  }

  const packages = missingPackages(wrapped, parsed.packages, facts.loaded, facts.docClass)
  const note = packageWarning(packages)
  if (note) warnings.push({ kind: 'package', message: note.message })

  return {
    kind: 'equation',
    form,
    label,
    body: normalized.body,
    wrapped,
    withEdits,
    equationOnly,
    editCount,
    editsSkipped,
    packages,
    notes: parsed.notes,
    warnings,
    raw,
  }
}

/** The outcome of a finished reply. */
export function outcomeOf(raw: string, facts: EquationFacts): EquationOutcome {
  const parsed = parseEquationReply(raw, true)
  if (parsed.kind === 'cannot') {
    return parsed.reason.trim().toLowerCase() === 'no-image'
      ? { kind: 'imageUnsupported' }
      : { kind: 'cannot', reason: parsed.reason }
  }
  return buildResult(parsed, raw, facts)
}

/** MathJax's view of a body; null when MathJax cannot load (then nothing is checked). */
export type MathChecker = (tex: string, display: boolean) => Promise<MathProblems | null>

type Attempt = { outcome: EquationOutcome; problems: string[] }

/** The outcome of a reply, and what a repair turn should fix in it. */
async function assess(
  raw: string,
  facts: EquationFacts,
  checkMath?: MathChecker
): Promise<Attempt> {
  const outcome = outcomeOf(raw, facts)
  if (outcome.kind !== 'equation') return { outcome, problems: [] }
  const problems: string[] = []
  if (!hasEquationBlock(raw)) {
    problems.push('Reply with an <equation form="…" label="…">…</equation> block, then the <passage>.')
  }
  const parsed = parseEquationReply(raw, true)
  if (parsed.kind === 'equation' && parsed.passage !== null) {
    const slots = normalizeSlots(parsed.passage).split(SLOT).length - 1
    if (slots !== 1) problems.push(`The <passage> must contain ${SLOT} exactly once.`)
  }
  if (checkMath) {
    const math = facts.where.kind === 'math' ? facts.where.math : undefined
    const preview = previewTex(outcome.form, outcome.body, math)
    const found = await checkMath(preview.tex, preview.display)
    for (const error of found?.errors ?? []) {
      problems.push(`MathJax cannot read the body: ${error}`)
    }
    for (const macro of found?.undefinedMacros ?? []) {
      outcome.warnings.push({
        kind: 'math',
        message: `The preview can't show ${macro}; check that it compiles.`,
      })
    }
  }
  return { outcome, problems }
}

/**
 * One equation request: a model call, its reply turned into a result
 * deterministically, and — only when the reply has no equation block, a
 * broken slot or math MathJax cannot read — one repair turn that shows the
 * model its reply and the problems. The repaired version is kept only when
 * it has fewer problems; a failed repair keeps the first version.
 */
export async function generateEquation({
  messages,
  facts,
  settings,
  signal,
  onProgress,
  client,
  checkMath,
}: {
  messages: AgentMessage[]
  facts: EquationFacts
  settings: ProviderSettings
  signal?: AbortSignal
  onProgress: (progress: EquationProgress) => void
  client?: StreamingClient
  checkMath?: MathChecker
}): Promise<EquationOutcome> {
  const call = (conversation: AgentMessage[], onText: (text: string) => void) =>
    runWritingTool({
      settings,
      system: EQUATION_SYSTEM,
      messages: conversation,
      maxTokens: EQUATION_MAX_TOKENS,
      signal,
      onText,
      client,
    })

  const raw = await call(messages, text =>
    onProgress({ stage: 'writing', reply: parseEquationReply(text, false) })
  )
  const first = await assess(raw, facts, checkMath)
  if (first.problems.length === 0) return first.outcome

  onProgress({ stage: 'repairing' })
  try {
    const repairedRaw = await call(
      [
        ...messages,
        { role: 'assistant', content: raw },
        { role: 'user', content: buildEquationRepair(first.problems) },
      ],
      () => {}
    )
    const second = await assess(repairedRaw, facts, checkMath)
    if (second.outcome.kind === 'equation' && second.problems.length < first.problems.length) {
      return second.outcome
    }
  } catch (error) {
    if (signal?.aborted) throw error
    // The first version, with its problems, is still worth showing
  }
  return first.outcome
}
