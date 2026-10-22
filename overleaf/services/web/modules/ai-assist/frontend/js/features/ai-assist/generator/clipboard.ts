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
    const group = groups.get(count)
    if (group) group.push(line)
    else groups.set(count, [line])
  }
  let best: string[] = []
  for (const group of groups.values()) {
    if (group.length > best.length) best = group
  }
  return best.length >= 3 ? best : []
}

const tabLines = (lines: string[]) => lines.filter(line => line.includes('\t'))
const markdownLines = (lines: string[]) => lines.filter(line => MARKDOWN_ROW.test(line))

type TabularAnalysis = {
  format: TabularFormat | null
  lines: string[]
  dataLines: string[]
}

function analyzeTabular(text: string): TabularAnalysis {
  const lines = nonEmptyLines(text)
  const tabs = tabLines(lines)
  if (tabs.length >= 2) {
    return { format: 'tsv', lines, dataLines: tabs }
  }
  const markdown = markdownLines(lines)
  if (markdown.length >= 2) {
    return { format: 'markdown', lines, dataLines: markdown }
  }
  const csv = csvLines(lines)
  if (csv.length > 0) {
    return { format: 'csv', lines, dataLines: csv }
  }
  return { format: null, lines, dataLines: [] }
}

/** The format of the tabular text in `text`, if any. */
export function tabularFormat(text: string): TabularFormat | null {
  return analyzeTabular(text).format
}

export function isTabularText(text: string): boolean {
  return tabularFormat(text) !== null
}

/** Nothing but tabular lines: pasted cells with no instructions around them. */
export function onlyTabular(text: string): boolean {
  const { dataLines, lines } = analyzeTabular(text)
  return dataLines.length > 0 && dataLines.length === lines.length
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
  const { format, dataLines } = analyzeTabular(text)
  if (!format) return []
  const cells = dataLines.flatMap(line => {
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
