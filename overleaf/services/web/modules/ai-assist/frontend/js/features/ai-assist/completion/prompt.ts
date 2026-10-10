import { escapeAttribute } from '../agent/context/escape'
import { documentTag } from '../inline-context/document-tag'
import type { CompletionFacts, CompletionWindow } from './context'
import type { CompletionKind } from './detect'
import type { CursorSituation } from './placement'

/** Output budget per kind: a sentence is short, a block of rows is longer. */
export const MAX_TOKENS: Record<CompletionKind, number> = {
  prose: 160,
  math: 120,
  block: 700,
  code: 300,
}

/** Packages listed to the model: enough to know which commands exist. */
const MAX_PACKAGES = 30
/** Keys listed for `\ref` and `\cite`, the nearest to the cursor. */
const MAX_KEYS = 25
/** The end of the text before the cursor, repeated in the task so the reply joins it exactly. */
const TAIL_CHARS = 120
const MAX_REJECTED = 400

/** Where the reply goes in the excerpt. */
export const CURSOR = '<cursor/>'

/**
 * The system prompt of every completion. The model is a completion engine,
 * not an assistant: it continues the author's text where the cursor is,
 * in their language, voice and notation, and says nothing else.
 */
export const COMPLETION_SYSTEM = String.raw`You are the autocompletion engine of a LaTeX editor. The author paused at the <cursor/> in an excerpt of their document; you write the text that most likely comes next there. It is shown as ghost text they accept with Tab, so it must fit in place exactly as written.

How to continue:
1. Start exactly where the text before <cursor/> stops. If it stops in the middle of a word, finish that word without repeating its letters. Never repeat text that is already before or after the cursor.
2. Read the text from before the cursor, through your words, into the text after it: the result must be grammatical and natural, in the same language, tense, person, register and terminology as the author's.
3. Stay on the topic of the paragraph and the section; carry the argument forward with specific content instead of generic filler. Reuse the document's own notation, macros, labels and citation keys; do not invent references, labels, file names, numbers or results — word the text so that it does not need them.
4. Write LaTeX that compiles where it is inserted: balanced braces and math delimiters, an environment closed only if you opened it, and nothing that belongs elsewhere (no \documentclass, \usepackage or \begin{document} in the body).
5. Respect the structure at the cursor, as the task describes it: math only inside math, cells separated by & with rows ending in \\ inside a table, \item entries inside a list, code in its own language inside a listing.
6. Be brief: the task gives the length. A short, likely continuation is better than a long, uncertain one.

Reply with only the text to insert: no explanation, no quotation marks, no Markdown fences, no tags. If nothing sensible fits, reply with nothing.`

/** How much to write, by kind and by place. */
function lengthHint(kind: CompletionKind, situation: CursorSituation): string {
  if (situation.argumentOf) return 'Length: only what the argument still needs.'
  if (situation.region === 'preamble') return 'Length: one to three lines.'
  switch (kind) {
    case 'math':
      return 'Length: the rest of this expression, on this line.'
    case 'code':
      return 'Length: at most six lines.'
    case 'block':
      if (situation.announces) {
        return `Length: the whole ${situation.announces === 'equation' ? 'formula' : situation.announces}, up to its last \\end{…}${situation.announces === 'table' ? ' (a header row and three to six data rows)' : ''}.`
      }
      return situation.rows || situation.envs[situation.envs.length - 1]?.role === 'list'
        ? 'Length: one row or item, at most three.'
        : 'Length: one or two sentences, or one small block; at most twelve lines.'
    case 'prose':
      return situation.sameLine
        ? 'Length: the rest of this sentence, usually a few words and never more than one sentence.'
        : 'Length: one sentence of at most about 35 words.'
  }
}

/** The facts as tags, those that matter for the cursor's place only. */
function documentFacts(facts: CompletionFacts, window: CompletionWindow): string[] {
  const lines: string[] = []
  const tag = documentTag({ ...facts, packages: facts.packages?.slice(0, MAX_PACKAGES) })
  if (tag) lines.push(tag)
  if (facts.title) lines.push(`<title>${facts.title}</title>`)
  // The abstract states what the document is about; it is left out once the excerpt shows it
  if (facts.abstract && !window.prefix.includes(facts.abstract.slice(0, 40))) {
    lines.push(`<abstract>${facts.abstract}</abstract>`)
  }
  if (facts.outline.length > 0) lines.push(`<outline>${facts.outline.join(' / ')}</outline>`)
  if (facts.section) lines.push(`<section>${facts.section}</section>`)
  const keys: Array<[string, string[]]> = [
    ['labels', facts.labels],
    ['citations', facts.cites],
  ]
  const written = keys
    .filter(([, values]) => values.length > 0)
    .map(([name, values]) => `${name}="${escapeAttribute(values.slice(-MAX_KEYS).join(' '))}"`)
  if (written.length > 0) lines.push(`<keys ${written.join(' ')} />`)
  return lines
}

/** The end of the text before the cursor, on one line, for the model to join to. */
function tailOf(prefix: string): string {
  const lastLine = prefix.slice(prefix.lastIndexOf('\n') + 1)
  const tail = lastLine.length > TAIL_CHARS ? `…${lastLine.slice(-TAIL_CHARS)}` : lastLine
  return tail.trim() ? tail : ''
}

export type CompletionPrompt = {
  window: CompletionWindow
  facts: CompletionFacts
  kind: CompletionKind
  situation: CursorSituation
  /** A suggestion the author asked to replace (Shift+Space again): write a different one. */
  rejected?: string
}

/**
 * The one user message of a completion request: what the document is
 * about, the excerpt with the cursor marked, then the task — where the
 * cursor is, what may go there, how much, and the words to join to.
 */
export function buildCompletionMessage({
  window,
  facts,
  kind,
  situation,
  rejected,
}: CompletionPrompt): string {
  const parts: string[] = []
  const about = documentFacts(facts, window)
  if (about.length > 0) parts.push(about.join('\n'))
  parts.push(
    `<excerpt${window.atStart ? ' start="document"' : ''}>\n${window.prefix}${CURSOR}${window.suffix}\n</excerpt>`
  )

  const task = [situation.instruction, lengthHint(kind, situation)]
  const tail = tailOf(window.prefix)
  if (tail && !situation.newLine) {
    task.push(`Your text is inserted right after: "${tail}"`)
  }
  if (rejected?.trim()) {
    const shown = rejected.trim().slice(0, MAX_REJECTED)
    task.push(`The author dismissed this suggestion; write a different continuation: "${shown}"`)
  }
  parts.push(`<task>\n${task.join('\n')}\n</task>`)
  return parts.join('\n\n')
}
