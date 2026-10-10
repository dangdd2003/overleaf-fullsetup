import { maskComments } from '../texgpt/latex-text'
import { labelsIn, labelStyle as preferredLabelStyle } from '../generator/labels'

export { labelsIn }

export const DEFAULT_LABEL_STYLE = 'eq:'

/** Equation-label prefixes, the longer of two overlapping ones first. */
const EQUATION_LABEL_PREFIXES = ['equation:', 'eqn:', 'eq:', 'eqn-', 'eq-', 'eq.', 'eq_']

/** The prefix the project's equation labels use most; `eq:` when it has none. */
export function labelStyle(labels: Iterable<string>): string {
  return preferredLabelStyle(labels, EQUATION_LABEL_PREFIXES, DEFAULT_LABEL_STYLE)
}

const HABITS: Array<[string, RegExp]> = [
  ['equation', /\\begin\s*\{equation\}/g],
  ['equation*', /\\begin\s*\{equation\*\}/g],
  ['align', /\\begin\s*\{align\}/g],
  ['align*', /\\begin\s*\{align\*\}/g],
  ['gather', /\\begin\s*\{gather\*?\}/g],
  ['multline', /\\begin\s*\{multline\*?\}/g],
  ['\\[', /\\\[/g],
  ['$$', /(?<!\\)\$\$/g],
  ['\\(', /\\\(/g],
]

/** How often the open file uses each equation form, e.g. `equation:12 align:5`. */
export function equationHabits(doc: string): string {
  const masked = maskComments(doc)
  return HABITS.map(([name, pattern]) => {
    const found = [...masked.matchAll(pattern)].length
    return [name, name === '$$' ? Math.floor(found / 2) : found] as const
  })
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name}:${count}`)
    .join(' ')
}

/** Inline math as the author writes it: `\(…\)` when the file uses it more than `$…$`. */
export function prefersParenInline(doc: string): boolean {
  const masked = maskComments(doc)
  const paren = [...masked.matchAll(/\\\(/g)].length
  const dollars = [...masked.matchAll(/(?<![\\$])\$(?!\$)/g)].length / 2
  return paren > dollars
}
