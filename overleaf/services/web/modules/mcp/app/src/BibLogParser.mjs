// Parser for the bibliography log (output.blg) written by BibTeX or Biber.
//
// Ported from services/web/frontend/js/ide/log-parser/bib-log-parser.ts. The
// BibTeX messages are matched by regular expressions, and each match is
// removed from the text before the next pattern runs, so one message cannot
// be reported twice. A few BibTeX messages the editor does not classify
// ("I couldn't open database file") are added here, because a missing .bib
// file is one of the most common reasons a citation fails.

const BIBER_FIRST_LINE = /^.*INFO - This is Biber.*$/
const BIBTEX_FIRST_LINE = /^This is BibTeX, Version.+$/
const BIBER_LINE_REGEX = /^\[(\d+)].*>\s(INFO|WARN|ERROR)\s-\s(.*)$/
const BIBER_SUBSYSTEM_REGEX =
  /^BibTeX subsystem: \/.+\/(\w+\.\w+)_.+, line (\d+), (.+)$/

// The patterns are global so consume() can scan from a position with lastIndex.
const BIBTEX_WARNING_PATTERNS = [
  [
    /^Warning--(.+)\n--line (\d+) of file (.+)$/gm,
    match => ({ file: match[3], line: match[2], message: match[1] }),
  ],
  [/^Warning--(.+)$/gm, match => ({ file: '', line: '', message: match[1] })],
]

const BIBTEX_ERROR_PATTERNS = [
  [
    /^(.*)---line (\d+) of file (.*)\n([^]+?)\nI'm skipping whatever remains of this entry$/gm,
    match => ({
      file: match[3],
      line: match[2],
      message: `${match[1]}\n${match[4]}`,
    }),
  ],
  [
    /^(A bad cross reference---entry ".+?"\nrefers to entry.+?, which doesn't exist)$/gm,
    match => ({ file: '', line: '', message: match[1] }),
  ],
  [
    /^(.*)\n?---line (\d+) of file (.*)\n([^]+?)\nI'm skipping whatever remains of this command$/gm,
    match => ({
      file: match[3],
      line: match[2],
      message: `${match[1]}\n${match[4]}`,
    }),
  ],
  [
    /^(.*?)\nwhile executing---line (\d+) of file (.*)/gm,
    match => ({ file: match[3], line: match[2], message: match[1] }),
  ],
  [
    /^(I couldn't open database file .+)$/gm,
    match => ({ file: '', line: '', message: match[1] }),
  ],
]

/**
 * Drop the [start, end) ranges from text. The ranges are sorted and disjoint.
 */
function removeRanges(text, ranges) {
  if (ranges.length === 0) return text
  const parts = []
  let last = 0
  for (const [start, end] of ranges) {
    parts.push(text.slice(last, start))
    last = end
  }
  parts.push(text.slice(last))
  return parts.join('')
}

/**
 * Run each [regex, toEntry] pair over the text in turn, removing every match
 * before the next pattern. Returns the entries in the order they were found.
 *
 * Within one pattern the scan resumes after each match instead of restarting
 * at the top, and the removals are applied once when the pattern is done, so
 * the cost is linear in the size of the log. A match is removed with the
 * newline after it, so the next match starts at the start of a line in the
 * text that remains.
 */
function consume(text, patterns, level) {
  const entries = []
  let remaining = text
  for (const [regex, toEntry] of patterns) {
    const removed = []
    let from = 0
    for (;;) {
      regex.lastIndex = from
      const match = regex.exec(remaining)
      if (!match) break
      const fields = toEntry(match)
      entries.push({
        level,
        file: fields.file || null,
        line: fields.line ? parseInt(fields.line, 10) : null,
        message: fields.message.trim(),
      })
      const start = match.index
      const end = Math.min(start + match[0].length + 1, remaining.length)
      removed.push([start, end])
      from = end
    }
    remaining = removeRanges(remaining, removed)
  }
  return { entries, remaining }
}

function parseBibtex(text) {
  const warnings = consume(text, BIBTEX_WARNING_PATTERNS, 'warning')
  const errors = consume(warnings.remaining, BIBTEX_ERROR_PATTERNS, 'error')
  return { errors: errors.entries, warnings: warnings.entries }
}

function parseBiber(lines) {
  const errors = []
  const warnings = []
  for (const line of lines) {
    const match = line.match(BIBER_LINE_REGEX)
    if (!match) continue
    const [, , kind, text] = match
    if (kind !== 'WARN' && kind !== 'ERROR') continue
    // Biber reports its file and line inside the message for syntax errors,
    // e.g. "BibTeX subsystem: /.../refs.bib_123.utf8, line 8, syntax error".
    const subsystem = text.match(BIBER_SUBSYSTEM_REGEX)
    const entry = subsystem
      ? {
          level: kind === 'ERROR' ? 'error' : 'warning',
          file: subsystem[1],
          line: parseInt(subsystem[2], 10),
          message: subsystem[3],
        }
      : {
          level: kind === 'ERROR' ? 'error' : 'warning',
          file: null,
          line: null,
          message: text,
        }
    if (kind === 'ERROR') errors.push(entry)
    else warnings.push(entry)
  }
  return { errors, warnings }
}

/**
 * Parse a BibTeX or Biber log.
 *
 * @param {string} text the contents of output.blg
 * @returns {{dialect: 'bibtex'|'biber', errors: object[], warnings: object[]}|null}
 *   null when the text is not a BibTeX or Biber log
 */
export function parseBibLog(text) {
  const normalised = String(text ?? '').replace(/\r\n?/g, '\n')
  const lines = normalised.split('\n')
  const first = lines.find(line => line.trim() !== '') ?? ''
  if (BIBER_FIRST_LINE.test(first)) {
    return { dialect: 'biber', ...parseBiber(lines) }
  }
  if (BIBTEX_FIRST_LINE.test(first)) {
    return { dialect: 'bibtex', ...parseBibtex(normalised) }
  }
  return null
}

export default parseBibLog
