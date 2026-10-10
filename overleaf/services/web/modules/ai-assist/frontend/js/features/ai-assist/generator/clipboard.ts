/** Clipboard data as a paste event gives it (`DataTransfer` has more). */
export type ClipboardText = { getData(type: string): string } | null

/** How tabular text is written: spreadsheet cells (tabs), Markdown or CSV. */
export type TabularFormat = 'tsv' | 'markdown' | 'csv'

const MARKDOWN_ROW = /^\s*\|.*\|\s*$/
const MARKDOWN_RULE = /^(?=.*---)[\s|:-]+$/

function nonEmptyLines(text: string): string[] {
  return text.split(/\r?\n/).filter(line => line.trim() !== '')
}

/** Commas outside double quotes. */
function csvCommas(line: string): number {
  let count = 0
  let quoted = false
  for (const char of line) {
    if (char === '"') quoted = !quoted
    else if (char === ',' && !quoted) count++
  }
  return count
}

/** The lines sharing the most common comma count (at least 2), when 3 or more do. */
function csvLines(lines: string[]): string[] {
  const groups = new Map<number, string[]>()
  for (const line of lines) {
    const count = csvCommas(line)
    if (count < 2) continue
    groups.set(count, [...(groups.get(count) ?? []), line])
  }
  let best: string[] = []
  for (const group of groups.values()) {
    if (group.length > best.length) best = group
  }
  return best.length >= 3 ? best : []
}

const tabLines = (lines: string[]) => lines.filter(line => line.includes('\t'))
const markdownLines = (lines: string[]) => lines.filter(line => MARKDOWN_ROW.test(line))

/** The format of the tabular text in `text`, if any. */
export function tabularFormat(text: string): TabularFormat | null {
  const lines = nonEmptyLines(text)
  if (tabLines(lines).length >= 2) return 'tsv'
  if (markdownLines(lines).length >= 2) return 'markdown'
  if (csvLines(lines).length > 0) return 'csv'
  return null
}

export function isTabularText(text: string): boolean {
  return tabularFormat(text) !== null
}

/** The lines of `text` that hold its tabular data. */
function dataLines(text: string): string[] {
  const lines = nonEmptyLines(text)
  switch (tabularFormat(text)) {
    case 'tsv':
      return tabLines(lines)
    case 'markdown':
      return markdownLines(lines)
    case 'csv':
      return csvLines(lines)
    default:
      return []
  }
}

/** Nothing but tabular lines: pasted cells with no instructions around them. */
export function onlyTabular(text: string): boolean {
  const data = dataLines(text)
  return data.length > 0 && data.length === nonEmptyLines(text).length
}

function splitCsv(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        cell += '"'
        i++
      } else {
        quoted = !quoted
      }
    } else if (char === ',' && !quoted) {
      cells.push(cell)
      cell = ''
    } else {
      cell += char
    }
  }
  cells.push(cell)
  return cells
}

/**
 * The non-empty cell values of the tabular lines in `text`. Only those
 * lines count, so instructions around pasted cells are not data.
 */
export function tabularCells(text: string): string[] {
  const format = tabularFormat(text)
  const cells = dataLines(text).flatMap(line => {
    if (format === 'tsv') return line.split('\t')
    if (format === 'markdown') {
      if (MARKDOWN_RULE.test(line)) return []
      return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
    }
    return splitCsv(line)
  })
  return cells.map(cell => cell.trim()).filter(Boolean)
}

/**
 * Cells copied from a spreadsheet or an HTML table, as text: the
 * clipboard's `text/plain` when it is tabular. Excel also puts an image of
 * the cells on the clipboard; the text is exact, the image is not. Null
 * otherwise.
 */
export function spreadsheetText(clipboard: ClipboardText): string | null {
  if (!clipboard) return null
  const text = clipboard.getData('text/plain') ?? ''
  if (!text.trim()) return null
  if (/<table[\s>]/i.test(clipboard.getData('text/html') ?? '')) return text
  return isTabularText(text) ? text : null
}
