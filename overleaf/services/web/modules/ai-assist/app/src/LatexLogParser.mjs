// Adapter over the shared LaTeX log parser, so the AI-assist compile tools
// read a log exactly as the MCP compile summary does. Keeps the
// LatexLogParser.parse(rawLog, options) API. The one difference is the file
// name: here every entry's file is cleaned of the compile directory and a
// leading "./", so the model sees "chapters/intro.tex" for any kind of entry.

import { parseLatexLog } from '../../../../app/src/Features/PdfInspection/LatexLogParser.mjs'

// Anchored entries strip a prefix; unanchored ones cut the name at the match
const DEFAULT_FILE_BASE_NAMES = [/^compiles\/[^/]+\//, /\/usr\/local/]

/**
 * Strip the compile directory and leading "./" from a log file name, and the
 * TeX install prefix from a system file name.
 */
function normalizeFilePath(
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
    if (regex.source.startsWith('^')) {
      cleaned = cleaned.replace(regex, '')
    } else if (regex.test(cleaned)) {
      const parts = cleaned.split(regex)
      cleaned = parts[parts.length - 1].replace(/^\/+/, '')
    }
  }
  return cleaned.replace(/^\/+/, '')
}

export class LatexLogParser {
  static parse(text, options = {}) {
    const fileBaseNames = options.fileBaseNames || DEFAULT_FILE_BASE_NAMES
    return parseLatexLog(text, {
      ignoreDuplicates: options.ignoreDuplicates ?? true,
      normalizeFile: file => normalizeFilePath(file, fileBaseNames),
    })
  }
}
