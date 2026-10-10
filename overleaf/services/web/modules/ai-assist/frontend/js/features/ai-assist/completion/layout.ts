import { builtinRole } from './structure'

/**
 * Puts the LaTeX in a reply on the lines it belongs on. Models glue
 * structure to the text before it — `…as follows: \begin{equation} x \end{equation}`
 * — or write a whole table on one line. Here every block-level construct
 * starts its own line, its body goes on the lines inside it, one indent
 * deeper, and what follows its end goes on the next line:
 * - `\begin{…}` / `\end{…}` of displays, lists, floats, tables, code;
 * - `\[ … \]` and `$$ … $$`;
 * - headings (`\section{…}`…), `\item`;
 * - a float's `\centering`, `\includegraphics`, `\caption`;
 * - table and aligned-math rows: one per line, after `\\` and its rules.
 * Inline math, environments that live inside a formula (matrices, cases,
 * aligned…), the body of code and drawings, comments and arguments are
 * left as written.
 */
export type LayoutContext = {
  /** The text before the cursor: its last line decides whether the reply starts one. */
  before: string
  /** The environments open at the cursor, outermost first. */
  envs: string[]
  /** The indentation of the cursor's line. */
  indent: string
  /** One level of indentation, as the document writes it. */
  unit: string
  /** The reply must start on a new line (after `\section{…}`, a finished row…). */
  newLine?: boolean
}

/** Environments written inside a line of math or text: never broken out onto lines. */
const INLINE_ENVS = new Set([
  'math', 'array', 'darray', 'NiceArray', 'subarray',
  'matrix', 'matrix*', 'pmatrix', 'pmatrix*', 'bmatrix', 'bmatrix*', 'Bmatrix', 'Bmatrix*',
  'vmatrix', 'vmatrix*', 'Vmatrix', 'Vmatrix*', 'smallmatrix', 'smallmatrix*',
  'psmallmatrix', 'bsmallmatrix', 'NiceMatrix', 'pNiceMatrix', 'bNiceMatrix',
  'vNiceMatrix', 'VNiceMatrix', 'BNiceMatrix',
  'cases', 'cases*', 'dcases', 'dcases*', 'rcases', 'rcases*', 'drcases',
  'aligned', 'aligned*', 'alignedat', 'alignedat*', 'gathered', 'gathered*',
  'split', 'split*', 'multlined',
])

export function isInlineEnv(name: string): boolean {
  return INLINE_ENVS.has(name)
}

/** Environments whose `{…}` arguments belong on their `\begin` line. */
const TAKES_ARGUMENTS =
  /^(?:tabular\*?|tabularx|tabulary|xltabular|longtable\*?|supertabular\*?|xtabular|tabu|longtabu|tblr|longtblr|talltblr|NiceTabular\*?|NiceTabularX|alignat\*?|flalign\*?|IEEEeqnarray\*?|minipage|multicols\*?|subfigure|subtable|wrapfigure|wraptable|minted|tcolorbox|adjustbox|threeparttable|columns|column|frame|block|alertblock|exampleblock|theorem|lemma|definition|proof)$/

/** Separated from a full sentence before the cursor by a blank line. */
const PARAGRAPH_BLOCKS = new Set(['float', 'section'])

const SECTIONING = new Set([
  'part', 'chapter', 'section', 'subsection', 'subsubsection',
  'part*', 'chapter*', 'section*', 'subsection*', 'subsubsection*',
])
/** Commands of a float that each take a line. */
const FLOAT_PARTS = new Set(['centering', 'includegraphics', 'caption', 'subcaption'])
/** Rules that stay on the line of the `\\` before them. */
const RULES = /^[ \t]*(?:\\(?:hline|midrule|toprule|bottomrule|addlinespace|cline|cmidrule|specialrule)\b(?:\([^)\n]*\))?(?:\[[^\]\n]*\])?(?:\{[^}\n]*\})*[ \t]*)+/

const RULE_NAMES = new Set(['hline', 'midrule', 'toprule', 'bottomrule', 'addlinespace', 'cline', 'cmidrule', 'specialrule'])

const SENTENCE_END = /[.?!]['")\]}]*[ \t]*$/

/** The role a layout gives an environment. */
function blockRole(name: string): string {
  if (INLINE_ENVS.has(name)) return 'inline'
  return builtinRole(name) ?? 'prose'
}

/** One row per line: tables and aligned display math, not matrices or cases. */
function rowsPerLine(name: string | undefined): boolean {
  return name !== undefined && !INLINE_ENVS.has(name) && builtinRole(name) === 'rows'
}

/** The end of the `[…]` or `{…}` group opening at `from`; -1 when it is not closed. */
function groupEnd(text: string, from: number): number {
  const open = text[from]
  const close = open === '[' ? ']' : '}'
  let depth = 0
  for (let i = from; i < text.length; i++) {
    const c = text[i]
    if (c === '\\') {
      i++
      continue
    }
    if (c === open) depth++
    else if (c === close && --depth === 0) return i + 1
    else if (c === '\n' && open === '[') return -1
  }
  return -1
}

/** The indentation one guesses the document uses: the smallest step between lines. */
export function indentUnit(text: string, fallback = '    '): string {
  if (/^\t/m.test(text)) return '\t'
  let unit = Infinity
  let previous = 0
  for (const line of text.split('\n')) {
    if (!/\S/.test(line)) continue
    const width = /^ */.exec(line)![0].length
    if (width > previous) unit = Math.min(unit, width - previous)
    previous = width
  }
  return Number.isFinite(unit) && unit >= 2 && unit <= 8 ? ' '.repeat(unit) : fallback
}

export function layoutLatex(text: string, ctx: LayoutContext): string {
  const lastLine = ctx.before.slice(ctx.before.lastIndexOf('\n') + 1)
  /** Environments open at each point, outermost first; those opened in the reply are counted in `depth`. */
  const stack = [...ctx.envs]
  let depth = 0
  let out = ''
  /** The current output line has text (on the first line, the cursor's line counts). */
  let content = /\S/.test(lastLine)
  /** What the current line holds, for the sentence test on the first line. */
  let lineText = lastLine
  let braces = 0
  let inlineMath: '$' | '(' | null = null
  let display: '[' | '$$' | null = null

  const indentAt = (level: number) =>
    level >= 0
      ? ctx.indent + ctx.unit.repeat(level)
      : ctx.indent.slice(0, Math.max(0, ctx.indent.length - ctx.unit.length * -level))

  const emit = (piece: string) => {
    out += piece
    const newline = piece.lastIndexOf('\n')
    if (newline === -1) {
      lineText += piece
      if (/\S/.test(piece)) content = true
    } else {
      lineText = piece.slice(newline + 1)
      content = /\S/.test(lineText)
    }
  }

  /** Ends the line here (unless it is empty already) and indents the next one. */
  const breakLine = (level: number, blank = false) => {
    if (!content) {
      // Already on a line of its own: only its indentation changes
      if (out.includes('\n')) {
        out = out.replace(/[ \t]*$/, '')
        emit(indentAt(level))
      }
      return
    }
    // A blank line only where the reply starts: inside it, it would end the reply as a paragraph break
    const paragraph = blank && out.trim() === '' && SENTENCE_END.test(lineText)
    out = out.replace(/[ \t]+$/, '')
    emit(`${paragraph ? '\n\n' : '\n'}${indentAt(level)}`)
  }

  /** The model's own line break: a line it starts at column 0 gets the indent of its level. */
  const newlineAt = (i: number): number => {
    out = out.replace(/[ \t]+$/, '')
    emit('\n')
    let j = i + 1
    while (text[j] === '\n') {
      emit('\n')
      j++
    }
    if (j < text.length && !/[ \t]/.test(text[j])) {
      const closes = /^\\end\s*\{([^}]*)\}/.exec(text.slice(j))
      const closesBlock = closes && blockRole(closes[1].trim()) !== 'inline' ? 1 : 0
      emit(indentAt(depth - closesBlock))
    }
    return j
  }

  /** Text after a construct on its line goes on the next one, unless it is a comment or a `\label`. */
  const breakBeforeRest = (i: number, level: number): number => {
    let j = i
    while (text[j] === ' ' || text[j] === '\t') j++
    if (j >= text.length || text[j] === '\n' || text[j] === '%') return i
    // `\begin{equation}\label{…}`, `\section{…}\label{…}`: the label stays, what follows it moves
    const label = /^\\label\s*\{[^{}\n]*\}/.exec(text.slice(j))
    if (label) {
      emit(text.slice(i, j + label[0].length))
      return breakBeforeRest(j + label[0].length, level)
    }
    breakLine(level)
    return j
  }

  let i = 0
  if (ctx.newLine) {
    const start = /^\s*/.exec(text)![0].length
    if (start < text.length && content) {
      breakLine(0)
      i = start
    }
  }

  while (i < text.length) {
    const c = text[i]
    const rest = text.slice(i)

    if (c === '\n') {
      i = newlineAt(i)
      continue
    }
    if (c === '%') {
      const end = text.indexOf('\n', i)
      emit(end === -1 ? rest : text.slice(i, end))
      i = end === -1 ? text.length : end
      continue
    }
    if (c === '{') braces++
    if (c === '}') braces = Math.max(0, braces - 1)
    if (c !== '\\' && c !== '$') {
      emit(c)
      i++
      continue
    }

    // Inline math is never laid out
    if (c === '$' && text[i + 1] !== '$' && !display) {
      if (inlineMath === '$') inlineMath = null
      else if (!inlineMath) inlineMath = '$'
      emit(c)
      i++
      continue
    }
    if (inlineMath || braces > 0) {
      if (rest.startsWith('\\)') && inlineMath === '(') inlineMath = null
      const step = c === '\\' ? Math.min(2, rest.length) : 1
      emit(rest.slice(0, step))
      i += step
      continue
    }
    if (rest.startsWith('\\(')) {
      inlineMath = '('
      emit('\\(')
      i += 2
      continue
    }

    // Display math: `\[ … \]`, `$$ … $$`, each delimiter on its own line
    const opensDisplay = (rest.startsWith('\\[') && !display) || (rest.startsWith('$$') && !display)
    const closesDisplay =
      (rest.startsWith('\\]') && display === '[') || (rest.startsWith('$$') && display === '$$')
    if (opensDisplay || closesDisplay) {
      const delimiter = rest.slice(0, 2)
      if (opensDisplay) {
        breakLine(depth)
        emit(delimiter)
        display = delimiter === '$$' ? '$$' : '['
        depth++
        i = breakBeforeRest(i + 2, depth)
      } else {
        depth--
        breakLine(depth)
        emit(delimiter)
        display = null
        i = breakBeforeRest(i + 2, depth)
      }
      continue
    }

    if (c === '$') {
      emit(c)
      i++
      continue
    }

    // `\\`: a row break; in a table or aligned math, the next row starts a line
    if (rest.startsWith('\\\\')) {
      let j = i + 2
      if (text[j] === '*') j++
      if (text[j] === '[') {
        const end = groupEnd(text, j)
        if (end !== -1) j = end
      }
      const rules = RULES.exec(text.slice(j))
      if (rules) j += rules[0].length
      emit(text.slice(i, j))
      i = rowsPerLine(stack[stack.length - 1]) ? breakBeforeRest(j, depth) : j
      continue
    }

    const command = /^\\([A-Za-z@]+\*?)/.exec(rest)
    if (!command) {
      emit(rest.slice(0, 2))
      i += 2
      continue
    }
    const name = command[1]

    if (name === 'begin' || name === 'end') {
      const env = /^\\(?:begin|end)\s*\{([^}]*)\}/.exec(rest)
      if (!env) {
        // Cut mid-name by the stream: shown as it is
        emit(rest)
        break
      }
      const envName = env[1].trim()
      const role = blockRole(envName)
      if (role === 'inline' || display) {
        if (name === 'begin') stack.push(envName)
        else if (stack[stack.length - 1] === envName) stack.pop()
        emit(env[0])
        i += env[0].length
        continue
      }

      if (name === 'begin') {
        breakLine(depth, PARAGRAPH_BLOCKS.has(role))
        let j = i + env[0].length
        // The options and arguments of the `\begin` line
        while (text[j] === '[' || (text[j] === '{' && TAKES_ARGUMENTS.test(envName))) {
          const end = groupEnd(text, j)
          if (end === -1) break
          j = end
        }
        emit(text.slice(i, j))
        stack.push(envName)
        depth++
        if (role === 'code' || role === 'drawing') {
          // The body is code, up to the `\end`: verbatim kept exactly, a drawing indented
          const close = text.indexOf(`\\end{${envName}}`, j)
          const to = close === -1 ? text.length : close
          let k = breakBeforeRest(j, depth)
          while (k < to) {
            if (text[k] === '\n' && role === 'drawing') {
              k = newlineAt(k)
              continue
            }
            emit(text[k])
            k++
          }
          i = to
          continue
        }
        i = breakBeforeRest(j, depth)
        continue
      }

      // \end
      const at = stack.lastIndexOf(envName)
      if (at !== -1) stack.splice(at)
      depth--
      breakLine(depth)
      emit(env[0])
      i = breakBeforeRest(i + env[0].length, depth)
      continue
    }

    if (display) {
      emit(command[0])
      i += command[0].length
      continue
    }

    if (SECTIONING.has(name)) {
      breakLine(depth, true)
      let j = i + command[0].length
      while (text[j] === '[' || text[j] === '{') {
        const end = groupEnd(text, j)
        if (end === -1) break
        j = end
        if (text[end - 1] === '}') break
      }
      emit(text.slice(i, j))
      i = breakBeforeRest(j, depth)
      continue
    }

    // A rule opening a line of a table takes the line: `\toprule` above the header row
    const rule = RULE_NAMES.has(name) && !content && rowsPerLine(stack[stack.length - 1]) ? RULES.exec(rest) : null
    if (rule) {
      emit(rule[0].replace(/[ \t]+$/, ''))
      i = breakBeforeRest(i + rule[0].length, depth)
      continue
    }

    if (name === 'item') {
      breakLine(depth)
    } else if (FLOAT_PARTS.has(name) && stack.some(env => blockRole(env) === 'float')) {
      breakLine(depth)
    }
    emit(command[0])
    i += command[0].length
  }

  return out
}
