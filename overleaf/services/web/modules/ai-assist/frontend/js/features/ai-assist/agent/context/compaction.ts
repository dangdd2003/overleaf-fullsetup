import type {
  CompactEntry,
  CompactLedger,
  TranscriptEntry,
} from '../agent-messages'

// Mirrors renderLedger and renderCompactionMessage in the server's
// AiAssistCompaction.mjs byte for byte: the context meter and the rebuilt
// messages have to match what the server sends.

const COMPACT_INTRO =
  'This chat continues an earlier conversation that was compacted to save context. The summary and ledger below replace the earlier messages; the most recent messages follow verbatim after this block. Files may have changed since: re-read a file before editing it. The next <project-context> is current and wins over anything stated here.'

function emptyLedger(): CompactLedger {
  return {
    userMessages: [],
    filesRead: [],
    edits: [],
    filesCreated: [],
    compile: { unresolved: [], resolved: [] },
    latex: {
      packages: [],
      macros: [],
      labels: [],
      citeKeys: [],
      unresolvedRefs: [],
    },
    settings: [],
    pdf: { pages: [], notes: [] },
    web: [],
    connectors: [],
    slashCommands: [],
    rejected: [],
  }
}

/** A stored ledger with every field present (older or partial ledgers). */
function normalizeLedger(ledger: Partial<CompactLedger> | undefined): CompactLedger {
  const base = emptyLedger()
  if (!ledger || typeof ledger !== 'object') return base
  return {
    ...base,
    ...ledger,
    compile: { ...base.compile, ...(ledger.compile ?? {}) },
    latex: { ...base.latex, ...(ledger.latex ?? {}) },
    pdf: { ...base.pdf, ...(ledger.pdf ?? {}) },
  }
}

function clipText(text: string, max: number): string {
  if (text.length <= max) return text
  const tail = Math.floor(max * 0.2)
  const head = max - tail - 1
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

function diagLabel(d: { file?: string; line?: number; message: string }) {
  const where = d.file
    ? `${d.file}${Number.isFinite(d.line) ? `:${d.line}` : ''} `
    : ''
  return clipText(`${where}${d.message}`, 300)
}

function lineRange(edit: CompactLedger['edits'][number]) {
  if (edit.startLine === undefined) return ''
  if (edit.endLine === undefined || edit.endLine === edit.startLine) {
    return ` ${edit.startLine}`
  }
  return ` ${edit.startLine}-${edit.endLine}`
}

function indentLines(text: string) {
  return String(text).split('\n').join('\n  ')
}

/** The ledger as markdown (`## Ledger (exact, extracted by code)`), empty subsections left out. */
export function renderCompactLedger(ledger: CompactLedger): string {
  const l = normalizeLedger(ledger)
  const out = ['## Ledger (exact, extracted by code)']
  const section = (title: string, lines: string[]) => {
    if (lines.length > 0) out.push('', `### ${title}`, ...lines)
  }

  section(
    'User messages',
    l.userMessages.map(m => `- ${m.id}: ${indentLines(m.text)}`)
  )
  section(
    'Files read',
    l.filesRead.map(f => `- ${f.path}: ${f.ranges.join(', ')}`)
  )
  section(
    'Edits (oldest first)',
    l.edits.map(e => {
      const texts =
        e.oldText !== undefined || e.newText !== undefined
          ? ` ${JSON.stringify(e.oldText ?? '')} -> ${JSON.stringify(e.newText ?? '')}`
          : ''
      return `- ${e.path}${lineRange(e)} ${e.status}${texts}`
    })
  )
  section(
    'Files created',
    l.filesCreated.map(p => `- ${p}`)
  )

  const compileLines: string[] = []
  if (l.compile.last) {
    const last = l.compile.last
    let line = `- Last compile: ${last.status}, ${last.errorCount} error(s), ${last.warningCount} warning(s)`
    if (last.firstError) {
      const e = last.firstError
      const where = e.file ? `${e.file}${e.line ? `:${e.line}` : ''} ` : ''
      line += `; first: ${where}${e.message}`
    }
    compileLines.push(line)
  }
  for (const d of l.compile.unresolved) compileLines.push(`- Unresolved: ${diagLabel(d)}`)
  for (const r of l.compile.resolved) compileLines.push(`- Resolved: ${r}`)
  section('Compile', compileLines)

  const latexLines: string[] = []
  if (l.latex.documentClass) latexLines.push(`- Document class: ${l.latex.documentClass}`)
  if (l.latex.packages.length) latexLines.push(`- Packages: ${l.latex.packages.join(', ')}`)
  if (l.latex.macros.length) latexLines.push(`- Macros: ${l.latex.macros.join(', ')}`)
  if (l.latex.labels.length) latexLines.push(`- Labels: ${l.latex.labels.join(', ')}`)
  if (l.latex.citeKeys.length) latexLines.push(`- Cite keys: ${l.latex.citeKeys.join(', ')}`)
  for (const r of l.latex.unresolvedRefs) latexLines.push(`- Unresolved reference: ${r}`)
  section('LaTeX', latexLines)

  section(
    'Settings',
    l.settings.map(s => `- ${s.key}: ${s.value}`)
  )
  const pdfLines: string[] = []
  if (l.pdf.pages.length) pdfLines.push(`- Pages: ${l.pdf.pages.join(', ')}`)
  for (const note of l.pdf.notes) pdfLines.push(`- ${note}`)
  section('PDF', pdfLines)
  section(
    'Web pages read',
    l.web.map(w => (w.title ? `- ${w.title} (${w.url})` : `- ${w.url}`))
  )
  section(
    'Connector calls',
    l.connectors.map(c => `- ${c.tool}: ${c.count} call(s)`)
  )
  section(
    'Slash commands',
    l.slashCommands.map(c => `- /${c}`)
  )
  section(
    'Rejected',
    l.rejected.map(r => `- ${r}`)
  )
  return out.join('\n')
}

/**
 * The user-role message that replaces every entry before a compact boundary
 * (spec section 4). The model reads it as the start of the conversation.
 */
export function renderCompactionMessage(entry: CompactEntry): string {
  const ledger = normalizeLedger(entry?.ledger)
  const turns = ledger.userMessages.length
  const trigger = entry?.trigger === 'auto' ? 'auto' : 'manual'
  const date = Number.isFinite(entry?.createdAt)
    ? ` date="${new Date(entry.createdAt).toISOString().slice(0, 10)}"`
    : ''
  const lines = [
    `<compacted-conversation trigger="${trigger}" turns="${turns}"${date}>`,
    COMPACT_INTRO,
    '',
    '## Summary',
    String(entry?.summary ?? '').trim(),
    '',
    renderCompactLedger(ledger),
  ]
  if (entry?.excerpts) {
    lines.push('', '## Recently edited excerpts', String(entry.excerpts))
  }
  lines.push('</compacted-conversation>')
  return lines.join('\n')
}

/**
 * How a compaction run ended: a boundary landed, there was nothing to gain
 * (`compactNothing`, information rather than an error), the user stopped it,
 * or it failed (including a refused start).
 */
export type CompactOutcome = 'done' | 'nothing' | 'stopped' | 'failed'

/** Error codes a compaction run ends with, shown on the compaction's card. */
export function isCompactError(code: string | undefined): boolean {
  return (
    code === 'compactFailed' ||
    code === 'compactNothing' ||
    code === 'chatBusy'
  )
}

/** Whether automatic compaction is on. */
export type AutoCompactSettings = {
  enabled: boolean
}

/** What the decision needs about the chat, nothing more. */
export type AutoCompactState = {
  /** The chat's anchored context count, in tokens. */
  usedTokens: number
  /** The window's auto-compact threshold: compact at or above it. */
  autoCompactAt: number
  /** User turns since the newest compact entry (all of them if none). */
  userTurnsSinceBoundary: number
  /**
   * Consecutive automatic compactions that failed in this chat. A
   * `compactNothing` (nothing to gain) is not a failure.
   */
  consecutiveFailures: number
  /**
   * User turns since the previous automatic compaction attempt, null if
   * none. Counts attempts this session and automatic boundaries the chat
   * already holds, the server's mid-run ones included.
   */
  userTurnsSincePreviousAuto: number | null
}

/** Auto compaction stops after this many failures in a row. */
export const AUTO_COMPACT_MAX_FAILURES = 3
/** An automatic compaction within this many user turns of the last is skipped. */
export const AUTO_COMPACT_MIN_TURNS_APART = 2
/** Need this many user turns since the last boundary before compacting. */
export const AUTO_COMPACT_MIN_TURNS = 2

/**
 * Whether to compact before sending, and why not. Pure: the panel reads the
 * chat's numbers and acts on the answer.
 */
export function shouldAutoCompact(
  settings: AutoCompactSettings,
  state: AutoCompactState
): { compact: boolean; reason: string } {
  if (!settings.enabled) return { compact: false, reason: 'disabled' }
  if (state.consecutiveFailures >= AUTO_COMPACT_MAX_FAILURES) {
    return { compact: false, reason: 'circuitBreaker' }
  }
  if (state.usedTokens < state.autoCompactAt) {
    return { compact: false, reason: 'belowThreshold' }
  }
  if (state.userTurnsSinceBoundary < AUTO_COMPACT_MIN_TURNS) {
    return { compact: false, reason: 'tooFewTurns' }
  }
  if (
    state.userTurnsSincePreviousAuto !== null &&
    state.userTurnsSincePreviousAuto < AUTO_COMPACT_MIN_TURNS_APART
  ) {
    return { compact: false, reason: 'thrashGuard' }
  }
  return { compact: true, reason: 'threshold' }
}

/**
 * User turns sent since the newest compact boundary (all of them when there
 * is none): queued messages not yet sent are not counted.
 */
export function userTurnsSinceBoundary(transcript: TranscriptEntry[]): number {
  let turns = 0
  for (let i = transcript.length - 1; i >= 0; i--) {
    const entry = transcript[i]
    if (entry.role === 'compact') break
    if (entry.role === 'user' && !entry.pending) turns++
  }
  return turns
}

/** Every user turn sent in the chat, before and after any boundary. */
export function countUserTurns(transcript: TranscriptEntry[]): number {
  return transcript.filter(entry => entry.role === 'user' && !entry.pending)
    .length
}

/**
 * User turns since the newest automatic compaction boundary (the server's
 * mid-run ones included), null if the chat has none. The thrash guard reads
 * it next to the panel's own attempts: a server compaction is not one of them.
 */
export function userTurnsSinceAutoCompact(
  transcript: TranscriptEntry[]
): number | null {
  let turns = 0
  for (let i = transcript.length - 1; i >= 0; i--) {
    const entry = transcript[i]
    if (entry.role === 'compact' && entry.trigger === 'auto') return turns
    if (entry.role === 'user' && !entry.pending) turns++
  }
  return null
}

/**
 * Automatic compaction: on. When the chat reaches its auto-compact threshold
 * (see `contextThresholds`) it is compacted before a send, and during a run
 * by the server.
 */
export const AUTO_COMPACT_SETTINGS: AutoCompactSettings = {
  enabled: true,
}

/** Token counts as the chat shows them: 9.8k, 152k, 1.2M. */
export function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 10_000) return `${Math.round(tokens / 1000)}k`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`
  return String(Math.round(tokens))
}
