import { AgentMessage, ProviderSettings } from '../providers/types'
import { runWritingTool, StreamingClient } from '../writing-tools/run-writing-tool'
import { packageWarning } from '../texgpt/checks'
import { uniqueLabel } from '../generator/labels'
import { GeneratorProgress, NonResult } from '../generator/types'
import { InsertWhere } from './context'
import { TableHabits } from './hints'
import { ParsedTable, parseTableReply } from './parse-output'
import { buildTableRepair, TABLE_SYSTEM } from './prompt'
import { bodyProblems, countColumns, splitBody } from './columns'
import { spliceBlock, TableEnv, TableShape, wrapTable } from './wrap'
import { missingValues, valuesWarning } from './values'
import { tablePackages } from './packages'

/** Tables are long; `runWritingTool` caps this at the model's own limit. */
export const TABLE_MAX_TOKENS = 16384

export type TableWarning = {
  kind: 'structure' | 'env' | 'label' | 'wide' | 'values' | 'package'
  message: string
}

/** What the harness knows about the request, gathered when Generate was pressed. */
export type TableFacts = {
  where: InsertWhere
  habits: TableHabits
  /** Labels the project already uses. */
  labels: Set<string>
  /** The selected table's label: kept whatever the model returns, since \ref's point at it. */
  keepLabel: string | null
  loaded: Set<string>
  docClass: string | null
  /** `\rowcolor` works without another package. */
  colorReady: boolean
  /** The anchor's line around the passage, for `spliceBlock`. */
  around: { lineBefore: string; lineAfter: string; indent: string }
  /** Values the author gave (`givenValues`); empty for descriptions and images. */
  values: string[]
}

export type TableResult = {
  kind: 'table'
  env: TableEnv
  spec: string
  label: string | null
  caption: string | null
  /** The rows, trimmed. */
  body: string
  /** The table as inserted. */
  latex: string
  /** The passage's new text: `latex` on its own lines. */
  text: string
  /** Where the cursor goes after Insert: the end of the table in `text`. */
  cursorOffset: number
  columns: number
  /** Rows, rules excluded. */
  rows: number
  /** Packages the table needs that the project does not load. */
  packages: string[]
  notes: string | null
  warnings: TableWarning[]
  /** The reply as sent, for follow-up and retry conversations. */
  raw: string
}

export type TableOutcome = TableResult | NonResult

export type TableProgress = GeneratorProgress<ParsedTable>

type TableReply = Extract<ParsedTable, { kind: 'table' }>

export function coerceEnv(env: string | null): { env: TableEnv; coerced: boolean } {
  if (env === 'tabular' || env === 'tabularx') return { env, coerced: false }
  return { env: 'tabular', coerced: env !== null }
}

/** Whether the caption (and label) are written: not where the float has one, not for a bare tabular. */
function captioned(parsed: TableReply, where: InsertWhere): boolean {
  return where.kind === 'inner' ? !where.hasCaption : parsed.float
}

function shapeOf(parsed: TableReply, facts: TableFacts, label: string | null): TableShape {
  const show = captioned(parsed, facts.where)
  const widest = Math.max(1, ...splitBody(parsed.body).rows.map(row => row.span))
  return {
    env: coerceEnv(parsed.env).env,
    spec: parsed.spec ?? 'l'.repeat(widest),
    body: parsed.body,
    caption: show ? parsed.caption : null,
    label: show && parsed.caption ? label : null,
    wide: parsed.wide,
    float: parsed.float,
  }
}

/** The rows streamed so far, wrapped as they will be; null before there are any. */
export function previewLatex(parsed: ParsedTable, facts: TableFacts): string | null {
  if (parsed.kind !== 'table' || !parsed.body.trim()) return null
  return wrapTable(shapeOf(parsed, facts, parsed.label), facts.habits, facts.where)
}

/** A complete reply, turned into what the card shows. Pure. */
export function buildTableResult(
  parsed: TableReply,
  raw: string,
  facts: TableFacts
): TableResult | { kind: 'empty' } {
  const body = parsed.body.trim()
  if (!body) return { kind: 'empty' }
  const warnings: TableWarning[] = []

  const { env, coerced } = coerceEnv(parsed.env)
  if (coerced) {
    warnings.push({ kind: 'env', message: `Written as tabular: ${parsed.env} is not supported here.` })
  }

  let label: string | null = null
  if (captioned(parsed, facts.where) && parsed.caption) {
    if (facts.keepLabel) {
      label = facts.keepLabel
    } else if (parsed.label) {
      label = uniqueLabel(parsed.label, facts.labels)
      if (label !== parsed.label) {
        warnings.push({
          kind: 'label',
          message: `Label renamed to ${label}: ${parsed.label} is already used.`,
        })
      }
    }
  }

  if (parsed.wide && parsed.float && facts.where.kind === 'float' && !facts.habits.twoColumn) {
    warnings.push({ kind: 'wide', message: 'Placed as a normal table: the document has one column.' })
  }

  const shape = shapeOf({ ...parsed, body }, facts, label)
  const latex = wrapTable(shape, facts.habits, facts.where)
  const spliced = spliceBlock(latex, facts.around)

  const missing = valuesWarning(missingValues(facts.values, body))
  if (missing) warnings.push({ kind: 'values', message: missing })

  const packages = tablePackages(
    latex,
    shape.spec,
    parsed.packages,
    facts.loaded,
    facts.docClass,
    facts.colorReady
  )
  const note = packageWarning(packages)
  if (note) warnings.push({ kind: 'package', message: note.message })

  return {
    kind: 'table',
    env,
    spec: shape.spec,
    label: shape.label,
    caption: shape.caption,
    body,
    latex,
    text: spliced.text,
    cursorOffset: spliced.blockEnd,
    columns: countColumns(shape.spec, facts.habits.columnTypes).count,
    rows: splitBody(body).rows.length,
    packages,
    notes: parsed.notes,
    warnings,
    raw,
  }
}

/** The outcome of a finished reply. */
export function tableOutcomeOf(raw: string, facts: TableFacts): TableOutcome {
  const parsed = parseTableReply(raw, true)
  if (parsed.kind === 'cannot') {
    return parsed.reason.trim().toLowerCase() === 'no-image'
      ? { kind: 'imageUnsupported' }
      : { kind: 'cannot', reason: parsed.reason }
  }
  return buildTableResult(parsed, raw, facts)
}

/** What in a finished reply would not compile: what a repair turn should fix. */
export function tableProblems(raw: string, facts: TableFacts): string[] {
  const parsed = parseTableReply(raw, true)
  if (parsed.kind !== 'table') return []
  if (!parsed.body.trim()) {
    return ['Reply with a <table env="…" spec="…" label="…"> block whose <body> holds the rows.']
  }
  const problems: string[] = []
  let columns = Infinity
  if (parsed.spec) {
    const counted = countColumns(parsed.spec, facts.habits.columnTypes)
    problems.push(...counted.problems)
    columns = counted.count
  } else {
    problems.push('Give the column spec in spec="…".')
  }
  problems.push(...bodyProblems(parsed.body, columns))
  return problems
}

/** A version kept despite its problems says so first. */
function withProblems(result: TableResult, problems: string[]): TableResult {
  if (problems.length === 0) return result
  return {
    ...result,
    warnings: [
      { kind: 'structure', message: `This table may not compile: ${problems[0]}` },
      ...result.warnings,
    ],
  }
}

/**
 * One table request: a model call, its reply turned into a result
 * deterministically, and one repair turn when the reply would not compile.
 * The repair is kept only when it has fewer problems; a failed repair keeps
 * the first version, which then says it may not compile.
 */
export async function generateTable({
  messages,
  facts,
  settings,
  signal,
  onProgress,
  client,
}: {
  messages: AgentMessage[]
  facts: TableFacts
  settings: ProviderSettings
  signal?: AbortSignal
  onProgress: (progress: TableProgress) => void
  client?: StreamingClient
}): Promise<TableOutcome> {
  const call = (conversation: AgentMessage[], onText: (text: string) => void) =>
    runWritingTool({
      settings,
      system: TABLE_SYSTEM,
      messages: conversation,
      maxTokens: TABLE_MAX_TOKENS,
      signal,
      onText,
      client,
    })

  const raw = await call(messages, text =>
    onProgress({ stage: 'writing', reply: parseTableReply(text, false) })
  )
  const first = tableOutcomeOf(raw, facts)
  const problems = tableProblems(raw, facts)
  if (first.kind === 'cannot' || first.kind === 'imageUnsupported' || problems.length === 0) {
    return first
  }

  onProgress({ stage: 'repairing' })
  try {
    const repairedRaw = await call(
      [
        ...messages,
        { role: 'assistant', content: raw },
        { role: 'user', content: buildTableRepair(problems) },
      ],
      () => {}
    )
    const second = tableOutcomeOf(repairedRaw, facts)
    const left = tableProblems(repairedRaw, facts)
    if (second.kind === 'table' && (first.kind !== 'table' || left.length < problems.length)) {
      return withProblems(second, left)
    }
  } catch (error) {
    if (signal?.aborted) throw error
    // The first version, with its problems, is still worth showing
  }
  return first.kind === 'table' ? withProblems(first, problems) : first
}
