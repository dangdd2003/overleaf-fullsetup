// ESM LaTeX Log Parser ported from frontend/js/ide/log-parser/latex-log-parser.ts

const LOG_WRAP_LIMIT = 79
const LATEX_WARNING_REGEX = /^LaTeX(?:3| Font)? Warning: (.*)$/
const HBOX_WARNING_REGEX = /^(Over|Under)full \\(v|h)box/
const PACKAGE_WARNING_REGEX = /^((?:Package|Class|Module) \b.+\b Warning:.*)$/
const LINES_REGEX = /lines? ([0-9]+)/
const PACKAGE_REGEX = /^(?:Package|Class|Module) (\b.+\b) Warning/
const FILE_LINE_ERROR_REGEX = /^([./].*):(\d+): (.*)/

const STATE = {
  NORMAL: 0,
  ERROR: 1,
}

class LogText {
  constructor(text) {
    this.text = (text || '').replace(/(\r\n)|\r/g, '\n')
    const wrappedLines = this.text.split('\n')
    this.lines = [wrappedLines[0] || '']

    for (let i = 1; i < wrappedLines.length; i++) {
      const prevLine = wrappedLines[i - 1]
      const currentLine = wrappedLines[i]

      if (
        prevLine.length === LOG_WRAP_LIMIT &&
        prevLine.slice(-3) !== '...' &&
        currentLine.charAt(0) !== '!'
      ) {
        this.lines[this.lines.length - 1] += currentLine
      } else {
        this.lines.push(currentLine)
      }
    }
    this.row = -1
  }

  nextLine() {
    this.row++
    if (this.row >= this.lines.length) {
      return false
    }
    return this.lines[this.row]
  }

  rewindLine() {
    this.row--
  }

  linesUpToNextWhitespaceLine(stopAtError = false) {
    return this.linesUpToNextMatchingLine(/^ *$/, stopAtError)
  }

  linesUpToNextMatchingLine(match, stopAtError = false) {
    const lines = []
    while (true) {
      const nextLine = this.nextLine()
      if (nextLine === false) break
      if (stopAtError && (nextLine.match(/^! /) || FILE_LINE_ERROR_REGEX.test(nextLine))) {
        this.rewindLine()
        break
      }
      lines.push(nextLine)
      if (nextLine.match(match)) break
    }
    return lines
  }
}

export class LatexLogParser {
  constructor(text, options = {}) {
    this.state = STATE.NORMAL
    this.fileBaseNames = options.fileBaseNames || [/compiles/, /\/usr\/local/]
    this.ignoreDuplicates = options.ignoreDuplicates ?? true
    this.data = []
    this.fileStack = []
    this.currentFileList = this.rootFileList = []
    this.openParens = 0
    this.currentLine = ''
    this.log = new LogText(text)
    this.currentFilePath = undefined
    this.currentError = undefined
  }

  parse() {
    let nextLine
    while ((nextLine = this.log.nextLine()) !== false) {
      this.currentLine = nextLine
      if (this.state === STATE.NORMAL) {
        if (this.currentLineIsError()) {
          this.state = STATE.ERROR
          this.currentError = {
            line: null,
            file: this.currentFilePath,
            level: 'error',
            message: this.currentLine.slice(2).trim(),
            content: '',
            raw: this.currentLine + '\n',
          }
        } else if (this.currentLineIsFileLineError()) {
          this.parseFileLineError()
          if (this.currentError) {
            // Collect immediate context lines up to next error or whitespace
            const contextLines = this.log.linesUpToNextWhitespaceLine(true)
            if (contextLines.length > 0) {
              this.currentError.content += contextLines.join('\n') + '\n'
              this.currentError.raw += this.currentError.content
            }
            this.data.push(this.currentError)
            this.currentError = undefined
          }
          this.state = STATE.NORMAL
        } else if (this.currentLineIsRunawayArgument()) {
          this.parseRunawayArgumentError()
        } else if (this.currentLineIsWarning()) {
          this.parseSingleWarningLine(LATEX_WARNING_REGEX)
        } else if (this.currentLineIsHboxWarning()) {
          this.parseHboxLine()
        } else if (this.currentLineIsPackageWarning()) {
          this.parseMultipleWarningLine()
        } else {
          this.parseParensForFilenames()
        }
      }
      if (this.state === STATE.ERROR) {
        if (this.currentError) {
          this.currentError.content += this.log
            .linesUpToNextMatchingLine(/^l\.[0-9]+/)
            .join('\n')
          this.currentError.content += '\n'
          this.currentError.content += this.log
            .linesUpToNextWhitespaceLine(true)
            .join('\n')
          this.currentError.content += '\n'
          this.currentError.content += this.log
            .linesUpToNextWhitespaceLine(true)
            .join('\n')
          this.currentError.raw += this.currentError.content
          const lineNo = this.currentError.raw.match(/l\.([0-9]+)/)
          if (lineNo && this.currentError.line === null) {
            this.currentError.line = parseInt(lineNo[1], 10)
          }
          this.data.push(this.currentError)
        }
        this.state = STATE.NORMAL
      }
    }
    return this.postProcess(this.data)
  }

  currentLineIsError() {
    return (
      this.currentLine[0] === '!' &&
      this.currentLine !==
        '!  ==> Fatal error occurred, no output PDF file produced!'
    )
  }

  currentLineIsFileLineError() {
    return FILE_LINE_ERROR_REGEX.test(this.currentLine)
  }

  currentLineIsRunawayArgument() {
    return this.currentLine.match(/^Runaway argument/)
  }

  currentLineIsWarning() {
    return !!this.currentLine.match(LATEX_WARNING_REGEX)
  }

  currentLineIsPackageWarning() {
    return !!this.currentLine.match(PACKAGE_WARNING_REGEX)
  }

  currentLineIsHboxWarning() {
    return !!this.currentLine.match(HBOX_WARNING_REGEX)
  }

  normalizeFilePath(filePath) {
    if (!filePath) return filePath
    let cleaned = filePath.trim()
    // Strip leading ./
    cleaned = cleaned.replace(/^\.\//, '')
    // Strip container compile prefixes like /compiles/<id>/ or /tmp/<id>/
    cleaned = cleaned.replace(/^\/compiles\/[^/]+\//, '')
    cleaned = cleaned.replace(/^\/tmp\/[^/]+\//, '')
    for (const regex of this.fileBaseNames) {
      if (regex.test(cleaned)) {
        const parts = cleaned.split(regex)
        const remainder = parts[parts.length - 1].replace(/^\/+/, '')
        if (regex.source.includes('compiles') || regex.source.includes('tmp')) {
          cleaned = remainder.replace(/^[^/]+\//, '')
        } else {
          cleaned = remainder
        }
      }
    }
    return cleaned.replace(/^\/+/, '')
  }

  parseFileLineError() {
    const result = this.currentLine.match(FILE_LINE_ERROR_REGEX)
    if (!result) return
    this.currentError = {
      line: parseInt(result[2], 10) || null,
      file: this.normalizeFilePath(result[1]),
      level: 'error',
      message: result[3],
      content: '',
      raw: this.currentLine + '\n',
    }
  }

  parseRunawayArgumentError() {
    this.currentError = {
      line: null,
      file: this.currentFilePath,
      level: 'error',
      message: this.currentLine,
      content: '',
      raw: this.currentLine + '\n',
    }
    this.currentError.content += this.log.linesUpToNextWhitespaceLine().join('\n')
    this.currentError.content += '\n'
    this.currentError.content += this.log.linesUpToNextWhitespaceLine().join('\n')
    this.currentError.raw += this.currentError.content
    const lineNo = this.currentError.raw.match(/l\.([0-9]+)/)
    if (lineNo) {
      this.currentError.line = parseInt(lineNo[1], 10)
    }
    this.data.push(this.currentError)
  }

  parseSingleWarningLine(prefixRegex) {
    const warningMatch = this.currentLine.match(prefixRegex)
    if (!warningMatch) return
    const warning = warningMatch[1]
    const lineMatch = warning.match(LINES_REGEX)
    const line = lineMatch ? parseInt(lineMatch[1], 10) : null
    this.data.push({
      line,
      file: this.currentFilePath,
      level: 'warning',
      message: warning,
      raw: warning,
    })
  }

  parseMultipleWarningLine() {
    let warningMatch = this.currentLine.match(PACKAGE_WARNING_REGEX)
    if (!warningMatch) return
    const warningLines = [warningMatch[1]]
    let lineMatch = this.currentLine.match(LINES_REGEX)
    let line = lineMatch ? parseInt(lineMatch[1], 10) : null
    const packageMatch = this.currentLine.match(PACKAGE_REGEX)
    const packageName = packageMatch ? packageMatch[1] : ''
    const prefixRegex = new RegExp('(?:\\(' + packageName + '\\))*[\\s]*(.*)', 'i')

    let currentLine
    while ((currentLine = this.log.nextLine())) {
      this.currentLine = currentLine
      lineMatch = this.currentLine.match(LINES_REGEX)
      line = lineMatch ? parseInt(lineMatch[1], 10) : line
      warningMatch = this.currentLine.match(prefixRegex)
      if (!warningMatch) break
      warningLines.push(warningMatch[1])
    }
    const rawMessage = warningLines.join(' ')
    this.data.push({
      line,
      file: this.currentFilePath,
      level: 'warning',
      message: rawMessage,
      raw: rawMessage,
    })
  }

  parseHboxLine() {
    const lineMatch = this.currentLine.match(LINES_REGEX)
    const line = lineMatch ? parseInt(lineMatch[1], 10) : null
    this.data.push({
      line,
      file: this.currentFilePath,
      level: 'typesetting',
      message: this.currentLine,
      raw: this.currentLine,
    })
  }

  parseParensForFilenames() {
    const pos = this.currentLine.search(/[()]/)
    if (pos !== -1) {
      const token = this.currentLine[pos]
      this.currentLine = this.currentLine.slice(pos + 1)
      if (token === '(') {
        const filePath = this.consumeFilePath()
        if (filePath) {
          this.currentFilePath = filePath
          const newFile = { path: filePath, files: [] }
          this.fileStack.push(newFile)
          this.currentFileList.push(newFile)
          this.currentFileList = newFile.files
        } else {
          this.openParens++
        }
      } else if (token === ')') {
        if (this.openParens > 0) {
          this.openParens--
        } else {
          if (this.fileStack.length > 1) {
            this.fileStack.pop()
            const previousFile = this.fileStack[this.fileStack.length - 1]
            this.currentFilePath = previousFile.path
            this.currentFileList = previousFile.files
          }
        }
      }
      this.parseParensForFilenames()
    }
  }

  consumeFilePath() {
    if (!this.currentLine.match(/^\/?([^ ()\\]+\/)+/)) return false
    let endOfFilePath = this.currentLine.search(/[ ()\\]/)
    while (endOfFilePath !== -1 && this.currentLine[endOfFilePath] === ' ') {
      const partialPath = this.currentLine.slice(0, endOfFilePath)
      if (/\.\w+$/.test(partialPath)) break
      const remainingPath = this.currentLine.slice(endOfFilePath + 1)
      if (/^\s*["()[\]]/.test(remainingPath)) break
      const nextEndOfPath = remainingPath.search(/[ "()[\]]/)
      if (nextEndOfPath === -1) {
        endOfFilePath = -1
      } else {
        endOfFilePath += nextEndOfPath + 1
      }
    }
    let path
    if (endOfFilePath === -1) {
      path = this.currentLine
      this.currentLine = ''
    } else {
      path = this.currentLine.slice(0, endOfFilePath)
      this.currentLine = this.currentLine.slice(endOfFilePath)
    }
    return path
  }

  postProcess(data) {
    const errors = []
    const warnings = []
    const typesetting = []
    const hashes = new Set()

    data.forEach(item => {
      const hash = `${item.level}:${item.file}:${item.line}:${item.message}`
      if (this.ignoreDuplicates && hashes.has(hash)) return
      hashes.add(hash)

      if (item.level === 'error') errors.push(item)
      else if (item.level === 'warning') warnings.push(item)
      else if (item.level === 'typesetting') typesetting.push(item)
    })

    return { errors, warnings, typesetting }
  }

  static parse(text, options = {}) {
    const parser = new LatexLogParser(text, options)
    return parser.parse()
  }
}

export default LatexLogParser
