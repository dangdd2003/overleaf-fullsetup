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
// Lines containing solely a list marker or number with no text
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
  const out: string[] = []
  let fence: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const open = line.match(FENCE_OPEN)
    if (fence) {
      const close = line.trim()
      if (
        close[0] === fence[0] &&
        close.length >= fence.length &&
        /^(`+|~+)$/.test(close)
      ) {
        fence = null
      }
      out.push(line)
      continue
    }
    if (open) {
      fence = open[1]
      out.push(line)
      continue
    }
    // Check if line i is a table header and line i+1 is a delimiter row
    if (
      i > 0 &&
      lines[i - 1].trim() !== '' &&
      line.trim().startsWith('|') &&
      i + 1 < lines.length &&
      /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/.test(lines[i + 1])
    ) {
      out.push('')
    }
    out.push(line)
  }
  return out.join('\n')
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

const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
export const MATH_ENVIRONMENTS =
  '(?:equation|align|alignat|gather|multline|matrix|pmatrix|bmatrix|vmatrix|Vmatrix|cases|aligned|gathered)'
const DISPLAY_MATH_OPEN = new RegExp(
  String.raw`\$\$|\\\[|\\begin\{(${MATH_ENVIRONMENTS}\*?)\}`,
  'g'
)
// Markup marked reads across blank lines, or a definition that other blocks
// may refer to. A reply holding any of these is kept as one block.
const WHOLE_DOCUMENT =
  /<[?!]|<(?:pre|script|style|textarea)\b|^ {0,3}\[[^\]\n]+\]:/im
// A line that carries on the block above it rather than starting a new one
const CONTINUES_BLOCK = /^(?:[ \t>|]|[*+-](?:\s|$)|\d{1,9}[.)](?:\s|$))/
// Raw HTML may run on past a blank line and nest what follows it, so a block
// that opens with markup is never closed early
const OPENS_HTML = /^ {0,3}</

/**
 * Where display math stays open after `line`, given where it was open before,
 * or null when it is closed.
 */
function mathOpenAfter(line: string, open: string | null): string | null {
  let pos = 0
  let closer = open
  for (;;) {
    if (closer !== null) {
      const at = line.indexOf(closer, pos)
      if (at === -1) return closer
      pos = at + closer.length
      closer = null
      continue
    }
    DISPLAY_MATH_OPEN.lastIndex = pos
    const m = DISPLAY_MATH_OPEN.exec(line)
    if (!m) return null
    closer = m[0] === '$$' ? '$$' : m[0] === '\\[' ? '\\]' : `\\end{${m[1]}}`
    pos = m.index + m[0].length
  }
}

/**
 * Cuts a reply into the top-level blocks it can be rendered as, one at a time.
 * A cut is made at a blank line outside fenced code and display math, and only
 * where the next line starts a block of its own: not a list item, quote,
 * indented line or table row, and not a line right after a table row. Those
 * are the places marked reads the same way whether or not the text before
 * them is there. Each block keeps the blank lines after it, so the blocks
 * joined with '\n' give the reply back. The last block is the one still being
 * written; `stable` holds the blocks before it, which will not change as more
 * text arrives.
 */
export function splitMarkdownBlocks(text: string): {
  stable: string[]
  tail: string
} {
  if (WHOLE_DOCUMENT.test(text)) return { stable: [], tail: text }

  const lines = text.split('\n')
  const stable: string[] = []
  let blockStart = 0
  let last = -1 // the last line with content
  let fence: string | null = null
  let math: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const inside = fence !== null || math !== null
    if (!inside && line.trim() === '') continue

    const prev = lines[last]
    if (
      !inside &&
      last !== -1 &&
      last < i - 1 &&
      !prev.includes('|') &&
      !CONTINUES_BLOCK.test(line) &&
      !OPENS_HTML.test(lines[blockStart])
    ) {
      stable.push(lines.slice(blockStart, i).join('\n'))
      blockStart = i
    }
    last = i

    if (fence !== null) {
      const close = FENCE_CLOSE.exec(line)
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
        fence = null
      }
      continue
    }
    if (math === null) {
      const open = line.match(FENCE_OPEN)
      if (open) {
        fence = open[1]
        continue
      }
    }
    math = mathOpenAfter(line, math)
  }

  return { stable, tail: lines.slice(blockStart).join('\n') }
}
