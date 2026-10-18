// Turns the raw LaTeX and bibliography logs of one build into the structured
// diagnostics the MCP compile tools return.
//
// Pure functions only: the caller reads the log files and passes the text in,
// so this module is tested without CLSI.

import { parseLatexLog } from '../../../../app/src/Features/PdfInspection/LatexLogParser.mjs'
import { parseBibLog } from './BibLogParser.mjs'


const RERUN_REGEX = /may have changed|\brerun\b/i
const UNDEFINED_SUMMARY_REGEX = /^There were undefined (references|citations)/i
const UNDEFINED_REFERENCE_REGEX = /\bReference `.+' .*undefined/
const UNDEFINED_CITATION_REGEX = /\bCitation `.+' .*undefined/
const MISSING_BIB_ENTRY_REGEX =
  /didn't find a database entry|could not be found/i

/**
 * Turn a path printed in a log into a project-relative path.
 *
 * Log paths are relative to the directory the build ran in, which is the
 * directory of the root document. Paths under the compile directory are
 * stripped to the project path. Absolute paths are TeX system files, not
 * project files, so they return null.
 *
 * @param {string|null|undefined} raw
 * @param {string} [baseDir] directory of the root document, '' for the top
 * @returns {string|null}
 */
export function normalizeLogPath(raw, baseDir = '') {
  if (!raw) return null
  let path = String(raw).trim().replace(/\/\/+/g, '/')
  path = path.replace(/^.*\/compiles\/[0-9a-f]{24}(-[0-9a-f]{24})?\//, '')
  path = path.replace(/^\/compile\//, '')
  path = path.replace(/^\.\//, '')
  if (path === '' || path.startsWith('/')) return null
  return baseDir ? `${baseDir}/${path}` : path
}

/**
 * The directory the root document lives in, '' when it is at the top level.
 *
 * @param {string|null|undefined} rootDocPath
 */
export function rootDirectory(rootDocPath) {
  if (!rootDocPath) return ''
  const path = String(rootDocPath).replace(/^\//, '')
  const slash = path.lastIndexOf('/')
  return slash > 0 ? path.slice(0, slash) : ''
}

/**
 * The source lines around an error. Trailing spaces and blank lines are
 * dropped.
 */
function excerpt(lines) {
  const kept = (lines ?? []).map(line => line.trimEnd()).filter(line => line !== '')
  return kept.join('\n').trim() || undefined
}

function classifyWarning(message) {
  if (RERUN_REGEX.test(message)) return 'rerun'
  if (UNDEFINED_REFERENCE_REGEX.test(message)) return 'undefined-reference'
  if (UNDEFINED_CITATION_REGEX.test(message)) return 'undefined-citation'
  if (/^(Package|Class|Module) /.test(message)) return 'package'
  if (/Font/.test(message)) return 'font'
  return 'other'
}

/**
 * Summarise the logs of one build.
 *
 * @param {object} input
 * @param {string|null} input.latexLog contents of output.log, null when missing
 * @param {string[]} [input.bibLogs] contents of each output.blg, if present
 * @param {string|null} [input.rootDocPath] project path of the root document
 * @returns {{
 *   fatal: boolean,
 *   rerunNeeded: boolean,
 *   counts: {errors: number, warnings: number, badBoxes: number, undefinedReferences: number, undefinedCitations: number},
 *   errors: object[],
 *   warnings: object[],
 *   badBoxes: object[],
 *   advice: string[]
 * }}
 */
export function summarizeCompileLogs({
  latexLog = null,
  bibLogs = [],
  rootDocPath = null,
}) {
  const baseDir = rootDirectory(rootDocPath)
  const errors = []
  const warnings = []
  const badBoxes = []
  const counts = {
    errors: 0,
    warnings: 0,
    badBoxes: 0,
    undefinedReferences: 0,
    undefinedCitations: 0,
  }
  let fatal = false
  let rerunNeeded = false

  function addError(source, entry) {
    counts.errors++
    errors.push({
      source,
      file: normalizeLogPath(entry.file, baseDir),
      line: entry.line ?? null,
      message: entry.message,
      context: excerpt(entry.context),
    })
  }

  function addWarning(source, entry) {
    if (UNDEFINED_SUMMARY_REGEX.test(entry.message)) {
      // The summary repeats the individual warnings, so it is not listed.
      return
    }
    const kind =
      source === 'latex'
        ? classifyWarning(entry.message)
        : MISSING_BIB_ENTRY_REGEX.test(entry.message)
          ? 'missing-entry'
          : 'bibliography'
    if (kind === 'rerun') rerunNeeded = true
    if (kind === 'undefined-reference') counts.undefinedReferences++
    if (kind === 'undefined-citation') counts.undefinedCitations++
    counts.warnings++
    warnings.push({
      source,
      kind,
      file: normalizeLogPath(entry.file, baseDir),
      line: entry.line ?? null,
      message: entry.message,
    })
  }

  if (latexLog != null) {
    const parsed = parseLatexLog(latexLog)
    fatal = parsed.fatal
    for (const entry of parsed.errors) addError('latex', entry)
    for (const entry of parsed.warnings) addWarning('latex', entry)
    // LaTeX repeats a box that lands on several pages, so the parser keeps
    // one entry per page. The model acts on the source line, so count each
    // box once and say on how many pages it recurs.
    const boxes = new Map()
    for (const entry of parsed.typesetting) {
      const file = normalizeLogPath(entry.file, baseDir)
      const line = entry.line ?? null
      const message = entry.message
      const key = JSON.stringify([file, line, message])
      const existing = boxes.get(key)
      if (existing) {
        existing.occurrences++
      } else {
        boxes.set(key, { file, line, message, occurrences: 1 })
      }
    }
    counts.badBoxes = boxes.size
    badBoxes.push(...boxes.values())
  }

  for (const text of bibLogs) {
    const parsed = parseBibLog(text)
    if (!parsed) continue
    for (const entry of parsed.errors) addError(parsed.dialect, entry)
    for (const entry of parsed.warnings) addWarning(parsed.dialect, entry)
  }

  const advice = []
  if (fatal) {
    advice.push(
      'LaTeX stopped on a fatal error and produced no PDF. Fix the first entry in errors; later ones are often caused by it.'
    )
  } else if (counts.errors > 0) {
    advice.push(
      'Fix the errors from the top of the list. Later errors are often caused by the first one, so re-check after each fix.'
    )
  }
  if (rerunNeeded) {
    advice.push(
      'LaTeX asked for another pass because labels or citations changed. Compile again so cross-references are settled.'
    )
  }
  if (counts.undefinedReferences > 0) {
    advice.push(
      'Undefined references: check that each \\ref target has a matching \\label.'
    )
  }
  if (counts.undefinedCitations > 0) {
    advice.push(
      'Undefined citations: check each \\cite key against the .bib file and the BibTeX/Biber messages in errors and warnings.'
    )
  }

  return {
    fatal,
    rerunNeeded,
    counts,
    errors,
    warnings,
    badBoxes,
    advice,
  }
}

export default summarizeCompileLogs
