import { maskComments } from '../texgpt/latex-text'
import { labelStyle } from '../generator/labels'
import { findTabulars } from './columns'

export type RuleStyle = 'booktabs' | 'hline'
export type CaptionPosition = 'top' | 'bottom'

/** How the document's tables look, read once per Generate. The request overrides them. */
export type TableHabits = {
  rules: RuleStyle
  /** More than half of the column specs have `|`. */
  vlines: boolean
  caption: CaptionPosition
  /** `\begin{table}[…]`'s argument; null for none. */
  placement: string | null
  centering: 'centering' | 'center'
  /** A font switch more than half the tables use (`\small`), or null. */
  size: string | null
  labelStyle: string
  /** How often each tabular environment appears, e.g. `tabular:5 tabularx:1`. */
  envs: string
  twoColumn: boolean
  /** One level of indentation: a tab or two spaces. */
  indent: string
  /** Letters defined with `\newcolumntype`. */
  columnTypes: Set<string>
}

export const DEFAULT_TABLE_LABEL_STYLE = 'tab:'
/** Table-label prefixes, the longer of two overlapping ones first. */
export const TABLE_LABEL_PREFIXES = ['table:', 'tab:', 'tbl:', 'tab-', 'tbl-']

const TABLE_FLOAT = /\\begin\s*\{(table\*?)\}(\s*\[[^\]]*\])?([\s\S]*?)\\end\s*\{\1\}/g
const TABULAR_START = /\\begin\s*\{(?:tabular\*?|tabularx|longtable)\}/
const SIZE = /\\(tiny|scriptsize|footnotesize|small)\b/
const ENVIRONMENTS: Array<[string, RegExp]> = [
  ['tabular', /\\begin\s*\{tabular\}/g],
  ['tabular*', /\\begin\s*\{tabular\*\}/g],
  ['tabularx', /\\begin\s*\{tabularx\}/g],
  ['longtable', /\\begin\s*\{longtable\}/g],
]

function mostCommon<T>(values: T[]): T | undefined {
  const counts = new Map<T, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  let best: T | undefined
  let bestCount = 0
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value
      bestCount = count
    }
  }
  return best
}

/** Whether the document sets text in two page columns. */
export function isTwoColumn(doc: string): boolean {
  const match = maskComments(doc).match(/\\documentclass\s*(?:\[([^\]]*)\])?\s*\{([^}]+)\}/)
  if (!match) return false
  const options = (match[1] ?? '').split(',').map(option => option.trim())
  const documentClass = match[2].trim()
  if (options.includes('twocolumn')) return true
  if (documentClass === 'IEEEtran') return !options.includes('onecolumn')
  if (documentClass === 'acmart') return options.includes('sigconf') || options.includes('sigplan')
  return false
}

/**
 * The document's table habits. `doc` is the whole document (comments are
 * ignored), `labels` the project's labels, `loaded` its packages.
 */
export function tableHabits(
  doc: string,
  labels: Iterable<string>,
  loaded: Set<string>
): TableHabits {
  const text = maskComments(doc)
  const floats = [...text.matchAll(TABLE_FLOAT)].map(match => ({
    placement: (match[2] ?? '').trim().replace(/^\[|\]$/g, '').trim(),
    body: match[3],
  }))

  const rules: RuleStyle = /\\(?:top|mid|bottom)rule\b/.test(text)
    ? 'booktabs'
    : /\\hline\b/.test(text)
      ? 'hline'
      : loaded.has('booktabs')
        ? 'booktabs'
        : 'hline'

  const specs = findTabulars(text).map(tabular => tabular.spec)
  const vlines =
    specs.length > 0 && specs.filter(spec => spec.includes('|')).length * 2 > specs.length

  const positions = floats.flatMap(float => {
    const caption = float.body.search(/\\caption\b/)
    const tabular = float.body.search(TABULAR_START)
    if (caption === -1 || tabular === -1) return []
    return [caption < tabular ? 'top' : 'bottom']
  })
  const bottoms = positions.filter(position => position === 'bottom').length
  const caption: CaptionPosition = bottoms * 2 > positions.length ? 'bottom' : 'top'

  const placement =
    floats.length === 0 ? 'htbp' : mostCommon(floats.map(float => float.placement)) || null

  const centered = floats.filter(float => /\\centering\b/.test(float.body)).length
  const centerEnvironments = floats.filter(float => /\\begin\s*\{center\}/.test(float.body)).length

  const sizes = floats.map(float => SIZE.exec(float.body)?.[1] ?? '').filter(Boolean)
  const commonSize = mostCommon(sizes)
  const size =
    commonSize && sizes.filter(found => found === commonSize).length * 2 > floats.length
      ? `\\${commonSize}`
      : null

  const envs = ENVIRONMENTS.map(
    ([name, pattern]) => [name, [...text.matchAll(pattern)].length] as const
  )
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name}:${count}`)
    .join(' ')

  const lines = doc.split('\n')
  const tabs = lines.filter(line => /^\t+\S/.test(line)).length
  const spaces = lines.filter(line => /^ {2,}\S/.test(line)).length

  return {
    rules,
    vlines,
    caption,
    placement,
    centering: centerEnvironments > centered ? 'center' : 'centering',
    size,
    labelStyle: labelStyle(labels, TABLE_LABEL_PREFIXES, DEFAULT_TABLE_LABEL_STYLE),
    envs,
    twoColumn: isTwoColumn(doc),
    indent: tabs > spaces ? '\t' : '  ',
    columnTypes: new Set([...text.matchAll(/\\newcolumntype\s*\{(.)\}/g)].map(match => match[1])),
  }
}
