import { EditorState } from '@codemirror/state'
import { mathAncestorNode } from '@/features/source-editor/utils/tree-operations/math'
import { maskComments } from '../texgpt/latex-text'
import { cursorContext } from '../inline-context/cursor-context'
import { readInlineSuggestionsPreferences } from '../inline-suggestion/preferences'
import { continuesParagraph, continuesStructure, roleAt } from './structure'
import { announcedBlock, endsWithStructureLine } from './placement'

/**
 * What a completion at the cursor writes:
 * - prose: the rest of the sentence, or the next one
 * - block: the next lines (on a blank line, after a finished `\\` row, after
 *   a line of structural commands such as `\section{…}`, after a sentence
 *   announcing a table, figure, formula, list or code, or in the preamble)
 * - math: the rest of the expression
 * - code: the next lines of a listing, pseudocode or a drawing
 * The environment's role (structure.ts) and the cursor's situation
 * (placement.ts) say what exactly goes there.
 */
export type CompletionKind = 'prose' | 'block' | 'math' | 'code'

/** Where a completion may run, and what it writes; or why none runs here. */
export type Detection =
  | { kind: CompletionKind; reason: null }
  | { kind: null; reason: string }

/** At least this much text (spaces aside) just before the cursor… */
export const MIN_CONTEXT_CHARS = 12
/** …looked for this far back. */
const CONTEXT_LOOKBACK = 300

/**
 * What may follow the cursor on its line for the completion to be appended
 * there: closing delimiters (`}` `]` `)` `$` `\)` `\]`), the punctuation that
 * ends the clause, a row's `\\`, and a comment. Words after the cursor mean
 * a gap in the middle of the text, which a chat model cannot fill reliably.
 */
const TRAILING_FITS =
  /^(?:\\\)|\\\]|[}\])$])*[.,;:!?]?(?:\\\)|\\\]|[}\])$])*(?:\\\\(?:\[[^\]]*\])?)?$/
const ROW_END = /\\\\\s*$/

/**
 * A command name being typed, or a lone `\`: LaTeX autocomplete's turn… An
 * escaped backslash is not one: `\\` ends a row or a line.
 */
const COMMAND_NAME = /(?:^|[^\\])(?:\\\\)*\\([A-Za-z@]*)$/
/** …unless it is one complete as it is, which text or a new row follows. */
const TEXT_FOLLOWS = new Set([
  'item',
  'par',
  'newline',
  'linebreak',
  'noindent',
  'indent',
  'centering',
  'raggedright',
  'raggedleft',
  'hline',
  'midrule',
  'toprule',
  'bottomrule',
  'smallskip',
  'medskip',
  'bigskip',
  'newpage',
  'clearpage',
  'maketitle',
  'appendix',
  'quad',
  'qquad',
])
/** Commands whose argument is a key, a path or a name, never prose. */
const KEY_COMMANDS = [
  '[A-Za-z]*(?:ref|cite)[A-Za-z]*',
  'label',
  'input',
  'include',
  'includeonly',
  'includegraphics',
  'includepdf',
  'subfile',
  'import',
  'usepackage',
  'RequirePackage',
  'documentclass',
  'usetikzlibrary',
  'begin',
  'end',
  'bibliography',
  'bibliographystyle',
  'addbibresource',
  'url',
  'href',
  'newcommand',
  'renewcommand',
  'newenvironment',
  'renewenvironment',
  'color',
  'textcolor',
  'definecolor',
  'setlength',
  'hspace',
  'vspace',
].join('|')
/** Inside the still-open `{…}` of one of those, after any `[…]` options. */
const KEY_ARGUMENT = new RegExp(
  `\\\\(?:${KEY_COMMANDS})\\*?\\s*(?:\\[[^\\]]*\\]\\s*)*\\{[^{}]*$`
)
/** Inside a command's still-open `[…]` options: `width=`, `p.~3`, `htbp`. */
const OPTIONAL_ARGUMENT = /\\[A-Za-z@]+\*?\s*(?:\{[^{}]*\}\s*)*\[[^\]]*$/

/** Whether the cursor is inside a `%` comment on its line. */
export function inComment(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos)
  const before = line.text.slice(0, pos - line.from)
  return maskComments(before) !== before
}

/**
 * Whether the rest of the line lets a completion be appended at the cursor
 * (see `TRAILING_FITS`); a comment and spaces do not count.
 */
export function trailingFits(lineRest: string): boolean {
  const code = lineRest.replace(/(?<!\\)%.*$/, '').replace(/\s+/g, '')
  return TRAILING_FITS.test(code)
}

/** The line before `number`, past comment-only lines; null at the start of the file. */
function previousLine(state: EditorState, number: number): string | null {
  for (let n = number - 1; n >= 1; n--) {
    const text = state.doc.line(n).text
    // A line holding only a comment is passed over; a blank one is not
    if (/\S/.test(text) && !/\S/.test(maskComments(text))) continue
    return text
  }
  return null
}

type Place = {
  before: string
  rest: string
  role: ReturnType<typeof roleAt>
  region: 'preamble' | 'body'
  inMath: boolean
  blankLine: boolean
  lineNumber: number
}

function placeAt(state: EditorState, pos: number, doc: string): Place {
  const line = state.doc.lineAt(pos)
  const context = cursorContext(doc, pos)
  return {
    before: line.text.slice(0, pos - line.from),
    rest: line.text.slice(pos - line.from),
    role: roleAt(context.envs, doc),
    region: context.region,
    inMath: Boolean(mathAncestorNode(state, pos)),
    blankLine: !/\S/.test(line.text),
    lineNumber: line.number,
  }
}

/**
 * Why no completion runs here, Shift+Space or Automatic alike: a comment, a
 * bibliography or file contents, a command name being typed, a key, path or
 * option argument (LaTeX autocomplete's; a model would invent them), or
 * words after the cursor on its line.
 */
function blockedReason(state: EditorState, pos: number, place: Place): string | null {
  if (inComment(state, pos)) return 'comment'
  if (place.role === 'skip') return 'bibliography, comment or file contents'
  const command = COMMAND_NAME.exec(place.before)
  if (command && !TEXT_FOLLOWS.has(command[1])) return 'command name'
  if (KEY_ARGUMENT.test(place.before)) return 'key or path argument'
  if (OPTIONAL_ARGUMENT.test(place.before)) return 'command options'
  if (!trailingFits(place.rest)) return 'text after the cursor'
  return null
}

/**
 * Why a pause in typing does not ask here, though Shift+Space would. It
 * stays quiet:
 * - on an empty line while the empty-line shortcut is on: Space opens the
 *   writing prompt there, and its hint shows; a ghost would hide both;
 * - with almost nothing written yet to continue from;
 * - in the preamble, where settings are chosen rather than written;
 * - on a new, blank line at column 0 where a new block starts: after a blank
 *   line, a heading, an `\end{…}` or another structural command, at the
 *   start of an environment's prose.
 * A new blank line goes on with what is around it, and asks, when it is
 * indented, inside a structure (a list, table or math rows, a formula, code,
 * a drawing, a float's parts; environments the document defines included),
 * inside display math, or at column 0 right after a line of the paragraph.
 */
function quietReason(state: EditorState, pos: number, place: Place): string | null {
  const line = state.doc.lineAt(pos)
  if (line.length === 0 && readInlineSuggestionsPreferences().emptyLineShortcut) {
    return 'empty line: Space opens the writing prompt'
  }
  const recent = state.sliceDoc(Math.max(0, pos - CONTEXT_LOOKBACK), pos)
  if (recent.replace(/\s+/g, '').length < MIN_CONTEXT_CHARS) return 'too little text'
  if (place.region === 'preamble') return 'preamble'
  if (
    place.blankLine &&
    place.before === '' &&
    !continuesStructure(place.role) &&
    !place.inMath &&
    !continuesParagraph(previousLine(state, place.lineNumber))
  ) {
    return 'new block: nothing to continue'
  }
  return null
}

function kindAt(place: Place): CompletionKind {
  if (place.role === 'code' || place.role === 'drawing') return 'code'
  if (place.region === 'preamble') return 'block'
  if (!/\S/.test(place.before)) return 'block'
  if (place.role === 'rows' && ROW_END.test(place.before)) return 'block'
  // After `\section{…}`, `\begin{…}`, `\end{…}`, `\label{…}` alone on the line: the next lines
  if (endsWithStructureLine(place.before, place.rest)) return 'block'
  if (place.inMath) return 'math'
  // `…the example table:`, `…is given by`: the table or formula goes on the next lines
  if ((place.role === null || place.role === 'prose' || place.role === 'list') && announcedBlock(place.before)) {
    return 'block'
  }
  return 'prose'
}

/**
 * Whether a completion runs at `pos`, and of what kind. `automatic` adds
 * the restraint of a pause in typing (`quietReason`) to the rules that hold
 * for Shift+Space too (`blockedReason`).
 */
export function detectCompletion(
  state: EditorState,
  pos: number,
  { automatic }: { automatic: boolean }
): Detection {
  const doc = state.doc.toString()
  const place = placeAt(state, pos, doc)
  const reason =
    blockedReason(state, pos, place) ??
    (automatic ? quietReason(state, pos, place) : null)
  if (reason) return { kind: null, reason }
  return { kind: kindAt(place), reason: null }
}

/** The kind of completion at `pos`, or null where none may run (Shift+Space's rules). */
export function completionKind(state: EditorState, pos: number): CompletionKind | null {
  return detectCompletion(state, pos, { automatic: false }).kind
}

/** Why a pause in typing at `pos` does not ask for a suggestion; null where it may. */
export function autoSkipReason(state: EditorState, pos: number): string | null {
  return detectCompletion(state, pos, { automatic: true }).reason
}
