/**
 * Markdown as models write it is not always Markdown as CommonMark reads it.
 * These passes run on the reply before it is parsed. Fenced code is never
 * touched: what is inside a fence is shown exactly as written.
 */

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/

/** Calls `fn` on every line outside fenced code. */
function mapProseLines(lines: string[], fn: (line: string) => string) {
  let fence: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(FENCE_OPEN)
    if (fence) {
      const close = lines[i].trim()
      if (
        close[0] === fence[0] &&
        close.length >= fence.length &&
        /^(`+|~+)$/.test(close)
      ) {
        fence = null
      }
      continue
    }
    if (open) {
      fence = open[1]
      continue
    }
    lines[i] = fn(lines[i])
  }
}

// Space characters a model may put after a marker, or in indentation:
// NBSP, en/em/thin/hair space, zero-width space, narrow NBSP, medium math space, ideographic space
const ODD_SPACE = '\\u00a0\\u2000-\\u200b\\u202f\\u205f\\u3000'
// Any run of blockquote markers and indentation in front of a marker (supporting both ASCII and Unicode spaces)
const LEAD = String.raw`(?:(?:[ \t${ODD_SPACE}]*>)*[ \t${ODD_SPACE}]*)`

const MARKER_THEN_ODD_SPACE = new RegExp(
  `^(${LEAD})([*+-]|\\d{1,9}[.)]|#{1,6})[${ODD_SPACE}]+`
)
const UNICODE_BULLET = new RegExp(
  `^(${LEAD})[•◦▪▫‣⁃∙●○■□–—][ \\t${ODD_SPACE}]+`
)
const CJK_ORDERED = new RegExp(
  `^(${LEAD})([0-9\\uff10-\\uff19]{1,9})[\\uFF0E\\uFF09][ \\t${ODD_SPACE}]*`
)
const TASK_LIST = new RegExp(
  `^(${LEAD}(?:[*+-]|\\d{1,9}[.)])[ \\t${ODD_SPACE}]+)\\[([ xXvV✓]?)\\][ \\t${ODD_SPACE}]*`
)
// Lines containing solely a list marker, number, or heading hash with no text
const EMPTY_MARKER_LINE = new RegExp(
  `^${LEAD}(?:[*+-]|\\d{1,9}[.)])[ \\t${ODD_SPACE}]*$`
)

function normalizeDigits(str: string): string {
  return str.replace(/[０-９]/g, ch =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
  )
}

/**
 * Escapes unescaped pipe characters inside inline math expressions ($...$)
 * on lines that appear to be table rows, preventing marked from breaking columns.
 */
function escapeMathPipesInTable(line: string): string {
  if (!line.includes('|') || !line.includes('$')) return line
  return line.replace(/\$([^$\n]+)\$/g, (_match, math) => {
    return `$${math.replace(/\\\|/g, '__ESCAPED_PIPE__').replace(/\|/g, '\\mid ').replace(/__ESCAPED_PIPE__/g, '\\|')}$`
  })
}

/** Lists, headings and quotes written with look-alike characters or trailing empty bullets. */
export function normalizeMarkdown(text: string): string {
  const lines = text.split('\n')
  mapProseLines(lines, line => {
    let l = line.replace(/^\t+/, tabs => '  '.repeat(tabs.length))
    // If line has only an empty marker (e.g. trailing "*", "* ", "- "), strip it
    if (EMPTY_MARKER_LINE.test(l)) {
      return ''
    }
    l = l
      .replace(MARKER_THEN_ODD_SPACE, '$1$2 ')
      .replace(UNICODE_BULLET, '$1- ')
      .replace(CJK_ORDERED, (_m, lead, digits) => `${lead}${normalizeDigits(digits)}. `)
      .replace(TASK_LIST, (_m, prefix, check) => {
        const isChecked = check && /[xXvV✓]/.test(check)
        return `${prefix}[${isChecked ? 'x' : ' '}] `
      })
    l = escapeMathPipesInTable(l)
    return l
  })
  return lines.join('\n')
}

/**
 * Ensures table header rows preceded directly by prose have a leading blank line,
 * which CommonMark / GFM requires to trigger table tokenization.
 */
export function ensureTableSeparation(text: string): string {
  const lines = text.split('\n')
  let fence: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(FENCE_OPEN)
    if (fence) {
      const close = lines[i].trim()
      if (
        close[0] === fence[0] &&
        close.length >= fence.length &&
        /^(`+|~+)$/.test(close)
      ) {
        fence = null
      }
      continue
    }
    if (open) {
      fence = open[1]
      continue
    }
    // Check if line i is a table header and line i+1 is a delimiter row
    if (
      i > 0 &&
      lines[i - 1].trim() !== '' &&
      lines[i].trim().startsWith('|') &&
      i + 1 < lines.length &&
      /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/.test(lines[i + 1])
    ) {
      lines.splice(i, 0, '')
      i++
    }
  }
  return lines.join('\n')
}

const FOOTNOTE_DEFINITION = /^\[\^([^\]\s]+)\]:[ \t]*(.*)$/

/** Footnote definitions, `[^id]: note`, taken out of the text to list under it. */
export function extractFootnotes(text: string): {
  text: string
  notes: Map<string, string>
} {
  const notes = new Map<string, string>()
  const lines = text.split('\n')
  mapProseLines(lines, line => {
    const m = line.match(FOOTNOTE_DEFINITION)
    if (!m) return line
    notes.set(m[1], m[2])
    return ''
  })
  return { text: notes.size ? lines.join('\n') : text, notes }
}
