// Parser for the LaTeX log (output.log) written by a compile.
//
// The one parser behind the MCP compile summary, the MCP PDF page inspector
// and the AI-assist compile tools, so every surface reads a log the same way.
// Ported from services/web/frontend/js/ide/log-parser/latex-log-parser.ts so
// the model sees the same classification the editor shows. Deliberate
// differences: the line cursor starts before the first line (the frontend
// skips it), an error's context stops at the next entry instead of running
// on, a package warning block stops at the next entry, the fatal "no output
// PDF" line is reported as a flag instead of being dropped (in plain and
// -file-line-error mode), a font warning keeps its "(Font)" continuation, and
// the bracket scan is a loop so a long line cannot exhaust the stack.
//
// Dependency-free on purpose: it is unit-tested with plain node.

const LOG_WRAP_LIMIT = 79
const FATAL_REGEX = /==> Fatal error occurred, no output PDF file produced!\s*$/
// Spaces a file name may contain before the path is cut there.
const MAX_PATH_SPACES = 16

const LATEX_WARNING_REGEX = /^LaTeX(?:3| Font)? Warning: (.*)$/
const FONT_WARNING_REGEX = /^LaTeX Font Warning: /
const FONT_CONTINUATION_REGEX = /^\(Font\)\s+(.*)$/
const HBOX_WARNING_REGEX = /^(Over|Under)full \\(v|h)box/
const PACKAGE_WARNING_REGEX = /^((?:Package|Class|Module) \b.+\b Warning:.*)$/
const PACKAGE_REGEX = /^(?:Package|Class|Module) (\b.+\b) Warning/
const RUNAWAY_REGEX = /^Runaway argument/
const FILE_LINE_ERROR_REGEX = /^([./].*):(\d+): (.*)/
const EMERGENCY_STOP_MESSAGE = 'Emergency stop.'
const SOURCE_LINE_REGEX = /^l\.([0-9]+)/
const LINES_REGEX = /lines? ([0-9]+)/
// TeX prints "[N" when it ships out page N, e.g. "[3]" or "[4 <./fig.png>]".
const SHIPOUT_REGEX = /\[(\d+)(?=[\s\]{<]|$)/g

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A line that starts a log entry: an error, a warning, a file:line error or a
 * runaway argument. It never continues the line before it.
 */
function startsEntry(line) {
  return (
    line.startsWith('!') ||
    FILE_LINE_ERROR_REGEX.test(line) ||
    LATEX_WARNING_REGEX.test(line) ||
    PACKAGE_WARNING_REGEX.test(line) ||
    RUNAWAY_REGEX.test(line)
  )
}

/**
 * A line is the start of another log entry, so it ends the context of the
 * entry being read. The fatal "no output PDF" line is one, in both modes.
 */
function startsNewEntry(line) {
  return startsEntry(line) || FATAL_REGEX.test(line)
}

/**
 * TeX wraps a line at 79 characters. The log is UTF-8, and TeX counts bytes,
 * so a line is wrapped at 79 characters or 79 bytes.
 */
function isWrapLength(line) {
  return (
    line.length === LOG_WRAP_LIMIT ||
    Buffer.byteLength(line, 'utf8') === LOG_WRAP_LIMIT
  )
}

/**
 * LaTeX wraps log lines at 79 characters. Re-join wrapped lines so that a
 * message split across lines is read as one line.
 */
class LogText {
  constructor(text) {
    const rawLines = String(text ?? '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
    this.lines = [rawLines[0] ?? '']
    for (let i = 1; i < rawLines.length; i++) {
      const prev = rawLines[i - 1]
      const current = rawLines[i]
      // Lines ending in "..." were cut by LaTeX on purpose and are not joined.
      // A blank line or the start of an entry is never a continuation, even
      // when the line before it is exactly full: a fatal line can follow one.
      if (
        isWrapLength(prev) &&
        !prev.endsWith('...') &&
        current !== '' &&
        !startsEntry(current)
      ) {
        this.lines[this.lines.length - 1] += current
      } else {
        this.lines.push(current)
      }
    }
    this.index = 0
  }

  next() {
    if (this.index >= this.lines.length) return null
    return this.lines[this.index++]
  }

  peek() {
    return this.index < this.lines.length ? this.lines[this.index] : null
  }
}

/**
 * Consume a file name that follows "(" in the log. Returns the path (or null
 * when the text does not start with one) and the text left after it.
 */
function consumeFilePath(text) {
  // A path has at least one "/" before any "(", ")" or "\".
  if (!/^\/?([^ ()\\]+\/)+/.test(text)) return { path: null, rest: text }

  let end = text.search(/[ ()\\]/)
  // A file name may contain spaces. Keep going through a space unless the
  // text so far already ends in an extension, or the next token closes a
  // bracket. Each pass re-scans the text so far, so the passes are capped: a
  // long line of spaces after "(/dir/" must not cost quadratic time.
  let passes = 0
  while (end !== -1 && text[end] === ' ' && passes++ < MAX_PATH_SPACES) {
    if (/\.\w+$/.test(text.slice(0, end))) break
    const remaining = text.slice(end + 1)
    if (/^\s*["()[\]]/.test(remaining)) break
    const nextEnd = remaining.search(/[ "()[\]]/)
    end = nextEnd === -1 ? -1 : end + nextEnd + 1
  }
  if (end === -1) return { path: text, rest: '' }
  return { path: text.slice(0, end), rest: text.slice(end) }
}

class LatexLogParser {
  constructor(text) {
    this.log = new LogText(text)
    this.data = []
    this.fatal = false
    // Files the log has opened, innermost last. The root file stays at the
    // bottom and is never popped.
    this.fileStack = []
    this.openParens = 0
    // Pages shipped out so far. An entry is logged while the next page is
    // being built, which is where a bad box usually ends up.
    this.shippedPages = 0
  }

  get currentPage() {
    return this.shippedPages + 1
  }

  get currentFilePath() {
    return this.fileStack[this.fileStack.length - 1]
  }

  /** @returns {{ entries: object[], fatal: boolean }} */
  parse() {
    let line
    while ((line = this.log.next()) !== null) {
      if (FATAL_REGEX.test(line)) {
        this.fatal = true
      } else if (line.startsWith('!')) {
        this.parseError(line)
      } else if (FILE_LINE_ERROR_REGEX.test(line)) {
        this.parseFileLineError(line)
      } else if (RUNAWAY_REGEX.test(line)) {
        this.parseRunawayArgument(line)
      } else if (LATEX_WARNING_REGEX.test(line)) {
        this.parseSingleWarning(line)
      } else if (HBOX_WARNING_REGEX.test(line)) {
        this.parseHboxLine(line)
      } else if (PACKAGE_WARNING_REGEX.test(line)) {
        this.parseMultipleWarning(line)
      } else {
        this.trackFiles(line)
      }
    }
    this.inheritEmergencyLines()
    return { entries: this.data, fatal: this.fatal }
  }

  parseError(line) {
    this.pushError(line, line.slice(2).trim(), null, this.currentFilePath)
  }

  parseFileLineError(line) {
    const match = line.match(FILE_LINE_ERROR_REGEX)
    this.pushError(line, match[3], parseInt(match[2], 10) || null, match[1])
  }

  parseRunawayArgument(line) {
    this.pushError(line, line, null, this.currentFilePath)
  }

  pushError(headline, message, line, file) {
    const context = this.collectErrorContext()
    if (line == null) {
      const found = context.join('\n').match(/(?:^|\n)l\.([0-9]+)/)
      line = found ? parseInt(found[1], 10) : null
    }
    this.data.push({
      level: 'error',
      file,
      line,
      message,
      context,
      // The headline and its context, the text an excerpt is cut from.
      raw: [headline, ...context].join('\n'),
    })
  }

  /**
   * An error that stops at "Emergency stop." (TeX gives up on the file it was
   * reading) was caused by the same source line that the stop reports, so it
   * takes that line. The stop itself stays as an entry.
   */
  inheritEmergencyLines() {
    for (let i = 0; i < this.data.length - 1; i++) {
      const entry = this.data[i]
      const next = this.data[i + 1]
      if (
        entry.level === 'error' &&
        entry.line == null &&
        next.level === 'error' &&
        next.message === EMERGENCY_STOP_MESSAGE &&
        next.line != null &&
        (entry.file == null || next.file === entry.file)
      ) {
        entry.line = next.line
      }
    }
  }

  /**
   * Read the source excerpt that follows an error: everything up to and
   * including the "l.NN" line, then the rest of the excerpt up to a blank
   * line. Blank lines before the "l.NN" line are skipped, because some
   * errors print their help text first.
   */
  collectErrorContext() {
    const lines = []
    let next = this.log.peek()
    let foundSourceLine = false
    while (
      next !== null &&
      !startsNewEntry(next)
    ) {
      this.log.next()
      if (next.trim() !== '') {
        lines.push(next)
      }
      if (SOURCE_LINE_REGEX.test(next)) {
        foundSourceLine = true
        break
      }
      next = this.log.peek()
    }
    if (foundSourceLine) {
      next = this.log.peek()
      while (
        next !== null &&
        !startsNewEntry(next)
      ) {
        this.log.next()
        if (next.trim() === '') break
        lines.push(next)
        next = this.log.peek()
      }
    }
    return lines
  }

  parseSingleWarning(line) {
    const parts = [line.match(LATEX_WARNING_REGEX)[1]]
    // A font warning goes on to a "(Font)" line that holds the rest of the
    // message and often the line number: "(Font) using ... on input line 6."
    if (FONT_WARNING_REGEX.test(line)) {
      let next
      while (
        (next = this.log.peek()) !== null &&
        FONT_CONTINUATION_REGEX.test(next)
      ) {
        this.log.next()
        parts.push(next.match(FONT_CONTINUATION_REGEX)[1].trim())
      }
    }
    const message = parts.join(' ')
    this.data.push({
      level: 'warning',
      file: this.currentFilePath,
      line: lineNumberIn(message),
      message,
    })
  }

  /**
   * Package warnings can run over several lines, and the lines after the
   * first repeat the package name in brackets. Join them into one message.
   */
  parseMultipleWarning(line) {
    const parts = [line.match(PACKAGE_WARNING_REGEX)[1]]
    let lineNo = lineNumberIn(line)
    const packageMatch = line.match(PACKAGE_REGEX)
    const packageName = packageMatch ? escapeRegex(packageMatch[1]) : ''
    const prefix = new RegExp(`(?:\\(${packageName}\\))*\\s*(.*)`, 'i')

    let next
    while (
      (next = this.log.peek()) !== null &&
      next.trim() !== '' &&
      !startsNewEntry(next)
    ) {
      this.log.next()
      lineNo = lineNumberIn(next) ?? lineNo
      const body = next.match(prefix)
      parts.push(body ? body[1] : next)
    }
    if (next !== null && next.trim() === '') {
      this.log.next()
    }

    const message = parts
      .map(part => part.trim())
      .filter(Boolean)
      .join(' ')
    this.data.push({
      level: 'warning',
      file: this.currentFilePath,
      line: lineNo,
      message,
    })
  }

  parseHboxLine(line) {
    this.data.push({
      level: 'typesetting',
      file: this.currentFilePath,
      line: lineNumberIn(line),
      page: this.currentPage,
      message: line,
    })
  }

  /**
   * Count the pages shipped out on this line. Only the next page number in
   * sequence counts, so a "[2" inside some other text cannot skip ahead.
   */
  trackPages(line) {
    for (const match of line.matchAll(SHIPOUT_REGEX)) {
      if (parseInt(match[1], 10) === this.shippedPages + 1) {
        this.shippedPages++
      }
    }
  }

  /**
   * Track which file the log is currently inside, from the "(" and ")" that
   * LaTeX prints around each file it opens.
   */
  trackFiles(line) {
    this.trackPages(line)
    let rest = line
    for (;;) {
      const pos = rest.search(/[()]/)
      if (pos === -1) return
      const token = rest[pos]
      rest = rest.slice(pos + 1)
      if (token === '(') {
        const { path, rest: after } = consumeFilePath(rest)
        rest = after
        if (path) {
          this.fileStack.push(path)
        } else {
          this.openParens++
        }
      } else if (this.openParens > 0) {
        this.openParens--
      } else if (this.fileStack.length > 1) {
        this.fileStack.pop()
      }
    }
  }
}

function lineNumberIn(text) {
  const match = text.match(LINES_REGEX)
  return match ? parseInt(match[1], 10) : null
}

/**
 * Parse a LaTeX log.
 *
 * @param {string} text the contents of output.log
 * @param {object} [options]
 * @param {boolean} [options.ignoreDuplicates=true] drop an entry that repeats
 *   an earlier one. LaTeX repeats a bad box on every page it lands on, so a
 *   typesetting entry is a repeat only on the same page.
 * @param {(file: string|undefined) => string|undefined} [options.normalizeFile]
 *   rewrites each entry's file before the entries are returned
 * @returns {{
 *   errors: Array<{level: 'error', file: string|undefined, line: number|null, message: string, context: string[], raw: string}>,
 *   warnings: Array<{level: 'warning', file: string|undefined, line: number|null, message: string}>,
 *   typesetting: Array<{level: 'typesetting', file: string|undefined, line: number|null, page: number, message: string}>,
 *   fatal: boolean
 * }}
 */
export function parseLatexLog(text, options = {}) {
  const { ignoreDuplicates = true, normalizeFile } = options
  const { entries, fatal } = new LatexLogParser(text).parse()
  const errors = []
  const warnings = []
  const typesetting = []
  const seen = new Set()
  for (const entry of entries) {
    const file = normalizeFile ? normalizeFile(entry.file) : entry.file
    const item = file === entry.file ? entry : { ...entry, file }
    if (ignoreDuplicates) {
      const key = JSON.stringify([
        item.level,
        item.file,
        item.line,
        item.message,
        item.page ?? null,
      ])
      if (seen.has(key)) continue
      seen.add(key)
    }
    if (item.level === 'error') errors.push(item)
    else if (item.level === 'warning') warnings.push(item)
    else typesetting.push(item)
  }
  return { errors, warnings, typesetting, fatal }
}

export function normalizeLogPath(raw, baseDir = '') {
  if (!raw) return null
  let path = String(raw).trim().replace(/\/\/+/g, '/')
  path = path.replace(/^.*\/compiles\/[0-9a-f]{24}(-[0-9a-f]{24})?\//, '')
  path = path.replace(/^\/compile\//, '')
  path = path.replace(/^\.\//, '')
  if (path === '' || path.startsWith('/')) return null
  return baseDir ? `${baseDir}/${path}` : path
}

export function rootDirectory(rootDocPath) {
  if (!rootDocPath) return ''
  const path = String(rootDocPath).replace(/^\//, '')
  const slash = path.lastIndexOf('/')
  return slash > 0 ? path.slice(0, slash) : ''
}

export default parseLatexLog
