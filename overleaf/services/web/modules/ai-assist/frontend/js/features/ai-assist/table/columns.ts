import { matchingBrace } from '../texgpt/latex-text'

/** How many columns a column spec makes, and what in it is wrong. */
export type SpecColumns = { count: number; problems: string[] }

/** One row of a tabular body. */
export type TableRow = {
  /** 1-based, for messages. */
  number: number
  /** Cell texts, trimmed. */
  cells: string[]
  /** Columns the row spans, counting `\multicolumn`. */
  span: number
  /** Rule commands before the row (`\midrule`, `\cmidrule(lr){2-3}`). */
  rules: string[]
  /** A rule command after the cells, with no `\\` before it. */
  misplacedRule: boolean
}

/** A `tabular`-like environment found in some text. */
export type TabularSource = { env: string; spec: string; body: string; from: number; to: number }

/** Letters that make one column each: base LaTeX, tabularx (X), siunitx (S, s). */
const SINGLE = new Set(['l', 'c', 'r', 'X', 'S', 's'])

/** The `{…}` group at `at` (whitespace skipped): its content and the index after it. */
function readGroup(text: string, at: number): { content: string; end: number } | null {
  let i = at
  while (/\s/.test(text[i] ?? '')) i++
  if (text[i] !== '{') return null
  const close = matchingBrace(text, i)
  if (close === -1) return null
  return { content: text.slice(i + 1, close), end: close + 1 }
}

/** The index after an optional `[…]` at `at` (whitespace skipped), or `at`. */
function skipOptional(text: string, at: number): number {
  let i = at
  while (/\s/.test(text[i] ?? '')) i++
  if (text[i] !== '[') return at
  const close = text.indexOf(']', i)
  return close === -1 ? text.length : close + 1
}

/** How many columns `spec` makes. `custom` holds the document's `\newcolumntype` letters. */
export function countColumns(spec: string, custom: Set<string> = new Set()): SpecColumns {
  let count = 0
  const problems: string[] = []
  const group = (at: number) => {
    const found = readGroup(spec, at)
    if (found) return found
    problems.push(`The column spec "${spec}" is missing a { } argument.`)
    return { content: '', end: spec.length }
  }
  let i = 0
  while (i < spec.length) {
    const char = spec[i]
    if (/\s/.test(char) || char === '|' || char === ':') {
      i++
    } else if (char === '@' || char === '!' || char === '>' || char === '<') {
      i = group(i + 1).end
    } else if (char === '\\') {
      const name = /^\\[a-zA-Z]+/.exec(spec.slice(i))
      i += name ? name[0].length : 2
    } else if (char === '*') {
      const times = group(i + 1)
      const repeated = group(times.end)
      const n = parseInt(times.content.trim(), 10)
      const inner = countColumns(repeated.content, custom)
      if (Number.isNaN(n)) problems.push(`*{${times.content}} needs a number.`)
      else count += n * inner.count
      problems.push(...inner.problems)
      i = repeated.end
    } else if (char === 'p' || char === 'm' || char === 'b') {
      count++
      i = group(i + 1).end
    } else if (char === 'w' || char === 'W') {
      count++
      i = group(group(i + 1).end).end
    } else if (SINGLE.has(char) || custom.has(char)) {
      count++
      i = char === 'S' || char === 's' ? skipOptional(spec, i + 1) : i + 1
    } else {
      problems.push(`Unknown column type "${char}" in the spec "${spec}".`)
      i++
    }
  }
  return { count, problems }
}

/** A rule command at the start of a row, with its arguments. */
const RULE =
  /^\\(?:(?:hline|toprule|midrule|bottomrule|morecmidrules)\b(?:\s*\[[^\]]*\])?|addlinespace\b(?:\s*\[[^\]]*\])?|(?:cmidrule|cline)\b(?:\s*\([^)]*\))?(?:\s*\[[^\]]*\])?\s*\{[^{}]*\}|specialrule\b(?:\s*\{[^{}]*\}){3}|hhline\b\s*\{[^{}]*\})/
const RULE_ANYWHERE = /\\(?:hline|toprule|midrule|bottomrule|cmidrule|cline)\b/
const MULTICOLUMN = /^\\multicolumn\s*\{\s*(\d+)\s*\}/

/** The body cut at `\\` outside braces (its `*` and `[length]` dropped). The last piece has no `\\`. */
function rowTexts(body: string): Array<{ text: string; ended: boolean }> {
  const pieces: Array<{ text: string; ended: boolean }> = []
  let depth = 0
  let start = 0
  for (let i = 0; i < body.length; i++) {
    const char = body[i]
    if (char === '\\') {
      if (body[i + 1] === '\\' && depth === 0) {
        pieces.push({ text: body.slice(start, i), ended: true })
        let next = i + 2
        if (body[next] === '*') next++
        if (body[next] === '[') {
          const close = body.indexOf(']', next)
          if (close !== -1) next = close + 1
        }
        start = next
        i = next - 1
      } else {
        // An escaped character, a command's first letter, or `\\` inside braces
        i++
      }
    } else if (char === '{') {
      depth++
    } else if (char === '}') {
      depth--
    }
  }
  pieces.push({ text: body.slice(start), ended: false })
  return pieces
}

/** Cells at `&` outside braces; `\&` is text. */
function splitCells(text: string): string[] {
  const cells: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '\\') {
      i++
    } else if (char === '{') {
      depth++
    } else if (char === '}') {
      depth--
    } else if (char === '&' && depth === 0) {
      cells.push(text.slice(start, i))
      start = i + 1
    }
  }
  cells.push(text.slice(start))
  return cells.map(cell => cell.trim())
}

function takeRules(text: string): { rules: string[]; rest: string } {
  const rules: string[] = []
  let rest = text.trimStart()
  for (let match = RULE.exec(rest); match; match = RULE.exec(rest)) {
    rules.push(match[0].trim())
    rest = rest.slice(match[0].length).trimStart()
  }
  return { rules, rest }
}

function spanOf(cells: string[]): number {
  return cells.reduce((sum, cell) => {
    const match = MULTICOLUMN.exec(cell)
    return sum + (match ? parseInt(match[1], 10) : 1)
  }, 0)
}

/** The rows of a tabular body, and the rules after the last one. */
export function splitBody(body: string): { rows: TableRow[]; trailingRules: string[] } {
  const rows: TableRow[] = []
  let trailingRules: string[] = []
  for (const piece of rowTexts(body)) {
    const { rules, rest } = takeRules(piece.text)
    if (!piece.ended && rest.trim() === '') {
      trailingRules = rules
      continue
    }
    const cells = splitCells(rest)
    rows.push({
      number: rows.length + 1,
      cells,
      span: spanOf(cells),
      rules,
      misplacedRule: RULE_ANYWHERE.test(rest),
    })
  }
  return { rows, trailingRules }
}

/** `\cmidrule` and `\cline` ranges outside the columns. */
function ruleRange(rule: string, columns: number, where: string): string[] {
  const match = /\\(?:cmidrule|cline)[^{]*\{\s*(\d+)\s*-\s*(\d+)\s*\}/.exec(rule)
  if (!match) return []
  const from = parseInt(match[1], 10)
  const to = parseInt(match[2], 10)
  return from < 1 || from > to || to > columns
    ? [`${rule} ${where} goes past the ${columns} columns.`]
    : []
}

/** A cell without its `$…$` and `\(…\)` math; null when a `$` is left open. */
function outsideMath(cell: string): string | null {
  const text = cell.replace(/\\\([\s\S]*?\\\)/g, '')
  let out = ''
  let inMath = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '\\') {
      if (!inMath) out += text.slice(i, i + 2)
      i++
    } else if (char === '$') {
      inMath = !inMath
    } else if (!inMath) {
      out += char
    }
  }
  return inMath ? null : out
}

function braceDepth(text: string): number {
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === '{') depth++
    else if (text[i] === '}') depth--
  }
  return depth
}

function rowProblems(row: TableRow, columns: number): string[] {
  const problems: string[] = []
  const name = `Row ${row.number}`
  if (row.span > columns) {
    problems.push(`${name} has ${row.span} cells but the spec has ${columns} columns.`)
  }
  for (const rule of row.rules) {
    problems.push(...ruleRange(rule, columns, `before row ${row.number}`))
  }
  if (row.misplacedRule) {
    problems.push(`${name}: a rule command follows the cells; end the row with \\\\ first.`)
  }
  const text = row.cells.join(' & ')
  if (/(?<!\\)%/.test(text)) problems.push(`${name}: unescaped % (write \\%).`)
  if (/(?<!\\)#/.test(text)) problems.push(`${name}: unescaped # (write \\#).`)
  if (braceDepth(text) !== 0) problems.push(`${name}: braces { } do not balance.`)
  for (const cell of row.cells) {
    const outside = outsideMath(cell)
    if (outside === null) {
      problems.push(`${name}: unbalanced $ in "${cell}".`)
    } else if (/(?<!\\)[_^]/.test(outside)) {
      problems.push(`${name}: _ or ^ outside math in "${cell}" (write \\_ or use $…$).`)
    }
  }
  return problems
}

/**
 * What in a tabular body would not compile with `columns` columns. Pass
 * `Infinity` when the spec is unknown: the counts are then not checked.
 */
export function bodyProblems(body: string, columns: number): string[] {
  const { rows, trailingRules } = splitBody(body)
  if (rows.length === 0) return ['The table has no rows.']
  const problems = rows.flatMap(row => rowProblems(row, columns))
  for (const rule of trailingRules) {
    problems.push(...ruleRange(rule, columns, 'after the last row'))
  }
  return problems
}

const TABULAR_BEGIN = /\\begin\s*\{(tabular\*?|tabularx|longtable)\}/g

/** Every `tabular`-like environment in the text, in order. Unclosed ones are skipped. */
export function findTabulars(text: string): TabularSource[] {
  const found: TabularSource[] = []
  for (const match of text.matchAll(TABULAR_BEGIN)) {
    const env = match[1]
    let at = (match.index ?? 0) + match[0].length
    if (env === 'tabularx' || env === 'tabular*') {
      const width = readGroup(text, at)
      if (!width) continue
      at = width.end
    }
    const spec = readGroup(text, skipOptional(text, at))
    if (!spec) continue
    const endTag = `\\end{${env}}`
    const end = text.indexOf(endTag, spec.end)
    if (end === -1) continue
    found.push({
      env,
      spec: spec.content.trim(),
      body: text.slice(spec.end, end),
      from: match.index ?? 0,
      to: end + endTag.length,
    })
  }
  return found
}
