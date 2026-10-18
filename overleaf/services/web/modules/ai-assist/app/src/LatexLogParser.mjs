// Adapter over the shared LaTeX log parser, so the AI-assist compile tools
// read a log exactly as the MCP compile summary does. Keeps the
// LatexLogParser.parse(rawLog, options) API. The one difference is the file
// name: here every entry's file is cleaned of the compile directory and a
// leading "./", so the model sees "chapters/intro.tex" for any kind of entry.

import { parseLatexLog } from '../../../../app/src/Features/PdfInspection/LatexLogParser.mjs'

const DEFAULT_FILE_BASE_NAMES = [/compiles/, /\/usr\/local/]

/**
 * Strip the compile directory and leading "./" from a log file name, and the
 * TeX install prefix from a system file name.
 */
export function normalizeFilePath(
  filePath,
  fileBaseNames = DEFAULT_FILE_BASE_NAMES
) {
  if (!filePath) return filePath
  let cleaned = filePath.trim()
  // Strip leading ./
  cleaned = cleaned.replace(/^\.\//, '')
  // Strip container compile prefixes like /compiles/<id>/ or /tmp/<id>/
  cleaned = cleaned.replace(/^\/compiles\/[^/]+\//, '')
  cleaned = cleaned.replace(/^\/tmp\/[^/]+\//, '')
  for (const regex of fileBaseNames) {
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

export class LatexLogParser {
  constructor(text, options = {}) {
    this.text = text
    this.options = options
  }

  parse() {
    return LatexLogParser.parse(this.text, this.options)
  }

  static parse(text, options = {}) {
    const fileBaseNames = options.fileBaseNames || DEFAULT_FILE_BASE_NAMES
    return parseLatexLog(text, {
      ignoreDuplicates: options.ignoreDuplicates ?? true,
      normalizeFile: file => normalizeFilePath(file, fileBaseNames),
    })
  }
}

export default LatexLogParser
