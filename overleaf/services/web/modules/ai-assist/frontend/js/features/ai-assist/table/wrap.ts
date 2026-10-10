import { InsertWhere } from './context'
import { TableHabits } from './hints'

export type TableEnv = 'tabular' | 'tabularx'

/** What the model chose; code wraps it into the document's style. */
export type TableShape = {
  env: TableEnv
  spec: string
  body: string
  /** Null: no caption and no label. */
  caption: string | null
  label: string | null
  /** A full-width float (`table*`), honoured in two-column documents only. */
  wide: boolean
  /** False: the tabular alone. */
  float: boolean
}

/** The rows, trimmed, one per line, `depth` levels in; blank lines dropped. */
function rowLines(body: string, unit: string, depth: number): string[] {
  return body
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => unit.repeat(depth) + line)
}

function tabularLines(shape: TableShape, unit: string, depth: number, width: string): string[] {
  const pad = unit.repeat(depth)
  const begin =
    shape.env === 'tabularx'
      ? `\\begin{tabularx}{${width}}{${shape.spec}}`
      : `\\begin{tabular}{${shape.spec}}`
  return [pad + begin, ...rowLines(shape.body, unit, depth + 1), `${pad}\\end{${shape.env}}`]
}

function captionLines(shape: TableShape, pad: string): string[] {
  if (!shape.caption) return []
  const lines = [`${pad}\\caption{${shape.caption}}`]
  if (shape.label) lines.push(`${pad}\\label{${shape.label}}`)
  return lines
}

/** The table as inserted, without the anchor line's indentation (`spliceBlock` adds it). */
export function wrapTable(shape: TableShape, habits: TableHabits, where: InsertWhere): string {
  const unit = habits.indent
  if (where.kind === 'inner' || !shape.float) {
    const tabular = tabularLines(shape, unit, 0, '\\linewidth')
    if (where.kind !== 'inner' || where.hasCaption) return tabular.join('\n')
    const caption = captionLines(shape, '')
    return (habits.caption === 'top' ? [...caption, ...tabular] : [...tabular, ...caption]).join(
      '\n'
    )
  }

  const starred = shape.wide && habits.twoColumn
  const env = starred ? 'table*' : 'table'
  const width = starred ? '\\textwidth' : '\\linewidth'
  const lines = [`\\begin{${env}}${habits.placement ? `[${habits.placement}]` : ''}`]
  const centerEnvironment = habits.centering === 'center'
  if (!centerEnvironment) lines.push(`${unit}\\centering`)
  if (habits.size) lines.push(`${unit}${habits.size}`)
  const tabular = centerEnvironment
    ? [`${unit}\\begin{center}`, ...tabularLines(shape, unit, 2, width), `${unit}\\end{center}`]
    : tabularLines(shape, unit, 1, width)
  const caption = captionLines(shape, unit)
  lines.push(...(habits.caption === 'top' ? [...caption, ...tabular] : [...tabular, ...caption]))
  lines.push(`\\end{${env}}`)
  return lines.join('\n')
}

/**
 * The passage's new text: `block` on its own lines. A line break goes in
 * only where text shares the anchor's line, so no blank line is ever added,
 * and every line after the first gets the line's indentation. `blockEnd`
 * is where the block ends in `text`: the cursor goes there.
 */
export function spliceBlock(
  block: string,
  around: { lineBefore: string; lineAfter: string; indent: string }
): { text: string; blockEnd: number } {
  const [first, ...rest] = block.split('\n')
  const head = around.lineBefore.trim() ? `\n${around.indent}${first}` : first
  const body = [head, ...rest.map(line => around.indent + line)].join('\n')
  return {
    text: body + (around.lineAfter.trim() ? `\n${around.indent}` : ''),
    blockEnd: body.length,
  }
}
