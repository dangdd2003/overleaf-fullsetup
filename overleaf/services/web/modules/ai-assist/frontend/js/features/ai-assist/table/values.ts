import { tabularCells } from '../generator/clipboard'
import { SelectionKind } from './context'
import { findTabulars, splitBody } from './columns'

/** How a value reads without LaTeX markup, for comparison only. */
export function plainValue(text: string): string {
  return text
    .replace(/\\[,;:! ]/g, ' ')
    .replace(/\\([%&#_${}])/g, '$1')
    .replace(/\\[a-zA-Z@]+\*?/g, ' ')
    .replace(/[{}$]/g, '')
    .replace(/~/g, ' ')
    .replace(/[\u2212\u2013]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A cell's content without the `\multicolumn{n}{spec}{…}` or `\multirow{n}{w}{…}` around it. */
function unwrapSpan(cell: string): string {
  const match =
    /^\\multi(?:column\s*\{[^}]*\}\s*\{[^}]*\}|row\s*(?:\[[^\]]*\]\s*)?\{[^}]*\}\s*(?:\[[^\]]*\]\s*)?\{[^}]*\})\s*\{([\s\S]*)\}$/.exec(
      cell.trim()
    )
  return match ? match[1] : cell
}

/** The cells of every table in `text`. */
function tableCells(text: string): string[] {
  return findTabulars(text).flatMap(tabular =>
    splitBody(tabular.body).rows.flatMap(row => row.cells.map(unwrapSpan))
  )
}

/**
 * The values the author gave, plain: the cells of tabular text in the
 * prompt, of a data selection, or of a selected table. Descriptions and
 * images give none: nothing to check them against.
 */
export function givenValues(
  prompt: string,
  selection: { kind: SelectionKind; text: string } | null
): string[] {
  const values = tabularCells(prompt)
  if (selection?.kind === 'data') values.push(...tabularCells(selection.text))
  if (selection?.kind === 'table') values.push(...tableCells(selection.text))
  return [...new Set(values.map(plainValue).filter(Boolean))]
}

/** The given values the table body does not contain. */
export function missingValues(values: string[], body: string): string[] {
  const text = plainValue(body)
  return values.filter(value => !text.includes(value))
}

export function valuesWarning(missing: string[]): string | null {
  if (missing.length === 0) return null
  const shown = missing.slice(0, 5).join(', ') + (missing.length > 5 ? '…' : '')
  return missing.length === 1
    ? `1 value from your data is not in the table: ${shown}`
    : `${missing.length} values from your data are not in the table: ${shown}`
}
