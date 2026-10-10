import { maskComments, matchingBrace } from '../texgpt/latex-text'
import type { CompletionKind } from './detect'
import { ALL_FLOAT_ENVS, ALL_MATH_ENVS, ALL_TABLE_ENVS, EnvRole, envRole } from './structure'

/**
 * Where the cursor is, worked out here rather than left to the model: the
 * structure around it, the cell of a table row, the argument it sits in,
 * and whether what comes next goes on this line or the next. It becomes
 * the `<task>` of the request (prompt.ts), and the cleaning holds the reply
 * to it (clean.ts): a model shown only text around the cursor opens a
 * second table inside the one being written, or puts `\begin{…}` right
 * after `\section{…}` on the same line.
 */
export type OpenEnv = {
  name: string
  role: EnvRole
  /** Its `\begin` line, up to the end of the line, as written. */
  begin: string
  /** Its `\end` is in the text after the cursor: closing it again breaks the document. */
  closedAfter: boolean
}

export type RowsInfo = {
  /** From the column spec, or the most cells a row above has; null: unknown. */
  columns: number | null
  /** The `&`-separated cells of the current row before the cursor, minus one: its `&`s. */
  separatorsBefore: number
  /** The cursor starts a row: after `\\`, a rule, or the `\begin` line. */
  atRowStart: boolean
  /** The first row of the body, as written: the column headings, mostly. */
  header: string | null
}

export type CursorSituation = {
  kind: CompletionKind
  /** Before `\begin{document}`, or in a file that only loads packages. */
  region: 'preamble' | 'body'
  /** Open environments, outermost first. */
  envs: OpenEnv[]
  rows: RowsInfo | null
  /** The command whose argument holds the cursor (`section`, `caption`…), if any. */
  argumentOf: string | null
  /** That argument's closing brace is already on the line after the cursor. */
  argumentClosed: boolean
  /** The reply starts on a new line: the cursor ends a line holding a structural command. */
  newLine: boolean
  /** The reply stays on this line: the cursor is in the middle of a sentence. */
  sameLine: boolean
  /** The text before the cursor announces a formula or list (`…as follows:`), which goes on the next lines. */
  introducesDisplay: boolean
  /** The block it announces, when it names one (`…the example table:`): written on the next lines. */
  announces: AnnouncedBlock | null
  /** A row's `\\` already follows the cursor on its line: the reply ends before it. */
  rowEndAfter: boolean
  /** The rest of the cursor's line, as written (closers, punctuation, a comment). */
  lineRest: string
  /** Indentation for the lines the reply adds. */
  indent: string
  /** Environments the reply must not open: those open already, where nesting is an error. */
  forbidBegin: string[]
  /** Environments the reply must not close: their `\end` is already after the cursor. */
  forbidEnd: string[]
  /** One paragraph for the model: where the cursor is and what may go there. */
  instruction: string
}

/** Roles where opening the same environment again inside is a mistake, not a structure. */
const NO_NESTING: ReadonlySet<EnvRole> = new Set(['rows', 'math', 'code', 'drawing', 'float'])

/** Commands that, alone at the end of a line, are followed by a new line, not more text. */
const LINE_ENDING_COMMANDS = new Set([
  'part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph',
  'begin', 'end', 'label', 'caption', 'centering', 'raggedright', 'raggedleft',
  'includegraphics', 'maketitle', 'tableofcontents', 'hline', 'midrule', 'toprule',
  'bottomrule', 'cline', 'cmidrule', 'newpage', 'clearpage', 'vspace', 'bigskip',
  'medskip', 'smallskip', 'input', 'include', 'frametitle', 'printbibliography',
  'bibliography', 'bibliographystyle', 'appendix',
])
/** A whole line that is commands with their arguments and nothing else. */
const COMMANDS_ONLY =
  /^\s*(?:\\[A-Za-z@]+\*?\s*(?:\[[^\]]*\]\s*|\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}\s*)*)+\s*$/
const LAST_COMMAND = /\\([A-Za-z@]+)\*?\s*(?:\[[^\]]*\]\s*|\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}\s*)*\s*$/
const ROW_END = /\\\\\s*(?:\[[^\]]*\])?\s*$/
const RULE_LINE = /\\(?:hline|midrule|toprule|bottomrule|cline\{[^}]*\}|cmidrule(?:\([^)]*\))?\{[^}]*\})\s*$/
const SENTENCE_END = /[.?!:]['")\]}]*\s*$/
/** The sentence before the cursor announces a formula or a list: what it introduces comes next. */
const INTRODUCES =
  /(?::|\b(?:given by|defined (?:as|by)|as follows|written as|expressed as|computed (?:as|by)|formulated as|reads|becomes|yields|the following|(?:shown|given|listed|presented) below))\s*$/i

/** A block the text before the cursor announces, which goes on the next lines. */
export type AnnouncedBlock = 'table' | 'figure' | 'equation' | 'list' | 'code' | 'algorithm'

/** What each block is called in the announcing sentence. */
const ANNOUNCED_WORDS: Array<[AnnouncedBlock, RegExp]> = [
  ['table', /(?<!\\)\b(?:tables?|tabular|tabulated)\b/gi],
  ['figure', /(?<!\\)\b(?:figures?|images?|pictures?|plots?|graphs?|charts?|diagrams?|illustrations?|tikz)\b/gi],
  ['equation', /(?<!\\)\b(?:equations?|formulas?|formulae|expressions?|identity|identities|inequalit(?:y|ies)|derivation)\b/gi],
  ['list', /(?<!\\)\b(?:lists?|items?|steps|bullet(?: points)?|enumerat\w*)\b/gi],
  ['code', /(?<!\\)\b(?:code|listings?|snippets?|programs?|scripts?)\b/gi],
  ['algorithm', /(?<!\\)\b(?:algorithms?|pseudo-?code)\b/gi],
]

/**
 * The block the sentence before the cursor announces (`…the example
 * table:`, `…is given by`), named by the word nearest its end; null when it
 * announces nothing, or announces nothing this recognises.
 */
export function announcedBlock(before: string): AnnouncedBlock | null {
  const text = maskComments(before)
  if (!INTRODUCES.test(text)) return null
  // The announcing sentence: from the end of the previous one
  const previous = Math.max(...['. ', '? ', '! ', '\n\n'].map(end => text.trimEnd().lastIndexOf(end)))
  const sentence = text.slice(previous + 1)
  let best: { block: AnnouncedBlock; at: number } | null = null
  for (const [block, words] of ANNOUNCED_WORDS) {
    for (const match of sentence.matchAll(words)) {
      if (!best || match.index! >= best.at) best = { block, at: match.index! }
    }
  }
  if (best) return best.block
  // `…is given by`, `…defined as`: a formula
  return /\b(?:given by|defined (?:as|by)|written as|expressed as|computed (?:as|by)|formulated as|reads|becomes|yields)\s*$/i.test(text)
    ? 'equation'
    : null
}

/** How each announced block is written out. */
const ANNOUNCED_FORMS: Record<AnnouncedBlock, string> = {
  table:
    'a complete table: \\begin{table}[h], \\centering, \\begin{tabular}{…} with a column spec, a header row and a few data rows (cells separated by &, rows ending with \\\\, \\hline rules), \\end{tabular}, \\caption{…}, \\label{tab:…}, \\end{table}',
  figure:
    'a complete figure: \\begin{figure}[h], \\centering, the picture (\\includegraphics[width=…]{…} or a tikzpicture), \\caption{…}, \\label{fig:…}, \\end{figure}',
  equation:
    'the formula as a display: \\begin{equation} (align for several lines), its body on its own line, \\end{equation}',
  list: 'the list: \\begin{itemize} (enumerate for steps), one \\item per line, \\end{itemize}',
  code:
    'the code as a listing: \\begin{lstlisting} (minted or verbatim when those are the packages loaded), the code lines, \\end{lstlisting}',
  algorithm:
    'the algorithm: \\begin{algorithm}, \\caption{…}, \\begin{algorithmic} with one statement per line, \\end{algorithmic}, \\end{algorithm}',
}

/**
 * Whether the cursor ends a line that holds only structural commands
 * (`\section{…}`, `\end{…}`, `\label{…}`, `\hline`…): what follows goes on
 * the next line, never right after them.
 */
export function endsWithStructureLine(before: string, restOfLine: string): boolean {
  const maskedBefore = maskComments(before).trimEnd()
  if (!/\S/.test(maskedBefore) || /\S/.test(maskComments(restOfLine))) return false
  if (!COMMANDS_ONLY.test(maskedBefore) && !RULE_LINE.test(maskedBefore)) return false
  const last = LAST_COMMAND.exec(maskedBefore)
  return last !== null && LINE_ENDING_COMMANDS.has(last[1])
}

/** Open environments at `pos`, with where their `\begin` is. */
function openEnvironments(doc: string, masked: string, pos: number): Array<{ name: string; at: number }> {
  const open: Array<{ name: string; at: number }> = []
  for (const match of masked.slice(0, pos).matchAll(/\\(begin|end)\s*\{([^}]+)\}/g)) {
    const name = match[2].trim()
    if (name === 'document') continue
    if (match[1] === 'begin') open.push({ name, at: match.index! })
    else {
      const index = open.map(env => env.name).lastIndexOf(name)
      if (index !== -1) open.splice(index)
    }
  }
  return open
}

/** The text of a `{…}` argument starting at or after `from` (spaces and `[…]` skipped), and its end. */
function argumentAt(masked: string, doc: string, from: number): { text: string; end: number } | null {
  let i = from
  while (i < masked.length) {
    if (/\s/.test(masked[i])) i++
    else if (masked[i] === '[') {
      const close = masked.indexOf(']', i)
      if (close === -1) return null
      i = close + 1
    } else break
  }
  if (masked[i] !== '{') return null
  const close = matchingBrace(masked, i)
  return close === -1 ? null : { text: doc.slice(i + 1, close), end: close + 1 }
}

export type SuffixStructure =
  | { type: 'env'; name: string }
  | { type: 'section'; name: string }
  | { type: 'math' }
  | { type: 'item' }
  | null

/** Detects the immediate next LaTeX structure in the suffix after the cursor. */
export function nextStructureInSuffix(after: string): SuffixStructure {
  const cleaned = maskComments(after).trimStart()
  const envMatch = /^\\begin\s*\{([^}]+)\}/.exec(cleaned)
  if (envMatch) return { type: 'env', name: envMatch[1].trim() }
  const secMatch = /^\\(part|chapter|section|subsection|subsubsection|paragraph)\b/.exec(cleaned)
  if (secMatch) return { type: 'section', name: secMatch[1] }
  if (/^(\\\[|\$\$)/.test(cleaned)) return { type: 'math' }
  if (/^\\item\b/.test(cleaned)) return { type: 'item' }
  return null
}

/** Columns in a tabular/array column spec: `l`, `c`, `r`, `p{…}`, `X`, `S`, `*{n}{…}`… */
export function countColumns(spec: string): number | null {
  let text = spec.replace(/\[[^\]]*\]/g, '')
  text = text.replace(/[@!<>]\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, '')
  // *{3}{c} → ccc
  for (let guard = 0; guard < 5 && /\*\s*\{\s*\d+\s*\}/.test(text); guard++) {
    text = text.replace(/\*\s*\{\s*(\d+)\s*\}\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g, (_, n, body) =>
      body.repeat(Math.min(Number(n), 50))
    )
  }
  // Width and other arguments: p{3cm} counts as one column
  text = text.replace(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, '')
  const columns = (text.match(/[lcrpmbXSQsLCRJjYZ]/g) ?? []).length
  return columns > 0 ? columns : null
}

/** `&`s outside braces and not escaped. */
function separators(text: string): number {
  let depth = 0
  let count = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '\\') {
      i++
      continue
    }
    if (c === '{') depth++
    else if (c === '}') depth = Math.max(0, depth - 1)
    else if (c === '&' && depth === 0) count++
  }
  return count
}

const MAX_HEADER = 160
const RULES = /\\(?:hline|midrule|toprule|bottomrule|cline\{[^}]*\}|cmidrule(?:\([^)]*\))?\{[^}]*\})/g

function stripRules(row: string): string {
  return maskComments(row).replace(RULES, '').replace(/\s+/g, ' ').trim()
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function rowsInfo(env: { name: string; at: number }, doc: string, masked: string, pos: number): RowsInfo {
  const afterName = masked.indexOf('}', env.at) + 1
  // tabular* / tabularx / xltabular / tabulary take a width before the spec
  const widthFirst = /^(?:tabular\*|tabularx|xltabular|tabulary|NiceTabular\*|NiceTabularX)$/.test(env.name)
  let specArg = argumentAt(masked, doc, afterName)
  if (specArg && widthFirst) specArg = argumentAt(masked, doc, specArg.end)
  const takesSpec = /tabular|array|longtable|tabu|tblr|NiceTabular|NiceArray|alignat/i.test(env.name)
  const bodyStart = takesSpec && specArg ? specArg.end : afterName
  const body = masked.slice(bodyStart, pos)
  const rows = body.split(/\\\\/)
  const current = rows[rows.length - 1].replace(/^[^\n]*\\(?:hline|midrule|toprule|bottomrule)\b/, '')
  let columns = takesSpec && specArg && !/alignat/.test(env.name) ? countColumns(specArg.text) : null
  if (columns === null) {
    const seen = rows.slice(0, -1).map(row => separators(row) + 1)
    columns = seen.length > 0 ? Math.max(...seen) : null
  }
  const lineBefore = doc.slice(doc.lastIndexOf('\n', pos - 1) + 1, pos)
  const atRowStart =
    !/\S/.test(current.replace(/\\(?:hline|midrule|toprule|bottomrule|cline\{[^}]*\})/g, '')) ||
    ROW_END.test(lineBefore)
  const first = rows.length > 1 ? stripRules(doc.slice(bodyStart, bodyStart + rows[0].length)) : ''
  return {
    columns,
    separatorsBefore: atRowStart ? 0 : separators(current),
    atRowStart,
    header: first ? oneLine(first, MAX_HEADER) : null,
  }
}

/** The command whose `{…}` argument holds `pos`, looked for on the current line and a little before. */
function argumentCommand(masked: string, pos: number): string | null {
  let depth = 0
  for (let i = pos - 1; i >= Math.max(0, pos - 2000); i--) {
    const c = masked[i]
    if (masked[i - 1] === '\\') continue
    if (c === '}') depth++
    else if (c === '{') {
      if (depth > 0) {
        depth--
        continue
      }
      const command = /\\([A-Za-z@]+)\*?\s*(?:\[[^\]]*\]\s*)?$/.exec(masked.slice(Math.max(0, i - 80), i))
      return command ? command[1] : null
    }
  }
  return null
}

/** Arguments that hold words for the reader, and what to call them. */
const TEXT_ARGUMENTS: Record<string, string> = {
  part: 'heading',
  chapter: 'heading',
  section: 'heading',
  subsection: 'heading',
  subsubsection: 'heading',
  paragraph: 'heading',
  subparagraph: 'heading',
  frametitle: 'heading',
  framesubtitle: 'heading',
  title: 'title',
  subtitle: 'title',
  caption: 'caption',
  subcaption: 'caption',
  footnote: 'footnote',
  thanks: 'footnote',
  emph: 'emphasis',
  textbf: 'emphasis',
  textit: 'emphasis',
  underline: 'emphasis',
  text: 'math text',
  textrm: 'math text',
  mbox: 'math text',
  intertext: 'math text',
}

/** The language of a listing, from `[language=…]`, `\begin{minted}{…}` or the environment's name. */
function codeLanguage(env: OpenEnv): string | null {
  const option = /language\s*=\s*\{?([A-Za-z0-9+#-]+)/.exec(env.begin)
  if (option) return option[1]
  const minted = /^\\begin\s*\{minted\}\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/.exec(env.begin)
  if (minted) return minted[1]
  if (/^py/.test(env.name)) return 'Python'
  if (/^sage/.test(env.name)) return 'Sage'
  if (/^algorithm|pseudocode|codebox/.test(env.name)) return 'pseudocode (algorithmic commands such as \\State, \\If, \\For)'
  return null
}

/** `\\begin{tabular}{|l|c|r|}` as the model reads it, shortened. */
function shown(begin: string): string {
  return begin.length > 80 ? `${begin.slice(0, 79)}…` : begin
}

/** What the cursor's place is, and what may be written there. */
export function describeCursor(
  doc: string,
  pos: number,
  kind: CompletionKind,
  inMath: boolean
): CursorSituation {
  const masked = maskComments(doc)
  const lineStart = doc.lastIndexOf('\n', pos - 1) + 1
  const lineEnd = doc.indexOf('\n', pos)
  const line = doc.slice(lineStart, lineEnd === -1 ? doc.length : lineEnd)
  const before = doc.slice(lineStart, pos)
  const after = doc.slice(pos)
  const lineRest = line.slice(pos - lineStart)
  const indent = /^[ \t]*/.exec(line)![0]
  const documentBegin = masked.search(/\\begin\s*\{document\}/)
  const region: CursorSituation['region'] =
    documentBegin !== -1
      ? pos <= documentBegin
        ? 'preamble'
        : 'body'
      : /\\(?:documentclass|usepackage)\b/.test(masked)
        ? 'preamble'
        : 'body'

  const open = openEnvironments(doc, masked, pos)
  const maskedAfter = maskComments(after)
  const envs: OpenEnv[] = open.map(env => {
    const lineEndAt = doc.indexOf('\n', env.at)
    return {
      name: env.name,
      role: envRole(env.name, doc),
      begin: doc.slice(env.at, lineEndAt === -1 ? undefined : Math.min(lineEndAt, env.at + 160)).trim(),
      closedAfter: new RegExp(`\\\\end\\s*\\{${env.name.replace(/[*]/g, '\\*')}\\}`).test(maskedAfter),
    }
  })
  const innermost = envs[envs.length - 1] ?? null
  const rows = innermost?.role === 'rows' ? rowsInfo(open[open.length - 1], doc, masked, pos) : null
  const argumentOf = argumentCommand(masked, pos)
  const argumentClosed = argumentOf !== null && /^\s*\}/.test(maskComments(lineRest))
  const rowEndAfter = rows !== null && /\\\\/.test(maskComments(lineRest))
  const mathRows = rows !== null && innermost !== null && ALL_MATH_ENVS.has(innermost.name)

  const forbidBegin = new Set<string>()
  for (const env of envs) {
    if (NO_NESTING.has(env.role)) forbidBegin.add(env.name)
  }
  const inTable = rows !== null || envs.some(env => ALL_TABLE_ENVS.has(env.name))
  if (inTable) {
    for (const name of ALL_TABLE_ENVS) forbidBegin.add(name)
  }
  if (envs.some(env => env.role === 'float' || ALL_FLOAT_ENVS.has(env.name))) {
    for (const name of ALL_FLOAT_ENVS) forbidBegin.add(name)
  }
  if (inMath || envs.some(env => env.role === 'math' || ALL_MATH_ENVS.has(env.name))) {
    for (const name of ALL_MATH_ENVS) forbidBegin.add(name)
  }
  // What the text after the cursor starts with is not opened again
  const nextStructure = nextStructureInSuffix(after)
  if (nextStructure?.type === 'env') {
    forbidBegin.add(nextStructure.name)
    for (const family of [ALL_TABLE_ENVS, ALL_FLOAT_ENVS, ALL_MATH_ENVS]) {
      if (family.has(nextStructure.name)) for (const name of family) forbidBegin.add(name)
    }
  }

  const lastCommand = LAST_COMMAND.exec(before)
  const endsWithStructure = !argumentOf && endsWithStructureLine(before, lineRest)
  const afterHeading =
    endsWithStructure && lastCommand !== null && /^(?:part|chapter|section|subsection|subsubsection|paragraph)\*?$/.test(lastCommand[1])
  const forbidEnd = envs.filter(env => env.closedAfter).map(env => env.name)

  const blankBefore = !/\S/.test(before)
  const announces =
    !blankBefore && !inMath && !argumentOf && rows === null && (!innermost || innermost.role === 'prose' || innermost.role === 'list')
      ? announcedBlock(before)
      : null
  const newLine =
    endsWithStructure ||
    (rows !== null && ROW_END.test(before) && !/\S/.test(lineRest)) ||
    (kind === 'block' && announces !== null)
  const sameLine =
    !newLine && !blankBefore && kind !== 'block' && kind !== 'code' && !SENTENCE_END.test(before)
  const introducesDisplay =
    !newLine &&
    !blankBefore &&
    !inMath &&
    !argumentOf &&
    (!innermost || innermost.role === 'prose' || innermost.role === 'list') &&
    INTRODUCES.test(maskComments(before))

  const where = envs.length > 0 ? envs.map(env => env.name).join(' > ') : 'the body text'
  const parts: string[] = []
  const textArgument = argumentOf ? TEXT_ARGUMENTS[argumentOf.replace(/\*$/, '')] : undefined
  const closeNote = argumentClosed
    ? ' Its closing brace is already after the cursor: stop before it.'
    : ' Close it with } once it is complete, and stop there.'

  if (region === 'preamble' && !argumentOf) {
    parts.push(
      'The cursor is in the preamble. Write only preamble lines, one per line: \\usepackage{…} for packages the document needs, or definitions and settings (\\newcommand, \\title, \\author). No document text, no \\begin{document}.'
    )
  } else if (argumentOf && textArgument) {
    const what: Record<string, string> = {
      heading: `the title of this \\${argumentOf}: a short noun phrase, capitalised like the other headings, no full stop`,
      title: 'the document title: a concise, specific noun phrase',
      caption: 'the caption: what the figure or table shows, in one or two sentences',
      footnote: 'the footnote: one short sentence',
      emphasis: 'the emphasised words only',
      'math text': 'the words of this text inside the formula only',
    }
    parts.push(
      `The cursor is inside \\${argumentOf}{…} (in ${where}). Write ${what[textArgument]}, on this line.${closeNote}`
    )
  } else if (argumentOf) {
    parts.push(
      `The cursor is inside the argument of \\${argumentOf}{…} (in ${where}). Complete that argument only, on this line, in the form its command expects.${closeNote}`
    )
  } else if (rows && innermost) {
    const spec = shown(innermost.begin || innermost.name)
    const count = rows.columns ? `${rows.columns} columns` : 'as many columns as the rows above'
    const header = rows.header ? ` Its first row is: ${rows.header}` : ''
    const unit = mathRows ? 'aligned formula' : 'table'
    if (rows.atRowStart || newLine) {
      parts.push(
        `The cursor ${newLine ? 'is at the end of a finished row' : 'starts a new row'} of the ${unit} ${spec} (${count}).${header}` +
          (mathRows
            ? ` ${newLine ? 'Start with a line break, then w' : 'W'}rite the next line of the derivation: the same & alignment as the lines above, ending with \\\\ only if another line follows.`
            : ` ${newLine ? 'Start with a line break, then w' : 'W'}rite the next row: ${rows.columns ? `exactly ${rows.columns} cells` : 'as many cells as the rows above'} separated by &, ending with \\\\. Fill the cells with plausible content of the same type and format as the column above; at most three rows, one per line.`)
      )
    } else {
      const left = rows.columns ? Math.max(0, rows.columns - 1 - rows.separatorsBefore) : null
      const ending = rowEndAfter ? 'The row\'s \\\\ is already after the cursor: do not write it.' : 'End the row with \\\\.'
      parts.push(
        mathRows
          ? `The cursor is in a line of the aligned formula ${spec}. Continue this line of math only (no $, \\[, or text outside math). ${ending}`
          : `The cursor is in cell ${rows.separatorsBefore + 1} of a row of the ${unit} ${spec} (${count}).${header}` +
              ` Finish this cell${left !== null ? `, then ${left === 0 ? 'no more cells' : `${left} more cell${left === 1 ? '' : 's'} separated by &`}` : ''}, matching the columns above. ${ending} Only this row.`
      )
    }
  } else if (innermost?.role === 'list' && (blankBefore || newLine)) {
    parts.push(
      `The cursor ${newLine ? 'ends the line that opens' : 'is on a new line of'} the ${innermost.name} list (in ${where}). ${newLine ? 'Start with a line break, then w' : 'W'}rite the next item: \\item and its text, parallel in form and length to the items above. One item.`
    )
  } else if (innermost?.role === 'list') {
    parts.push(
      `The cursor is in the text of an \\item of the ${innermost.name} list (in ${where}). Continue this item on this line, keeping it parallel to the other items; do not start a new \\item.`
    )
  } else if (inMath || innermost?.role === 'math') {
    const display = innermost?.role === 'math' ? ` inside ${innermost.name}` : ''
    parts.push(
      newLine
        ? `The cursor ends the line that opens ${innermost?.name ?? 'the formula'} (in ${where}). Start with a line break, then write the body of the formula: LaTeX math only, the notation used in the text above.`
        : `The cursor is in math mode${display} (in ${where}). Continue the formula with LaTeX math only (no $, \\(, \\[ and no prose), using the notation of the text above.${/^\s*(?:\$|\\\))/.test(lineRest) ? ' The closing delimiter is already after the cursor.' : ''}`
    )
  } else if (innermost && innermost.role === 'drawing') {
    parts.push(
      `The cursor is inside ${innermost.name} (in ${where}): drawing code. Continue with the drawing commands it uses (\\draw, \\node, \\fill, \\path, \\addplot…), each ending with ;, consistent with the coordinates and styles above. No prose.`
    )
  } else if (innermost && innermost.role === 'code') {
    const language = codeLanguage(innermost)
    parts.push(
      `The cursor is inside ${innermost.name} (in ${where}): verbatim code${language ? ` in ${language}` : ''}. Continue the code line by line with its indentation and style; no LaTeX, no prose.`
    )
  } else if (innermost && innermost.role === 'float') {
    parts.push(
      `The cursor is among the parts of ${innermost.name} (in ${where}). Write the next part it still lacks, on its own line: \\centering, \\includegraphics[…]{…}, \\caption{…} or \\label{…}.`
    )
  } else if (newLine && afterHeading) {
    parts.push(
      `The cursor ends the heading line \\${lastCommand![1]}{…} (in ${where}). Start with a line break, then write the opening sentence of this part: introduce what the heading names, in the voice of the document. No table, float or other heading.`
    )
  } else if (newLine && lastCommand) {
    parts.push(
      `The cursor ends a line holding \\${lastCommand[1]}… (in ${where}). Start with a line break, then write what naturally comes next: usually a sentence that goes on with the argument of the text above.`
    )
  } else if (blankBefore) {
    parts.push(
      `The cursor is on an empty line in ${where}. Write what comes next here: the next sentence of the paragraph, or the next block the text calls for.`
    )
  } else if (announces && newLine) {
    parts.push(
      `The text before the cursor (in ${where}) announces ${announces === 'equation' ? 'a formula' : `${announces === 'algorithm' ? 'an' : 'a'} ${announces}`}.` +
        ` Start with a line break, then write ${ANNOUNCED_FORMS[announces]}.` +
        ' Its content must be what the surrounding text describes, specific and consistent with it. Write the whole block up to its last \\end{…}, each part on its own line, and stop there.'
    )
  } else if (introducesDisplay) {
    parts.push(
      `The text before the cursor (in ${where}) announces something: write what it announces.` +
        ' A formula goes on the next lines as a display: start with a line break, then \\begin{equation} (align for several lines), its body on its own indented line, and \\end{equation} on its own line; stop after it. A list goes on the next lines the same way, one \\item per line.' +
        ' If it announces words instead, continue on this line.'
    )
  } else if (sameLine) {
    const trailing = maskComments(lineRest).trim()
    parts.push(
      `The cursor is in the middle of a sentence in ${where}. Finish this sentence on the same line so that it reads grammatically from the words before the cursor, and end it with the right punctuation.` +
        (trailing ? ` The line goes on with "${trailing}" right after your text: write only what goes before it.` : '') +
        ' Only if the sentence goes on to introduce a formula (ending with ":" or "given by") may that display follow on the next lines, never on this one.'
    )
  } else {
    parts.push(
      `The sentence before the cursor (in ${where}) is complete. Write the next sentence of the paragraph, on the same line, carrying its argument one step further.`
    )
  }
  if (nextStructure?.type === 'env' && !argumentOf) {
    parts.push(`\\begin{${nextStructure.name}} already follows the cursor: do not write it.`)
  }
  if (!argumentOf) {
    if (innermost?.closedAfter) parts.push(`\\end{${innermost.name}} already follows: do not write it.`)
    if (forbidBegin.size > 0) {
      parts.push(`Never open ${[...forbidBegin].slice(0, 6).map(name => `\\begin{${name}}`).join(', ')} here.`)
    }
  }

  return {
    kind,
    region,
    envs,
    rows,
    argumentOf,
    argumentClosed,
    newLine,
    sameLine,
    introducesDisplay,
    announces,
    rowEndAfter,
    lineRest,
    indent,
    forbidBegin: [...forbidBegin],
    forbidEnd,
    instruction: parts.join(' '),
  }
}
