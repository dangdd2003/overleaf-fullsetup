import logger from '@overleaf/logger'
import DocumentUpdaterHandler from '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs'
import ProjectEntityHandler from '../../../../app/src/Features/Project/ProjectEntityHandler.mjs'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import EditorController from '../../../../app/src/Features/Editor/EditorController.mjs'
import CompileManager from '../../../../app/src/Features/Compile/CompileManager.mjs'
import ClsiManager from '../../../../app/src/Features/Compile/ClsiManager.mjs'
import ProjectOptionsHandler from '../../../../app/src/Features/Project/ProjectOptionsHandler.mjs'
import { User } from '../../../../app/src/models/User.mjs'
import {
  inspectPdfPage,
  overviewPdfPages,
  searchPdfText,
  highlightSourceInPdf,
  PdfPageError,
  PDF_PAGE_ERRORS,
  REGIONS as PDF_PAGE_REGIONS,
  resolveBlock,
} from '../../../../app/src/Features/PdfInspection/PdfPageInspector.mjs'
import { diffBuilds as diffPdfBuilds, rememberBuildPages } from '../../../../app/src/Features/PdfInspection/PdfVisualDiff.mjs'
import { inspectCompiledStyle } from '../../../../app/src/Features/PdfInspection/PdfStyleInspector.mjs'
import Settings from '@overleaf/settings'
import { LatexLogParser } from './LatexLogParser.mjs'
import {
  buildFingerprint,
  digestContent,
  diffFingerprints,
} from '../../../../app/src/Features/PdfInspection/BuildFingerprint.mjs'
import { matchesGlob } from './AiAssistGlob.mjs'
import { buildProjectIndex, matchSection } from './AiAssistProjectIndex.mjs'
import { regexSearch } from './AiAssistRegexSearch.mjs'
import {
  imagePolicyFor,
  inspectOptionsFor,
  wantsColor,
} from './AiAssistImagePolicy.mjs'

// A tool call reads the project through one snapshot: one flush plus one bulk
// read, instead of one document-updater request per document per call. Short
// enough that a user typing alongside the agent is seen on the next step;
// read_file and edit_file still read the live document.
const SNAPSHOT_TTL_MS = 5000
const MAX_FILE_ROWS = 400
const MAX_READ_LINES = 1000
// Without from/to, read_file returns a window instead of a whole long file:
// the result stays in the conversation and is re-sent on every later step.
const DEFAULT_READ_LINES = 500
const MAX_SEARCH_HITS = 50
const MAX_REMEMBERED_COMPILES = 100
const MAX_PDF_QUERY_CHARS = 200
// CLSI build ids and server ids, as McpCompileController validates them. A
// build id from the browser is only ever used to read that build's output.
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i
// Highlights the viewer draws at most, and the bounds of one box's numbers
const MAX_PDF_BOXES = 200
const MAX_PDF_PAGE = 10_000
const MAX_PDF_POINTS = 100_000
// Free text the model may store on the account: a name, not a document
const ACCOUNT_TEXT_CHARS = 100
const accountText = value => String(value).slice(0, ACCOUNT_TEXT_CHARS)
const BUILD_ID_RE = /^[a-f0-9]+-[a-f0-9]+$/
const CLSI_SERVER_ID_RE = /^[a-z0-9-]+$/

const FORBIDDEN_ACCOUNT_KEYS = new Set([
  'password',
  'email',
  'emails',
  'first_name',
  'last_name',
  'role',
  'institution',
  'tokens',
  'sessions',
  'saml',
  'billing',
  'subscription',
  'admin',
])

const ALLOWED_APPEARANCE_KEYS = new Set([
  'overallTheme',
  'editorTheme',
  'editorLightTheme',
  'editorDarkTheme',
  'darkModePdf',
  'fontSize',
  'fontFamily',
  'lineHeight',
])

export const DARK_EDITOR_THEMES = new Set([
  'ambiance',
  'chaos',
  'clouds_midnight',
  'cobalt',
  'dracula',
  'gob',
  'gruvbox',
  'idle_fingers',
  'kr_theme',
  'merbivore',
  'merbivore_soft',
  'mono_industrial',
  'monokai',
  'nord_dark',
  'overleaf_dark',
  'pastel_on_dark',
  'solarized_dark',
  'terminal',
  'tomorrow_night',
  'tomorrow_night_blue',
  'tomorrow_night_bright',
  'tomorrow_night_eighties',
  'twilight',
  'vibrant_ink',
])

export const LIGHT_EDITOR_THEMES = new Set([
  'chrome',
  'clouds',
  'crimson_editor',
  'dawn',
  'dreamweaver',
  'eclipse',
  'github',
  'iplastic',
  'katzenmilch',
  'kuroir',
  'overleaf',
  'solarized_light',
  'sqlserver',
  'textmate',
  'tomorrow',
  'xcode',
])

const ALLOWED_COMPILER_KEYS = new Set([
  'compiler',
  'imageName',
  'rootDocPath',
  'rootDocId',
  'draft',
  'stopOnFirstError',
])

const ALLOWED_EDITOR_KEYS = new Set([
  'mode',
  'autoComplete',
  'autoPairDelimiters',
  'syntaxValidation',
  'pdfViewer',
  'mathPreview',
  'breadcrumbs',
  'editorTabs',
  'spellCheckLanguage',
])

function normalizeLines(str) {
  return (str || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

export function cleanLineNumbers(text) {
  return (text || '').replace(/^\s*\d+[:|]\s?/gm, '')
}

export function cleanLineNumberPrefixes(text, oldTextWasStripped = false) {
  if (!text) return ''
  const lines = text.split('\n')
  const nonEmptyLines = lines.filter(l => l.trim().length > 0)
  if (nonEmptyLines.length === 0) return text

  const prefixRegex = /^\s*\d+[:|]\s?/
  const matchingLines = nonEmptyLines.filter(l => prefixRegex.test(l))

  const isMajority = matchingLines.length >= Math.ceil(nonEmptyLines.length / 2)
  if (oldTextWasStripped || isMajority) {
    return lines.map(line => line.replace(prefixRegex, '')).join('\n')
  }

  return text
}

export function errorSignature(e) {
  return `${e.file || ''}::${(e.message || '').trim()}`
}

export function computeErrorDelta(currentErrors = [], previousErrors = []) {
  const prevMap = new Map()
  const currMap = new Map()
  for (const e of previousErrors) {
    const sig = errorSignature(e)
    prevMap.set(sig, (prevMap.get(sig) || 0) + 1)
  }
  for (const e of currentErrors) {
    const sig = errorSignature(e)
    currMap.set(sig, (currMap.get(sig) || 0) + 1)
  }

  const newErrors = currentErrors.filter(
    e => (prevMap.get(errorSignature(e)) || 0) === 0
  )

  let resolvedErrorsCount = 0
  for (const [sig, count] of prevMap) {
    const currCount = currMap.get(sig) || 0
    if (count > currCount) {
      resolvedErrorsCount += count - currCount
    }
  }

  const countDelta = currentErrors.length - previousErrors.length

  return {
    countDelta,
    newErrors,
    newErrorsCount: newErrors.length,
    resolvedErrorsCount,
    regressed: countDelta > 0 || newErrors.length > 0,
  }
}

export function countOccurrences(haystack, needle) {
  if (!needle) return 0
  const normH = normalizeLines(haystack)
  const normN = normalizeLines(needle)
  if (!normN) return 0
  let count = 0
  let index = normH.indexOf(normN)
  while (index !== -1) {
    count += 1
    index = normH.indexOf(normN, index + Math.max(1, normN.length))
  }
  if (count > 0) return count

  const trimH = normH
    .split('\n')
    .map(l => l.trimEnd())
    .join('\n')
  const trimN = normN
    .split('\n')
    .map(l => l.trimEnd())
    .join('\n')
  if (!trimN) return 0
  index = trimH.indexOf(trimN)
  while (index !== -1) {
    count += 1
    index = trimH.indexOf(trimN, index + Math.max(1, trimN.length))
  }
  return count
}

export function cleanOldText(text) {
  if (!text) return ''
  let cleaned = cleanLineNumbers(text)
  // Normalize double-escaped LaTeX backslashes e.g. \\centering -> \centering
  cleaned = cleaned.replace(/\\\\([a-zA-Z@]+)/g, '\\$1')
  return cleaned
}

export function tokenizeCode(str) {
  const tokens = []
  const re =
    /\\[a-zA-Z@]+|\\end\{[^}]*\}|\\begin\{[^}]*\}|\{[^}]*\}|[^\s\\{}]+|\\/g
  let m
  while ((m = re.exec(str)) !== null) {
    tokens.push({
      text: m[0],
      start: m.index,
      end: m.index + m[0].length,
    })
  }
  return tokens
}

export function findWhitespaceAgnosticAnchor(haystack, needle) {
  if (!needle || !haystack) return null
  const cleanedNeedle = cleanOldText(needle)
  const hTokens = tokenizeCode(haystack)
  const nTokens = tokenizeCode(cleanedNeedle)

  if (nTokens.length === 0 || hTokens.length < nTokens.length) return null

  // Normalize tokens: strip redundant backslashes on commands
  const normN = nTokens.map(t => t.text.replace(/\\\\([a-zA-Z@]+)/g, '\\$1'))
  const normH = hTokens.map(t => t.text.replace(/\\\\([a-zA-Z@]+)/g, '\\$1'))

  const matchIndices = []

  for (let i = 0; i <= normH.length - normN.length; i++) {
    let match = true
    for (let j = 0; j < normN.length; j++) {
      if (normH[i + j] !== normN[j]) {
        match = false
        break
      }
    }
    if (match) {
      matchIndices.push(i)
    }
  }

  if (matchIndices.length === 1) {
    const startIdx = matchIndices[0]
    const endIdx = startIdx + normN.length - 1
    const charStart = hTokens[startIdx].start
    const charEnd = hTokens[endIdx].end
    return {
      matchedText: haystack.slice(charStart, charEnd),
      charStart,
      charEnd,
    }
  }

  return null
}

export function locateAnchorInText(docText, anchor) {
  if (!docText || !anchor) return null

  // 1. Exact match
  let count = countOccurrences(docText, anchor)
  if (count === 1) return { type: 'exact', anchor }

  // 2. Cleaned backslashes / line numbers
  const cleaned = cleanOldText(anchor)
  if (cleaned && cleaned !== anchor) {
    count = countOccurrences(docText, cleaned)
    if (count === 1) return { type: 'cleaned', anchor: cleaned }
  }

  // 3. Fuzzy anchor matching
  const fuzzy =
    findFuzzyUniqueAnchor(docText, anchor) ||
    (cleaned ? findFuzzyUniqueAnchor(docText, cleaned) : null)
  if (fuzzy) return { type: 'fuzzy', anchor: fuzzy }

  // 4. Whitespace-agnostic token matching
  const wsMatch =
    findWhitespaceAgnosticAnchor(docText, anchor) ||
    (cleaned ? findWhitespaceAgnosticAnchor(docText, cleaned) : null)
  if (wsMatch) {
    return {
      type: 'whitespace',
      anchor: wsMatch.matchedText,
      charStart: wsMatch.charStart,
      charEnd: wsMatch.charEnd,
    }
  }

  // 5. Fuzzy word window matching
  const wordMatch =
    findFuzzyWordWindow(docText, anchor) ||
    (cleaned ? findFuzzyWordWindow(docText, cleaned) : null)
  if (wordMatch) {
    return {
      type: 'fuzzy_words',
      anchor: wordMatch.anchor,
      charStart: wordMatch.charStart,
      charEnd: wordMatch.charEnd,
      score: wordMatch.score,
    }
  }

  return null
}

export function cleanWord(w) {
  return (w || '').toLowerCase().replace(/[^a-z0-9\\]/g, '')
}

export function findFuzzyWordWindow(docText, needleText, threshold = 0.75) {
  if (!docText || !needleText) return null
  const docWords = []
  const wordRe = /\S+/g
  let m
  while ((m = wordRe.exec(docText)) !== null) {
    const raw = m[0]
    const clean = cleanWord(raw)
    if (clean) {
      docWords.push({ clean, start: m.index, end: m.index + raw.length })
    }
  }

  const needleWords = []
  while ((m = wordRe.exec(needleText)) !== null) {
    const clean = cleanWord(m[0])
    if (clean) needleWords.push(clean)
  }

  if (needleWords.length < 3 || docWords.length < 3) return null
  const nLen = needleWords.length

  const hits = []
  const minW = Math.max(3, nLen - 4)
  const maxW = Math.min(docWords.length, nLen + 4)

  for (let i = 0; i <= docWords.length - minW; i++) {
    for (let w = minW; w <= Math.min(docWords.length - i, maxW); w++) {
      let matches = 0
      let d = 0
      let n = 0
      while (d < w && n < nLen) {
        if (docWords[i + d].clean === needleWords[n]) {
          matches++
          d++
          n++
        } else if (d + 1 < w && docWords[i + d + 1].clean === needleWords[n]) {
          d += 2
          n++
          matches += 0.8
        } else if (
          n + 1 < nLen &&
          docWords[i + d].clean === needleWords[n + 1]
        ) {
          d++
          n += 2
          matches += 0.8
        } else {
          d++
          n++
        }
      }
      const score = (2 * matches) / (w + nLen)
      if (score >= threshold) {
        hits.push({ startIdx: i, endIdx: i + w - 1, score })
      }
    }
  }

  if (hits.length === 0) return null

  hits.sort((a, b) => b.score - a.score)
  const clusters = []
  for (const hit of hits) {
    let merged = false
    for (const cluster of clusters) {
      if (
        Math.max(hit.startIdx, cluster.best.startIdx) <=
        Math.min(hit.endIdx, cluster.best.endIdx)
      ) {
        merged = true
        break
      }
    }
    if (!merged) {
      clusters.push({ best: hit })
    }
  }

  if (clusters.length === 1 && clusters[0].best.score >= threshold) {
    const best = clusters[0].best
    const startChar = docWords[best.startIdx].start
    const endChar = docWords[best.endIdx].end
    return {
      anchor: docText.slice(startChar, endChar),
      charStart: startChar,
      charEnd: endChar,
      score: best.score,
    }
  }

  return null
}

export function formatAmbiguousOccurrences(
  docText,
  lineNumbers,
  maxOccurrences = 4
) {
  const lines = (docText || '').split('\n')
  const shown = (lineNumbers || []).slice(0, maxOccurrences)
  const previews = shown.map(lineNo => {
    const idx = lineNo - 1
    const start = Math.max(0, idx - 1)
    const end = Math.min(lines.length, idx + 3)
    const snippet = lines
      .slice(start, end)
      .map((l, offset) => `    ${start + offset + 1}: ${l}`)
      .join('\n')
    return `  Occurrence around line ${lineNo}:\n${snippet}`
  })

  return previews.join('\n\n')
}

export function findMatchingLines(haystack, needle) {
  if (!needle || !haystack) return []
  const normH = normalizeLines(haystack)
  const normN = cleanOldText(normalizeLines(needle))
  const hLines = normH.split('\n')
  const nLines = normN
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
  if (nLines.length === 0) return []

  const targetLine = nLines[0]
  const results = []

  for (let i = 0; i < hLines.length; i++) {
    const trimmedH = hLines[i].trim()
    if (
      trimmedH === targetLine ||
      (targetLine.length > 5 && trimmedH.includes(targetLine))
    ) {
      results.push(i + 1)
    }
  }
  return results.slice(0, 5)
}

export function findFuzzyUniqueAnchor(haystack, needle) {
  if (!needle) return null
  const normH = normalizeLines(haystack)
  const normN = normalizeLines(needle)

  // 1. Try stripped line numbers
  const stripped = cleanLineNumbers(normN)
  if (stripped && stripped !== normN) {
    const strippedOccurrences = countOccurrences(normH, stripped)
    if (strippedOccurrences === 1) {
      return stripped
    }
  }

  // Also try cleaned old text (stripped line numbers + normalized backslashes)
  const cleaned = cleanOldText(normN)
  if (cleaned && cleaned !== normN) {
    const cleanedOccurrences = countOccurrences(normH, cleaned)
    if (cleanedOccurrences === 1) {
      return cleaned
    }
  }

  // 2. Line-by-line trimmed matching against haystack lines
  const hLines = normH.split('\n')
  const nLines = (cleaned || stripped || normN).split('\n')

  while (nLines.length > 1 && nLines[nLines.length - 1].trim() === '') {
    nLines.pop()
  }
  while (nLines.length > 1 && nLines[0].trim() === '') {
    nLines.shift()
  }

  const trimmedN = nLines.map(l => l.trim())
  if (trimmedN.length === 0 || trimmedN.every(l => l === '')) return null

  const matchIndices = []

  for (let i = 0; i <= hLines.length - trimmedN.length; i++) {
    let matches = true
    for (let j = 0; j < trimmedN.length; j++) {
      if (hLines[i + j].trim() !== trimmedN[j]) {
        matches = false
        break
      }
    }
    if (matches) {
      matchIndices.push(i)
    }
  }

  if (matchIndices.length === 1) {
    const startIdx = matchIndices[0]
    return hLines.slice(startIdx, startIdx + trimmedN.length).join('\n')
  }

  return null
}

export function nearestLines(text, oldText, limit = 5) {
  const cleaned = cleanOldText(oldText || '')
  const probes = cleaned
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length >= 4)
  if (probes.length === 0) return []

  const lines = normalizeLines(text).split('\n')
  const scored = []

  lines.forEach((line, index) => {
    const candidate = line.trim()
    if (!candidate) return
    for (const probe of probes) {
      let score = 0
      if (candidate === probe) score = 3
      else if (candidate.includes(probe) || probe.includes(candidate)) score = 2
      else if (
        probe.length > 6 &&
        candidate.toLowerCase().includes(probe.slice(0, 6).toLowerCase())
      ) {
        score = 1
      }
      if (score > 0) {
        scored.push({ line: index + 1, text: line, score })
        break
      }
    }
  })

  return scored
    .sort((a, b) => b.score - a.score || a.line - b.line)
    .slice(0, limit)
    .map(({ line, text: lineText }) => ({ line, text: lineText }))
}

const MAX_EXCERPT_LINES = 8

/**
 * The log lines TeX printed for one parsed error (`l.12 \foo` and friends),
 * taken from the entry itself rather than searched for in the whole log, so
 * two errors with the same message each keep their own context. The first raw
 * line is the message, which the caller already shows.
 */
export function errorExcerpt(entry) {
  if (!entry || typeof entry.raw !== 'string') return null
  const lines = entry.raw
    .split('\n')
    .slice(1)
    .filter(line => line.trim() !== '')
    .slice(0, MAX_EXCERPT_LINES)
  return lines.length > 0 ? lines.join('\n') : null
}

const EDIT_CONTEXT_LINES = 3
const MAX_EDIT_EXCERPT_LINES = 40

/**
 * Where an applied edit landed, in the document as it is now. Line numbers the
 * model read before the edit are stale below it; the new range, the shift and
 * the numbered lines around the change let it chain further edits without
 * reading the file again.
 */
export function describeAppliedEdit(plan) {
  const startLine = Math.max(1, plan.startLine || 1)
  const newSpan = plan.newText ? plan.newText.split('\n').length : 0
  const endLine = newSpan > 0 ? startLine + newSpan - 1 : null
  const from = Math.max(1, startLine - EDIT_CONTEXT_LINES)
  const to = Math.min(
    plan.lines.length,
    (endLine ?? startLine) + EDIT_CONTEXT_LINES,
    from + MAX_EDIT_EXCERPT_LINES - 1
  )
  return {
    startLine,
    endLine,
    lineDelta:
      typeof plan.previousLineCount === 'number'
        ? plan.lines.length - plan.previousLineCount
        : 0,
    excerpt: plan.lines
      .slice(from - 1, to)
      .map((line, index) => `${from + index}: ${line}`)
      .join('\n'),
  }
}

/**
 * The 1-based line of the last uncommented `\end{document}`, or null. Text
 * appended to the end of such a file lands after it, where LaTeX never reads it.
 */
export function endDocumentLine(docText) {
  const lines = String(docText || '').split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    const code = lines[index].replace(/(^|[^\\])%.*$/, '$1')
    if (code.includes('\\end{document}')) return index + 1
  }
  return null
}

/**
 * Reads the clean flag out of whatever the model actually sent.
 *
 * Mirrors compile-args.ts on the frontend, which serves the in-editor run; this
 * copy serves the background run, where the same tool call executes here
 * instead. Providers vary in how faithfully they honour a boolean schema and
 * local models routinely send `"true"` for `true`, so both sides coerce rather
 * than trusting the declared type.
 */
/**
 * The build a compile left behind, when it wrote a PDF: what
 * view_compiled_pdf_page renders. Anything malformed is dropped rather than
 * passed on to CLSI.
 */
export function compiledBuild(outcome) {
  const buildId =
    typeof outcome?.buildId === 'string' && BUILD_ID_RE.test(outcome.buildId)
      ? outcome.buildId
      : null
  if (!buildId) return { buildId: null, clsiServerId: null }
  const clsiServerId =
    typeof outcome.clsiServerId === 'string' &&
    CLSI_SERVER_ID_RE.test(outcome.clsiServerId)
      ? outcome.clsiServerId
      : null
  return { buildId, clsiServerId }
}

export function wantsCleanCompile(args) {
  if (!args || typeof args !== 'object') return false
  // `clean` is the documented name. The others are the ways models phrase the
  // same idea when they have not read the schema closely.
  const raw =
    args.clean ??
    args.clearCache ??
    args.clear_cache ??
    args.fromScratch ??
    args.from_scratch ??
    args.rebuild
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'number') return raw !== 0
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase()
    return ['true', '1', 'yes', 'y', 'on'].includes(normalized)
  }
  return false
}

/**
 * The status a compile reports. A build with errors that still wrote a PDF is
 * `success_with_errors` (the MCP vocabulary), not a plain failure: the model
 * can look at the pages it got. Other statuses pass through unchanged.
 */
export function withErrorsStatus(status, errorCount, pdfProduced) {
  if (!pdfProduced || errorCount === 0) return status
  if (status === 'failure' || status === 'success') return 'success_with_errors'
  return status
}

/** Sets `key` as the newest entry of a per-project map of bounded size. */
function remember(map, key, value) {
  map.delete(String(key))
  map.set(String(key), value)
  while (map.size > MAX_REMEMBERED_COMPILES) {
    map.delete(map.keys().next().value)
  }
}

// Some gateways send numeric arguments as strings. Anything that is not a
// number is absent (null), so a caller can tell what the model gave.
function optionalNumber(value) {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '') return Number(value)
  return null
}

function isWholeNumberFrom(value, min) {
  return Number.isInteger(value) && value >= min
}

/**
 * The page, or the source block, that view_compiled_pdf_page was asked for.
 * Returns `{ error }` for arguments the model should correct, and otherwise
 * the parsed values with null for each one it did not give.
 */
export function parsePdfPageArgs(args = {}) {
  const page = optionalNumber(args.page)
  const line = optionalNumber(args.line)
  const endLine = optionalNumber(args.endLine)
  const path =
    typeof args.path === 'string' && args.path.trim()
      ? args.path.trim().replace(/^\/+/, '')
      : null
  const region = PDF_PAGE_REGIONS.includes(args.region) ? args.region : null
  const block =
    typeof args.block === 'string' && args.block.trim()
      ? args.block.trim().toUpperCase()
      : null
  const labels = args.labels === true || args.labels === 'true'

  if (block !== null) {
    if (!/^B\d+$/.test(block)) {
      return { error: `block must be a label such as "B3", got ${args.block}.` }
    }
    if (page === null) {
      return {
        error:
          'block goes with page: pass the page the label is shown on, with block.',
      }
    }
    if (path || line !== null || endLine !== null) {
      return {
        error:
          'block replaces path, line and endLine: pass page and block, or path and line, not both.',
      }
    }
  }

  if (page !== null && !isWholeNumberFrom(page, 1)) {
    return { error: `page must be a whole number from 1, got ${args.page}.` }
  }
  if (page === null && path && !isWholeNumberFrom(line, 1)) {
    return {
      error: `Pass line with path: the 1-based line of ${path} whose page to show.`,
    }
  }
  if (endLine !== null) {
    if (page !== null) {
      return {
        error:
          'endLine goes with path and line, not with page. Pass page alone, or path, line and endLine. To zoom into the page, pass region.',
      }
    }
    if (!path || line === null) {
      return {
        error:
          'endLine needs path and line: the block from line to endLine is the part of the page to zoom on.',
      }
    }
    if (!isWholeNumberFrom(endLine, line)) {
      return {
        error: `endLine must be a whole number from line (${line}), got ${args.endLine}.`,
      }
    }
  }
  return { page, path, line, endLine, region, block, labels }
}

/**
 * The pages view_compiled_pdf_overview and search_compiled_pdf were asked
 * for. Each end is null when not given, and the inspector applies its own
 * default. The range is checked from fromPage, which is 1 when not given.
 */
export function parsePdfPageRange(args = {}) {
  const fromPage = optionalNumber(args.fromPage)
  const toPage = optionalNumber(args.toPage)
  if (fromPage !== null && !isWholeNumberFrom(fromPage, 1)) {
    return { error: `fromPage must be a whole number from 1, got ${args.fromPage}.` }
  }
  const from = fromPage ?? 1
  if (toPage !== null && !isWholeNumberFrom(toPage, from)) {
    return {
      error: `toPage must be a whole number from fromPage (${from}), got ${args.toPage}.`,
    }
  }
  return { fromPage, toPage }
}

/**
 * The source range highlight_in_pdf was asked for: a path and a 1-based line,
 * with an optional endLine that defaults to line. `{ error }` for arguments
 * the model should correct.
 */
export function parsePdfSourceRange(args = {}) {
  const path =
    typeof args.path === 'string' ? args.path.trim().replace(/^\/+/, '') : ''
  const line = optionalNumber(args.line)
  const endLine = optionalNumber(args.endLine)
  if (!path || !isWholeNumberFrom(line, 1)) {
    return {
      error:
        'Give either boxes, or a path and a line: the 1-based line of path to highlight, with endLine for a range.',
    }
  }
  if (endLine !== null && !isWholeNumberFrom(endLine, line)) {
    return {
      error: `endLine must be a whole number from line (${line}), got ${args.endLine}.`,
    }
  }
  return { path, line, endLine: endLine ?? line }
}

/**
 * The boxes highlight_in_pdf was given: each a page from 1 and a position and
 * size in PDF points. Malformed boxes are dropped, as the viewer drops them;
 * null when none is left.
 */
export function parsePdfBoxes(value) {
  if (!Array.isArray(value)) return null
  const boxes = []
  for (const item of value) {
    if (boxes.length >= MAX_PDF_BOXES) break
    if (!item || typeof item !== 'object') continue
    const { page, h, v, width, height } = item
    if (!isWholeNumberFrom(page, 1) || page > MAX_PDF_PAGE) continue
    const numbers = [h, v, width, height]
    if (
      !numbers.every(
        n =>
          typeof n === 'number' &&
          Number.isFinite(n) &&
          Math.abs(n) <= MAX_PDF_POINTS
      )
    ) {
      continue
    }
    if (width < 0 || height < 0) continue
    boxes.push({ page, h, v, width, height })
  }
  return boxes.length > 0 ? boxes : null
}

/**
 * What highlight_in_pdf returns. The boxes travel in `highlights`, which the
 * run forwards to the viewer (dispatchPdfResultHighlights); the model is told
 * the count and the pages only (AiAssistToolRender).
 */
function highlightResult(highlights) {
  const pages = [...new Set(highlights.map(box => box.page))].sort(
    (a, b) => a - b
  )
  return { status: 'highlighted', count: highlights.length, pages, highlights }
}

/** Mirrors the in-browser tool's spec. */
export const PDF_HIGHLIGHT_SPEC = {
  name: 'highlight_in_pdf',
  description:
    "Show a place in the user's PDF viewer: it highlights the place and scrolls to it. Give path and line (and endLine for a range) to show where a source line lands in the PDF, or boxes in PDF points measured from the top-left of each page. Use it after an edit so the user can see what changed, or to show the passage you are talking about. It changes only the viewer, never the project.",
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Project file path, such as sections/intro.tex. Use with line.',
      },
      line: {
        type: 'integer',
        minimum: 1,
        description: 'Source line in path.',
      },
      endLine: {
        type: 'integer',
        minimum: 1,
        description: 'Last source line of a range that starts at line. Defaults to line.',
      },
      boxes: {
        type: 'array',
        description: 'Boxes to highlight, instead of a source range.',
        items: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1 },
            h: { type: 'number', description: 'Left edge, PDF points.' },
            v: { type: 'number', description: 'Top edge, PDF points from the top of the page.' },
            width: { type: 'number' },
            height: { type: 'number' },
          },
          required: ['page', 'h', 'v', 'width', 'height'],
        },
      },
    },
    required: [],
  },
}

export class AiAssistTools {
  constructor({
    docUpdater = DocumentUpdaterHandler.promises,
    entityHandler = ProjectEntityHandler.promises,
    projectGetter = ProjectGetter.promises,
    editorController = EditorController,
    compileManager = CompileManager.promises,
    clsiManager = ClsiManager.promises,
    projectOptionsHandler = ProjectOptionsHandler.promises,
    userModel = User,
    settings = Settings,
    pdfPageInspector = {
      inspect: inspectPdfPage,
      overview: overviewPdfPages,
      search: searchPdfText,
      highlight: highlightSourceInPdf,
    },
    pdfStyleInspector = {
      inspect: inspectCompiledStyle,
    },
    pdfVisualDiff = {
      diff: diffPdfBuilds,
      remember: rememberBuildPages,
    },
  } = {}) {
    this.docUpdater = docUpdater
    this.entityHandler = entityHandler
    this.projectGetter = projectGetter
    this.editorController = editorController
    this.compileManager = compileManager
    this.clsiManager = clsiManager
    this.projectOptionsHandler = projectOptionsHandler
    this.userModel = userModel
    this.settings = settings
    this.pdfPageInspector = pdfPageInspector
    this.pdfStyleInspector = pdfStyleInspector
    this.pdfVisualDiff = pdfVisualDiff
    this.lastCompileResult = new Map()
    this._lastEdits = new Map()
    this._snapshots = new Map()
    this._indexes = new Map()
  }

  async _getRootFolderId(projectId) {
    try {
      if (this.projectGetter?.getProject) {
        const project = await this.projectGetter.getProject(projectId, {
          rootFolder: true,
        })
        return project?.rootFolder?.[0]?._id ?? null
      }
    } catch {
      // ignore
    }
    return null
  }

  async _resolveValidUserId(projectId, userId) {
    if (userId && /^[0-9a-f]{24}$/i.test(String(userId))) {
      return String(userId)
    }
    return null
  }

  async _getDocsList(projectId) {
    const raw = await this.entityHandler.getAllDocs(projectId)
    if (Array.isArray(raw)) {
      return raw.map(d => ({
        _id: d._id,
        name: d.name || '',
        path: (d.path || d.name || '').replace(/^\//, ''),
        lines: d.lines || [],
      }))
    }
    if (raw && typeof raw === 'object') {
      return Object.entries(raw).map(([docPath, d]) => ({
        _id: d._id,
        name: d.name || '',
        path: docPath.replace(/^\//, ''),
        lines: d.lines || [],
      }))
    }
    return []
  }

  async _getFilesList(projectId) {
    if (!this.entityHandler.getAllFiles) return []
    const raw = await this.entityHandler.getAllFiles(projectId)
    const entries = Array.isArray(raw)
      ? raw.map(file => [file.path || file.name || '', file])
      : Object.entries(raw || {})
    return entries.map(([filePath, file]) => ({
      _id: file._id,
      path: String(filePath).replace(/^\//, ''),
    }))
  }

  /** Keeps the newest compile per project, for at most MAX_REMEMBERED_COMPILES projects. */
  _rememberCompile(projectId, value) {
    remember(this.lastCompileResult, projectId, value)
  }

  /**
   * Where the agent last changed a project, which is the page
   * view_compiled_pdf_page opens when it is not told one, and the block it
   * zooms on in the visual check. The end line is never before the start.
   */
  _rememberEdit(projectId, path, line, endLine = line) {
    if (!path) return
    const start = Math.max(1, Number(line) || 1)
    remember(this._lastEdits, projectId, {
      path,
      line: start,
      endLine: Math.max(start, Number(endLine) || start),
      at: Date.now(),
    })
  }

  invalidateSnapshot(projectId) {
    this._snapshots.delete(String(projectId))
  }

  /**
   * The fingerprint of the project as it is now: every doc's content, every
   * file's id, the root document, compiler and image. Reads the project fresh,
   * since the snapshot cache may predate edits the user made in the editor.
   */
  async _projectFingerprint(projectId) {
    this.invalidateSnapshot(projectId)
    const snapshot = await this._getSnapshot(projectId)
    const project = await this.projectGetter
      .getProject(projectId, { compiler: 1, imageName: 1 })
      .catch(() => null)
    const entries = [
      ...snapshot.docs.map(doc => ({
        path: doc.path,
        digest: digestContent((doc.lines || []).join('\n')),
      })),
      ...snapshot.files.map(file => ({
        path: file.path,
        digest: String(file._id ?? ''),
      })),
    ]
    return buildFingerprint({
      rootDocPath: snapshot.rootPath,
      compiler: project?.compiler ?? null,
      imageName: project?.imageName ?? null,
      entries,
    })
  }

  async _getSnapshot(projectId) {
    const key = String(projectId)
    const now = Date.now()
    const cached = this._snapshots.get(key)
    if (cached && now - cached.at < SNAPSHOT_TTL_MS) return cached.value

    // Cached snapshots can only grow as projects are opened; drop stale ones.
    for (const [otherKey, entry] of this._snapshots) {
      if (now - entry.at >= SNAPSHOT_TTL_MS) this._snapshots.delete(otherKey)
    }

    let flushed = false
    if (this.docUpdater.flushProjectToMongo) {
      try {
        await this.docUpdater.flushProjectToMongo(projectId)
        flushed = true
      } catch {
        // fall back to reading each document from the document updater
      }
    }

    const listed = await this._getDocsList(projectId)
    const docs = flushed
      ? listed
      : await Promise.all(
          listed.map(async doc => {
            try {
              const fetched = await this.docUpdater.getDocument(
                projectId,
                doc._id,
                -1
              )
              if (fetched?.lines) return { ...doc, lines: fetched.lines }
            } catch {
              // keep the docstore copy
            }
            return doc
          })
        )

    let rootPath = null
    try {
      const project = await this.projectGetter.getProject(projectId, {
        rootDoc_id: 1,
      })
      if (project?.rootDoc_id) {
        const root = docs.find(
          doc => String(doc._id) === String(project.rootDoc_id)
        )
        rootPath = root ? root.path : null
      }
    } catch {
      // no root document: index in file order
    }

    const files = await this._getFilesList(projectId).catch(() => [])
    const docTexts = {}
    for (const doc of docs) docTexts[doc.path] = (doc.lines || []).join('\n')

    const value = { docs, files, rootPath, docTexts }
    this._snapshots.set(key, { at: Date.now(), value })
    return value
  }

  async _getIndex(projectId) {
    const snapshot = await this._getSnapshot(projectId)
    const key = String(projectId)
    // buildProjectIndex returns `previous` unchanged when no file changed.
    const index = buildProjectIndex(
      { docs: snapshot.docTexts, rootPath: snapshot.rootPath },
      this._indexes.get(key)
    )
    // Bounded like the other per-project caches: each index holds a project's text
    remember(this._indexes, key, index)
    return index
  }

  /**
   * The project's root AGENTS.md, or null. Read from the live snapshot, so an
   * edit the agent or the user just made is seen on the next step.
   */
  async getProjectInstructions(projectId) {
    try {
      const snapshot = await this._getSnapshot(projectId)
      const doc = snapshot.docs.find(
        d => !d.path.includes('/') && d.path.toLowerCase() === 'agents.md'
      )
      if (!doc) return null
      const full = snapshot.docTexts[doc.path] ?? ''
      if (!full.trim()) return null
      return { path: doc.path, text: full }
    } catch (err) {
      logger.warn({ err, projectId }, '[AiAssist] Could not read AGENTS.md')
      return null
    }
  }

  async resolveEditTarget(args, { projectId }) {
    if (
      !args ||
      !args.oldText ||
      typeof args.oldText !== 'string' ||
      !args.oldText.trim()
    ) {
      return null
    }
    const doc = await this._resolveDoc(projectId, args.path)
    if (doc) {
      let docText = (doc.lines || []).join('\n')
      try {
        const fetched = await this.docUpdater.getDocument(
          projectId,
          doc._id,
          -1
        )
        if (fetched?.lines) docText = fetched.lines.join('\n')
      } catch {}
      const match = locateAnchorInText(docText, args.oldText)
      if (match) return { path: doc.path, doc }
    }

    // Search other project files
    const allDocs = await this._getDocsList(projectId)
    for (const other of allDocs) {
      if (doc && String(other._id) === String(doc._id)) continue
      let otherText = (other.lines || []).join('\n')
      try {
        const fetched = await this.docUpdater.getDocument(
          projectId,
          other._id,
          -1
        )
        if (fetched?.lines) otherText = fetched.lines.join('\n')
      } catch {}
      const match = locateAnchorInText(otherText, args.oldText)
      if (match) {
        return { path: other.path, doc: other }
      }
    }
    return null
  }

  async _resolveDoc(projectId, targetPath) {
    if (!targetPath || typeof targetPath !== 'string' || !targetPath.trim()) {
      return null
    }
    const normalized = targetPath.trim().replace(/^\//, '')
    if (this.entityHandler.getDocIdByPath) {
      try {
        const docId = await this.entityHandler.getDocIdByPath(
          projectId,
          normalized
        )
        if (docId) {
          const docs = await this._getDocsList(projectId)
          const found = docs.find(d => String(d._id) === String(docId))
          if (found) return found
          return {
            _id: docId,
            path: normalized,
            name: normalized.split('/').pop(),
            lines: [],
          }
        }
      } catch {
        // Fall back to scanning the docs list
      }
    }
    const docs = await this._getDocsList(projectId)
    const exact = docs.find(d => d.path === normalized)
    if (exact) return exact
    // A partial path matches whole path segments only ("intro.tex" matches
    // "chapters/intro.tex", never "myintro.tex"), and only when exactly one
    // document fits: taking the first of several reads or edits the wrong file.
    const bySegments = docs.filter(d => d.path.endsWith(`/${normalized}`))
    return bySegments.length === 1 ? bySegments[0] : null
  }

  async _resolveDocId(projectId, path) {
    const doc = await this._resolveDoc(projectId, path)
    return doc?._id ?? null
  }

  /**
   * Works out what an edit_file call would write, without writing it.
   *
   * Returns { result } for a call that cannot apply (the result is what the
   * model should see), or { doc, lines, path, note? } for one that can. The run
   * loop calls this before asking the user to approve, so nobody reviews a diff
   * that could never apply.
   */
  async _planEdit(projectId, args = {}) {
    if (args._parseError) {
      return {
        result: {
          status: 'error',
          error:
            'Tool arguments were truncated or invalid JSON. Please perform smaller edits or edit one section at a time.',
        },
      }
    }
    if (!args.path || typeof args.path !== 'string' || !args.path.trim()) {
      return {
        result: {
          status: 'error',
          error: "Parameter 'path' is required for edit_file.",
        },
      }
    }

    const doc = await this._resolveDoc(projectId, args.path)
    let docText = ''
    if (doc) {
      let lines = doc.lines || []
      try {
        const docObj = await this.docUpdater.getDocument(projectId, doc._id, -1)
        if (docObj?.lines) lines = docObj.lines
      } catch {}
      docText = lines.join('\n')
    }

    const strippedOld = cleanLineNumbers(args.oldText || '')
    const oldTextWasStripped =
      strippedOld !== args.oldText && strippedOld.length > 0
    const sanitizedNewText = cleanLineNumberPrefixes(
      args.newText || '',
      oldTextWasStripped
    )

    // Line-range mode: startLine..endLine name the block, so replacing or
    // deleting a long block does not require copying it into oldText. Copying
    // hundreds of lines verbatim takes minutes of generation with nothing on
    // the wire (gateways cut the stream) and rarely matches exactly. The run
    // loop re-executes with the resolved oldText, which equals the range text.
    // Some gateways send numeric arguments as strings.
    const lineArg = v =>
      typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')
        ? Number(v)
        : NaN
    const from = lineArg(args.startLine)
    const until = lineArg(args.endLine)
    if (Number.isInteger(from) && Number.isInteger(until)) {
      const docLines = docText.split('\n')
      const to = Math.min(until, docLines.length)
      const rangeText = doc
        ? docLines.slice(Math.max(0, from - 1), to).join('\n')
        : ''
      if (
        args.oldText === undefined ||
        args.oldText === null ||
        args.oldText === '' ||
        args.oldText === rangeText
      ) {
        if (!doc) {
          return {
            result: {
              status: 'error',
              error: `File not found: ${args.path}. Use list_files to see the project's paths.`,
            },
          }
        }
        // startLine one past the last line appends: the range is empty and
        // newText lands after the file's last line.
        if (from < 1 || until < from || from > docLines.length + 1) {
          return {
            result: {
              status: 'error',
              error: `Line range ${args.startLine}-${args.endLine} is outside ${doc.path}, which has ${docLines.length} lines. Use read_file to check the line numbers.`,
            },
          }
        }
        const rangeNewText = cleanLineNumberPrefixes(args.newText || '', false)
        const inserted = rangeNewText === '' ? [] : rangeNewText.split('\n')
        return {
          doc,
          lines: [
            ...docLines.slice(0, from - 1),
            ...inserted,
            ...docLines.slice(to),
          ],
          path: doc.path,
          oldText: rangeText,
          newText: rangeNewText,
          startLine: from,
          previousLineCount: docLines.length,
        }
      }
    }

    // Whole file replacement: only when oldText matches the full file or file is empty
    const isDocEmpty = !doc || docText.trim().length === 0
    const isFullFileReplace =
      (typeof args.oldText === 'string' &&
        args.oldText.trim().length > 0 &&
        normalizeLines(args.oldText).trim() ===
          normalizeLines(docText).trim()) ||
      (isDocEmpty && typeof args.oldText === 'string')

    if (isFullFileReplace && doc) {
      const updatedLines = sanitizedNewText.split('\n')
      return {
        doc,
        lines: updatedLines,
        path: doc.path,
        oldText: args.oldText,
        newText: sanitizedNewText,
        startLine: 1,
        previousLineCount: docText.split('\n').length,
      }
    }

    // Append mode: when oldText is explicitly empty string ""
    if (args.oldText === '' && doc) {
      const endLine = endDocumentLine(docText)
      if (endLine) {
        return {
          result: {
            status: 'error',
            error: `Appending to ${doc.path} would put the text after \\end{document} on line ${endLine}, where LaTeX ignores it. Insert it where it belongs instead: give an oldText anchor from the passage it follows, or startLine and endLine for the lines to replace.`,
          },
        }
      }
      const appended =
        docText.endsWith('\n') || docText.length === 0
          ? docText + sanitizedNewText
          : docText + '\n' + sanitizedNewText
      const startLine =
        appended.split('\n').length - sanitizedNewText.split('\n').length + 1
      return {
        doc,
        lines: appended.split('\n'),
        path: doc.path,
        oldText: '',
        newText: sanitizedNewText,
        startLine,
        previousLineCount: docText.split('\n').length,
      }
    }

    if (typeof args.oldText !== 'string') {
      return {
        result: {
          status: 'error',
          error: `Parameter 'oldText' is required to replace text in ${args.path}. Provide the exact snippet from the file to replace, or pass startLine and endLine to replace those lines.`,
        },
      }
    }

    const targetAnchor = args.oldText
    let resolvedDoc = doc
    let resolvedDocText = docText
    let searchDocText = resolvedDocText
    let searchLineOffset = 0

    // Constrain the search if startLine is given. Always the live text
    // (`docText`), never `doc.lines`: that is the stored copy, which lags
    // behind unsaved typing, while the match offset is applied to the live
    // text. `from`/`until` come from lineArg above, which accepts numbers sent
    // as strings.
    if (Number.isInteger(from) && from >= 1 && doc) {
      const docLines = docText.split('\n')
      const startIdx = from - 1
      const anchorLineCount = targetAnchor.split('\n').length
      const windowRadius = Math.max(2, anchorLineCount + 1)
      const hasEnd = Number.isInteger(until) && until >= from
      const localEndIdx = hasEnd
        ? until
        : Math.min(docLines.length, startIdx + windowRadius)
      const localSearchText = docLines.slice(startIdx, localEndIdx).join('\n')
      const localMatch = locateAnchorInText(localSearchText, targetAnchor)

      if (localMatch) {
        searchDocText = localSearchText
        searchLineOffset = startIdx
      } else {
        const endIdx = hasEnd ? until : docLines.length
        searchDocText = docLines.slice(startIdx, endIdx).join('\n')
        searchLineOffset = startIdx
      }
    }

    let targetMatch = doc
      ? locateAnchorInText(searchDocText, targetAnchor)
      : null

    // If scoped search didn't match, fall back to searching the full document
    if (!targetMatch && searchDocText !== resolvedDocText && doc) {
      targetMatch = locateAnchorInText(resolvedDocText, targetAnchor)
      searchLineOffset = 0
    }

    // Not in the named file: look in the other documents. Only an exact (or
    // line-number-cleaned) match may move the edit to another file; a fuzzy
    // match in a file the model never named is a guess. Candidates come from
    // the snapshot (one flush and one bulk read), and the chosen file is
    // confirmed against its live text before anything is planned on it.
    if (!targetMatch) {
      const isExact = match =>
        match && (match.type === 'exact' || match.type === 'cleaned')
      const snapshot = await this._getSnapshot(projectId)
      for (const other of snapshot.docs) {
        if (doc && String(other._id) === String(doc._id)) continue
        if (
          !isExact(
            locateAnchorInText((other.lines || []).join('\n'), targetAnchor)
          )
        )
          continue

        let liveText = (other.lines || []).join('\n')
        try {
          const fetched = await this.docUpdater.getDocument(
            projectId,
            other._id,
            -1
          )
          if (fetched?.lines) liveText = fetched.lines.join('\n')
        } catch {}
        const liveMatch = locateAnchorInText(liveText, targetAnchor)
        if (!isExact(liveMatch)) continue

        resolvedDoc = other
        resolvedDocText = liveText
        targetMatch = liveMatch
        searchLineOffset = 0
        break
      }
    }

    if (!targetMatch || !resolvedDoc) {
      if (resolvedDocText) {
        const cleanedOld = cleanOldText(targetAnchor)
        const checkAnchor =
          countOccurrences(resolvedDocText, cleanedOld) > 0
            ? cleanedOld
            : targetAnchor
        const matches = countOccurrences(resolvedDocText, checkAnchor)
        if (matches > 1) {
          const occurrences = findMatchingLines(resolvedDocText, checkAnchor)
          const contextPreviews =
            occurrences.length > 0
              ? `:\n${formatAmbiguousOccurrences(resolvedDocText, occurrences)}\n\nTo disambiguate, include unique surrounding text in oldText, or pass startLine to target a specific line (e.g. startLine: ${occurrences[0]}).`
              : '. Include more surrounding context lines or use startLine/endLine to disambiguate.'
          return {
            result: {
              status: 'ambiguous',
              matches,
              error: `That text appears ${matches} times in ${resolvedDoc.path} (around line(s) ${occurrences.join(', ')})${contextPreviews}`,
            },
          }
        }
      }
      const hints = resolvedDocText
        ? nearestLines(resolvedDocText, targetAnchor)
        : []
      const candidateLines = resolvedDocText
        ? findMatchingLines(resolvedDocText, targetAnchor)
        : []
      let candidateHint
      if (hints.length > 0) {
        candidateHint = ` The closest lines in ${args.path} right now are:\n${hints
          .map(h => `${h.line}: ${h.text}`)
          .join(
            '\n'
          )}\nCopy the anchor from those exact lines (without line-number prefixes), or call read_file on ${args.path} first.`
      } else if (candidateLines.length > 0) {
        candidateHint = ` (Found similar line around line(s) ${candidateLines.join(', ')}). Use read_file to inspect the file around those lines.`
      } else {
        candidateHint = ` Use read_file to inspect ${args.path} and copy the exact lines to replace.`
      }
      return {
        result: {
          status: 'noMatch',
          error: `Could not find target text in ${args.path}.${candidateHint} To replace or delete whole lines, pass startLine and endLine and omit oldText.`,
        },
      }
    }

    // Perform replacement
    let searchDocOffset = 0
    if (searchLineOffset > 0 && resolvedDocText) {
      const docLines = resolvedDocText.split('\n')
      for (let i = 0; i < searchLineOffset; i++) {
        searchDocOffset += (docLines[i] ? docLines[i].length : 0) + 1
      }
    }

    let replaced
    let matchStartOffset
    let resolvedOldText
    if (
      targetMatch.charStart !== undefined &&
      targetMatch.charEnd !== undefined
    ) {
      matchStartOffset = searchDocOffset + targetMatch.charStart
      const matchEndOffset = searchDocOffset + targetMatch.charEnd
      resolvedOldText = resolvedDocText.slice(matchStartOffset, matchEndOffset)
      replaced =
        resolvedDocText.slice(0, matchStartOffset) +
        sanitizedNewText +
        resolvedDocText.slice(matchEndOffset)
    } else {
      const matchedAnchor = targetMatch.anchor
      resolvedOldText = matchedAnchor
      matchStartOffset = resolvedDocText.indexOf(matchedAnchor, searchDocOffset)
      if (matchStartOffset === -1) {
        matchStartOffset = resolvedDocText.indexOf(matchedAnchor)
      }
      if (matchStartOffset !== -1) {
        replaced =
          resolvedDocText.slice(0, matchStartOffset) +
          sanitizedNewText +
          resolvedDocText.slice(matchStartOffset + matchedAnchor.length)
      } else {
        const normDoc = normalizeLines(resolvedDocText)
        const normAnchor = normalizeLines(matchedAnchor)
        matchStartOffset = Math.max(0, normDoc.indexOf(normAnchor))
        replaced = normDoc.replace(normAnchor, sanitizedNewText)
      }
    }
    const startLine = resolvedDocText
      .slice(0, Math.max(0, matchStartOffset))
      .split('\n').length

    const note =
      doc && resolvedDoc.path !== doc.path
        ? `Text was located in '${resolvedDoc.path}' (redirected from '${args.path}').`
        : undefined
    return {
      doc: resolvedDoc,
      lines: replaced.split('\n'),
      path: resolvedDoc.path,
      note,
      oldText: resolvedOldText,
      newText: sanitizedNewText,
      startLine,
      previousLineCount: resolvedDocText.split('\n').length,
    }
  }

  /**
   * Works out what an edit_file call would show and write, without writing
   * it. `oldText`/`newText` here are the resolved anchor actually matched in
   * the document (after fuzzy/whitespace-tolerant matching), not the model's
   * raw, possibly-imprecise quote — the run loop shows these to the user as
   * the approval diff, so the diff matches what execute() will really apply.
   */
  async checkEdit(args = {}, { projectId }) {
    const traversal = this._traversalError(args)
    if (traversal) return { status: 'error', error: traversal }
    const plan = await this._planEdit(projectId, args)
    if (plan.result) return plan.result
    return {
      status: 'ok',
      path: plan.path,
      oldText: plan.oldText,
      newText: plan.newText,
      startLine: plan.startLine,
    }
  }

  _traversalError(args) {
    if (args?.path && typeof args.path === 'string') {
      const normalized = args.path.replace(/\\/g, '/').replace(/^\/+/, '')
      if (
        normalized.startsWith('../') ||
        normalized.includes('/../') ||
        normalized === '..'
      ) {
        return 'Path traversal forbidden: file path cannot reference parent directories.'
      }
    }
    return null
  }

  /**
   * Records a compile as the project's last one and phrases it for the model,
   * whether the editor or the server ran it.
   */
  async _compileToolResult(projectId, outcome, clean) {
    const errors = Array.isArray(outcome.errors) ? outcome.errors : []
    const warnings = Array.isArray(outcome.warnings) ? outcome.warnings : []
    const build = compiledBuild(outcome)
    const pdfProduced = build.buildId !== null

    // What the build was made from, so a later view can tell whether the
    // project has changed since (BuildFingerprint.mjs).
    const fingerprint = pdfProduced
      ? await this._projectFingerprint(projectId).catch(() => null)
      : null
    const status = withErrorsStatus(
      outcome.status || 'failure',
      errors.length,
      pdfProduced
    )
    const previous = this.lastCompileResult.get(String(projectId))
    const previousErrors = previous?.errors || []
    // The build before this one, kept for diff_compiled_pdf
    const previousBuild = previous?.buildId
      ? {
          previousBuildId: previous.buildId,
          previousClsiServerId: previous.clsiServerId ?? null,
        }
      : {}

    this._rememberCompile(projectId, {
      status,
      errors,
      warnings,
      ...build,
      ...(build.buildId ? previousBuild : {}),
      at: Date.now(),
      ...(fingerprint ? { fingerprint } : {}),
    })

    const delta = computeErrorDelta(errors, previousErrors)
    const primaryError = errors.length > 0 ? errors[0] : null
    const cascadingErrorsCount = Math.max(0, errors.length - 1)

    let message
    if (status === 'skipped') {
      message =
        'No compile ran: another build was still in progress and did not finish in time. Try again.'
    } else if (status === 'timedout') {
      message =
        'The compile timed out. Call compile_project with clean set to true to clear the cached build and rebuild from scratch.'
    } else if (status === 'no-output') {
      message =
        'The compile produced no parsable output. Call compile_project with clean set to true to clear the cached build and rebuild from scratch.'
    } else if (errors.length === 0 && status !== 'success') {
      message = `The build ended as "${status}" with no errors in the log. Nothing was verified.`
    } else if (errors.length === 0) {
      message =
        warnings.length > 0
          ? `The project compiled with 0 errors and ${warnings.length} warning(s).`
          : 'The project compiled without errors.'
    } else if (status === 'success_with_errors') {
      message = `The project has ${errors.length} error(s), but LaTeX still wrote a PDF, so the pages can be viewed: parts after an error may be missing or misplaced. Fix the errors first, then compile again.`
    } else if (previous && delta.regressed) {
      message = `WARNING: Compilation worsened. Error count changed by ${delta.countDelta >= 0 ? `+${delta.countDelta}` : delta.countDelta} (${delta.newErrorsCount} new error(s) introduced, ${delta.resolvedErrorsCount} resolved). Recent edits likely introduced invalid LaTeX syntax. Focus on fixing the primary error first.`
    } else if (previous && delta.resolvedErrorsCount > 0) {
      message = `The project compiled with ${errors.length} error(s) (${delta.resolvedErrorsCount} error(s) resolved).`
    } else {
      message = `The project compiled with ${errors.length} error(s) and ${warnings.length} warning(s).`
    }

    const maxReported = 20
    return {
      status,
      clean,
      pdfProduced,
      buildId: build.buildId,
      errorCount: errors.length,
      warningCount: warnings.length,
      errorDelta: previous ? delta.countDelta : 0,
      newErrorsCount: previous ? delta.newErrorsCount : errors.length,
      resolvedErrorsCount: previous ? delta.resolvedErrorsCount : 0,
      regressed: previous ? delta.regressed : false,
      primaryError,
      cascadingErrorsCount,
      errors: errors.slice(0, maxReported),
      warnings: warnings.slice(0, maxReported),
      message,
      ...(build.buildId && errors.length === 0
        ? { visualCheck: this._visualCheckHint(projectId) }
        : {}),
    }
  }

  /**
   * What a clean build still leaves unchecked, and the call that checks it.
   * The log cannot see an overflowing table or overlapping arrows; the page
   * can, and naming the page of the last edit saves the model a lookup.
   */
  _visualCheckHint(projectId) {
    const edit = this._lastEdits.get(String(projectId))
    const check =
      'A PDF was built, but 0 errors does not mean it looks right. If your edits change what a page shows (tables, figures, TikZ, math, page breaks), look before you reply: '
    if (!edit) {
      return `${check}view_compiled_pdf_page with page, or with path and line, for the page your change affects; view_compiled_pdf_overview with fromPage 1 for the layout across pages.`
    }
    return `${check}view_compiled_pdf_page with path "${edit.path}", line ${edit.line}, endLine ${edit.endLine} zooms on your last edit; view_compiled_pdf_overview shows how the pages break and where floats landed.`
  }

  /**
   * The checks the three PDF tools share, run before `run` looks at the
   * build. The last compile must have written a PDF, and the result says when
   * the project has changed since that build (stale) and when the model
   * cannot take the image (imageOmitted). A tool with no image passes no
   * `withImage`, and then gets neither flag from it. `run` gets the build's
   * ids and the last edit, and returns the tool's own fields.
   */
  async _withCompiledPdf(projectId, userId, { withImage }, run) {
    const key = String(projectId)
    const compile = this.lastCompileResult.get(key)
    if (!compile) {
      return {
        error:
          'No compile has run in this chat yet. Call compile_project, then look at the PDF.',
      }
    }
    if (!compile.buildId) {
      return {
        error: `The last compile produced no PDF (status "${compile.status}", ${compile.errors.length} error(s)). Fix the errors, call compile_project, then look at the PDF.`,
      }
    }

    const edit = this._lastEdits.get(key)
    let rootDocPath = null
    let buildStale = null
    try {
      const current = await this._projectFingerprint(projectId)
      rootDocPath = current.rootDocPath
      buildStale = diffFingerprints(compile.fingerprint, current)
    } catch {
      // log paths then resolve from the project root; without a fingerprint
      // the build is taken as current
    }
    const build = {
      projectId,
      userId,
      buildId: compile.buildId,
      clsiServerId: compile.clsiServerId,
      rootDocPath,
    }

    let result
    try {
      result = await run(build, edit)
    } catch (err) {
      if (err instanceof PdfPageError) {
        return { error: err.message, ...(err.details || {}) }
      }
      throw err
    }

    return {
      status: 'ok',
      ...result,
      // Edited since the build: the picture predates those edits.
      ...(edit && compile.at && edit.at > compile.at ? { stale: true } : {}),
      ...(buildStale ? { buildStale } : {}),
      ...(withImage === false ? { imageOmitted: true } : {}),
    }
  }

  /**
   * One page of the last compile's PDF, for the model to look at: the page
   * asked for, the page a source line is typeset on, or else the page of the
   * last edit. The image travels in the result and the run loop moves it onto
   * the provider message, so it is never stored with the transcript.
   */
  async _viewCompiledPdfPage(
    projectId,
    userId,
    args,
    { withImage, imageProvider = null }
  ) {
    const target = parsePdfPageArgs(args)
    if (target.error) return { error: target.error }

    return this._withCompiledPdf(projectId, userId, { withImage }, async (pdf, edit) => {
      let chosenBy = 'default'
      let where = { page: 1 }
      if (target.block !== null) {
        // A label from the margin: zoom on the source lines it typesets
        const block = resolveBlock({
          buildId: pdf.buildId,
          page: target.page,
          blockId: target.block,
        })
        if (!block) {
          throw new PdfPageError(
            'block_not_found',
            `No block ${target.block} on page ${target.page} of this build. View that page with its labels first, then use the label on it.`
          )
        }
        chosenBy = 'block'
        where = {
          path: block.path,
          line: block.line,
          endLine: block.endLine ?? block.line,
        }
      } else if (target.page !== null) {
        chosenBy = 'page'
        where = { page: target.page }
      } else if (target.path) {
        chosenBy = 'line'
        where = {
          path: target.path,
          line: target.line,
          ...(target.endLine !== null ? { endLine: target.endLine } : {}),
        }
      } else if (edit) {
        chosenBy = 'lastEdit'
        where = { path: edit.path, line: edit.line }
      }

      // region only when the model gave one: with endLine, the inspector
      // zooms on that block unless a region says otherwise.
      // Text pages go grayscale and small enough for the provider's own limit;
      // a figure or colour in the source keeps colour (AiAssistImagePolicy).
      const color = await this._pageNeedsColor(projectId, target, edit, where)
      const imageChoice = imagePolicyFor({
        type: imageProvider?.provider,
        model: imageProvider?.model,
        color,
      })
      const inspect = at =>
        this.pdfPageInspector.inspect({
          ...pdf,
          ...(target.region ? { region: target.region } : {}),
          withImage,
          ...inspectOptionsFor(imageChoice),
          ...(target.labels ? { labels: true } : {}),
          defects: true,
          ...at,
        })

      let inspected
      let note
      try {
        inspected = await inspect(where)
      } catch (err) {
        // A call without arguments should not fail because the last edit was
        // in the preamble, which typesets nothing: show the first page.
        if (
          chosenBy !== 'lastEdit' ||
          err?.code !== PDF_PAGE_ERRORS.LINE_NOT_IN_PDF
        ) {
          throw err
        }
        note = `Your last edit (${edit.path} line ${edit.line}) is not typeset on any page, so page 1 is shown.`
        chosenBy = 'default'
        inspected = await inspect({ page: 1 })
      }

      return {
        chosenBy,
        ...inspected,
        ...(note ? { note } : {}),
      }
    })
  }

  /**
   * Whether the source a page view shows is a figure, TikZ or coloured text:
   * the lines of a zoom, or else the start of the block the page is at.
   */
  async _pageNeedsColor(projectId, target, edit, where) {
    const path = where.path ?? edit?.path ?? null
    const line = where.line ?? edit?.line ?? null
    if (!path || !line) return false
    let docText = null
    try {
      docText = (await this._getSnapshot(projectId)).docTexts?.[path]
    } catch {
      return false
    }
    if (typeof docText !== 'string') return false
    const lines = docText.split('\n')
    const end = Math.max(line, where.endLine ?? line)
    return wantsColor(lines.slice(line - 1, end).join('\n'))
  }

  /** The source of one labelled block on a page the model has viewed. */
  async _resolvePdfBlock(projectId, args) {
    const blockId = typeof args.block === 'string' ? args.block.trim() : ''
    if (!/^B\d+$/i.test(blockId)) {
      return { error: 'block must be a label from the PDF view, such as "B3".' }
    }
    const page = optionalNumber(args.page)
    if (!isWholeNumberFrom(page, 1)) {
      return {
        error:
          'page must be the page the block label was shown on, a whole number from 1.',
      }
    }
    const compile = this.lastCompileResult.get(String(projectId))
    if (!compile?.buildId) {
      return {
        error: 'There is no compiled PDF to resolve a block in. Call compile_project first.',
      }
    }
    const where = resolveBlock({
      buildId: compile.buildId,
      page,
      blockId,
    })
    if (!where) {
      return {
        error: `No block ${blockId.toUpperCase()} on page ${page} of this build. View that page first, so its labels exist.`,
      }
    }
    return {
      status: 'ok',
      block: blockId.toUpperCase(),
      page,
      ...where,
    }
  }

  /**
   * What changed between the build before the last compile and the last
   * compile, page by page. The annotated after-picture goes to the model; the
   * highlights go on the result for the viewer to draw (PDF points).
   */
  async _diffCompiledPdf(projectId, userId, args) {
    const compile = this.lastCompileResult.get(String(projectId))
    if (!compile?.buildId) {
      return {
        error: 'There is no compiled PDF to compare. Call compile_project first.',
      }
    }
    if (!compile.previousBuildId) {
      return {
        error:
          'There is no earlier build to compare with yet. Make the change, compile, then compare.',
      }
    }
    const pages = Array.isArray(args.pages)
      ? args.pages
          .map(Number)
          .filter(page => Number.isInteger(page) && page >= 1)
          .slice(0, 20)
      : []
    let outcome
    try {
      outcome = await this.pdfVisualDiff.diff({
        projectId,
        userId,
        beforeBuildId: compile.previousBuildId,
        afterBuildId: compile.buildId,
        clsiServerId: compile.clsiServerId ?? undefined,
        beforeClsiServerId: compile.previousClsiServerId ?? undefined,
        ...(pages.length > 0 ? { pages } : {}),
      })
    } catch (err) {
      return { error: err.message || 'The two builds could not be compared.' }
    }
    if (!outcome?.ok) {
      return {
        error: outcome?.message || 'The two builds could not be compared.',
      }
    }
    const { image, ...rest } = outcome
    return {
      status: 'ok',
      ...rest,
      ...(image
        ? {
            image: {
              mediaType: image.mimeType,
              data: image.data,
              width: image.width,
              height: image.height,
              pages: image.pages,
            },
          }
        : {}),
    }
  }

  /**
   * The typographic style the compiled PDF actually produced, extracted from
   * output.pdf and output.log, and optionally compared against another build.
   */
  async _inspectCompiledStyle(projectId, userId, args) {
    const compile = this.lastCompileResult.get(String(projectId))
    if (!compile?.buildId) {
      return {
        error:
          'There is no compiled PDF to inspect style for. Call compile_project first.',
      }
    }

    let preambleText = ''
    let documentClass = null
    try {
      const snapshot = await this._getSnapshot(projectId)
      const index = await this._getIndex(projectId)
      documentClass = index.outline?.documentClass ?? null
      if (snapshot.rootPath && snapshot.docTexts?.[snapshot.rootPath]) {
        const rootContent = snapshot.docTexts[snapshot.rootPath]
        const beginDocIdx = rootContent.indexOf('\\begin{document}')
        preambleText =
          beginDocIdx !== -1 ? rootContent.slice(0, beginDocIdx) : rootContent
      }
    } catch {
      // Best-effort extraction of preamble and documentClass
    }

    try {
      const inspect = this.pdfStyleInspector.inspect
      const outcome = await inspect({
        projectId,
        userId,
        buildId: compile.buildId,
        clsiServerId: compile.clsiServerId ?? undefined,
        preambleText,
        documentClass,
        ...(args?.againstBuildId
          ? {
              against: {
                buildId: args.againstBuildId,
                clsiServerId: args.againstClsiServerId ?? compile.clsiServerId,
              },
            }
          : {}),
      })
      return {
        status: 'ok',
        ...outcome,
      }
    } catch (err) {
      return {
        error: err.message || 'Could not inspect compiled style.',
      }
    }
  }

  /**
   * Keeps the PDF of a finished build for a later diff_compiled_pdf. Runs in
   * the background; a failure only means the diff is unavailable for that
   * build.
   */
  _rememberBuildForDiff(projectId, userId, buildId, clsiServerId) {
    if (!buildId) return
    this.pdfVisualDiff.remember({
      projectId,
      userId,
      buildId,
      clsiServerId: clsiServerId ?? undefined,
    }).catch(() => {})
  }

  async _viewCompiledPdfOverview(projectId, userId, args, { withImage }) {
    const range = parsePdfPageRange(args)
    if (range.error) return { error: range.error }

    return this._withCompiledPdf(projectId, userId, { withImage }, async pdf =>
      this.pdfPageInspector.overview({
        ...pdf,
        fromPage: range.fromPage ?? 1,
        ...(range.toPage !== null ? { toPage: range.toPage } : {}),
        withImage,
      })
    )
  }

  async _searchCompiledPdf(projectId, userId, args) {
    // A bare number is a fine query ("2024"), so it is taken as its text.
    const raw =
      typeof args.query === 'number' && Number.isFinite(args.query)
        ? String(args.query)
        : args.query
    const query = typeof raw === 'string' ? raw.trim() : ''
    if (!query || query.length > MAX_PDF_QUERY_CHARS) {
      return {
        error: `query must be the text to find in the PDF, from 1 to ${MAX_PDF_QUERY_CHARS} characters. It is plain text, not a regular expression.`,
      }
    }
    const range = parsePdfPageRange(args)
    if (range.error) return { error: range.error }

    return this._withCompiledPdf(projectId, userId, {}, async pdf =>
      this.pdfPageInspector.search({
        ...pdf,
        query,
        ...(range.fromPage !== null ? { fromPage: range.fromPage } : {}),
        ...(range.toPage !== null ? { toPage: range.toPage } : {}),
      })
    )
  }

  /**
   * Points the user's viewer at a place: a source range, found through SyncTeX
   * in the last build, or boxes the model gives. The viewer draws the boxes
   * from the result's `highlights`, so the change is only on screen.
   */
  async _highlightInPdf(projectId, userId, args) {
    // A null boxes is no boxes: the model sent a source range
    if (args.boxes !== undefined && args.boxes !== null) {
      const boxes = parsePdfBoxes(args.boxes)
      if (!boxes) {
        return {
          error:
            'boxes must be a non-empty list of {page, h, v, width, height}.',
        }
      }
      return highlightResult(boxes)
    }
    const target = parsePdfSourceRange(args)
    if (target.error) return { error: target.error }

    return this._withCompiledPdf(projectId, userId, {}, async pdf => {
      const boxes = await this.pdfPageInspector.highlight({
        ...pdf,
        path: target.path,
        line: target.line,
        endLine: target.endLine,
      })
      return highlightResult(boxes)
    })
  }

  async execute(
    name,
    args = {},
    {
      projectId,
      userId: rawUserId,
      callId,
      compileInEditor,
      images = true,
      imageProvider = null,
    }
  ) {
    const userId = await this._resolveValidUserId(projectId, rawUserId)
    if (!userId) {
      return {
        error:
          'A valid authenticated user context is required to execute tools.',
      }
    }

    // Path sanitization for file operations
    const traversal = this._traversalError(args)
    if (traversal) return { error: traversal }

    switch (name) {
      case 'read_file': {
        const doc = await this._resolveDoc(projectId, args.path)
        if (!doc) {
          const wanted = String(args.path || '').replace(/^\//, '')
          const files = await this._getFilesList(projectId).catch(() => [])
          if (files.some(file => file.path === wanted)) {
            return {
              error: `${wanted} is a binary file and cannot be read as text.`,
            }
          }
          const baseName = wanted.split('/').pop()
          const candidates = (
            await this._getDocsList(projectId).catch(() => [])
          )
            .map(d => d.path)
            .filter(
              path => path !== wanted && path.split('/').pop() === baseName
            )
          if (candidates.length > 1) {
            return {
              error: `File not found: ${args.path}. Did you mean ${candidates.join(' or ')}?`,
            }
          }
          return { error: `File not found: ${args.path}` }
        }
        let lines = doc.lines || []
        try {
          // The live document, not the snapshot: the user may be typing.
          const fetched = await this.docUpdater.getDocument(
            projectId,
            doc._id,
            -1
          )
          if (fetched?.lines) lines = fetched.lines
        } catch {
          // keep fallback lines
        }
        const totalLines = lines.length
        const hasRange = Number(args.from) > 0 || Number(args.to) > 0
        const windowSize = hasRange ? MAX_READ_LINES : DEFAULT_READ_LINES
        const start = Math.max(
          1,
          Math.min(Number(args.from) || 1, totalLines || 1)
        )
        const requestedEnd = Math.min(Number(args.to) || totalLines, totalLines)
        const capped = lines.slice(start - 1, requestedEnd).slice(0, windowSize)
        const end = start + capped.length - 1
        const nextRange =
          end < totalLines
            ? { from: end + 1, to: Math.min(end + windowSize, totalLines) }
            : undefined
        return {
          path: args.path,
          from: start,
          to: end,
          totalLines,
          content: capped.map((line, i) => `${start + i}: ${line}`).join('\n'),
          truncated: Boolean(nextRange),
          ...(nextRange ? { nextRange } : {}),
        }
      }

      case 'search_text':
      case 'search_project': {
        if (typeof args.query !== 'string' || args.query === '') {
          return { error: "Parameter 'query' is required for search_text." }
        }
        const snapshot = await this._getSnapshot(projectId)
        const pattern =
          typeof args.glob === 'string' && args.glob
            ? args.glob
            : typeof args.path === 'string' && args.path
              ? args.path
              : null
        const docs = pattern
          ? snapshot.docs.filter(doc => matchesGlob(doc.path, pattern))
          : snapshot.docs
        const contextLines = Number.isFinite(Number(args.contextLines))
          ? Math.max(0, Math.floor(Number(args.contextLines)))
          : 1

        let found
        if (args.regexp) {
          try {
            found = await regexSearch({
              query: args.query,
              caseSensitive: Boolean(args.caseSensitive),
              docs,
              limit: MAX_SEARCH_HITS,
            })
          } catch (err) {
            if (err.code === 'regexTimeout') return { error: err.message }
            // A SyntaxError message already reads "Invalid regular expression: /(/i: …".
            return {
              error:
                err instanceof SyntaxError
                  ? err.message
                  : `Invalid regular expression: ${err.message}`,
            }
          }
        } else {
          const needle = args.caseSensitive
            ? args.query
            : args.query.toLowerCase()
          const hits = []
          let total = 0
          for (const doc of docs) {
            const lines = doc.lines || []
            for (let i = 0; i < lines.length; i++) {
              const haystack = args.caseSensitive
                ? lines[i]
                : lines[i].toLowerCase()
              if (haystack.includes(needle)) {
                total++
                if (hits.length < MAX_SEARCH_HITS)
                  hits.push({ path: doc.path, line: i + 1 })
              }
            }
          }
          found = { hits, total }
        }

        const byPath = new Map(docs.map(doc => [doc.path, doc.lines || []]))
        return {
          hits: found.hits.map(({ path, line }) => {
            const lines = byPath.get(path) || []
            return {
              path,
              line,
              text: lines[line - 1] ?? '',
              ...(contextLines > 0
                ? {
                    before: lines.slice(
                      Math.max(0, line - 1 - contextLines),
                      line - 1
                    ),
                    after: lines.slice(line, line + contextLines),
                  }
                : {}),
            }
          }),
          total: found.total,
          truncated: found.total > found.hits.length,
        }
      }

      case 'list_files':
      case 'project_map': {
        const snapshot = await this._getSnapshot(projectId)
        const all = [
          ...snapshot.docs.map(doc => ({
            path: doc.path,
            type: 'doc',
            lines: (doc.lines || []).length,
          })),
          ...snapshot.files.map(file => ({ path: file.path, type: 'binary' })),
        ].sort((a, b) => a.path.localeCompare(b.path))
        const listed =
          typeof args.glob === 'string' && args.glob
            ? all.filter(file => matchesGlob(file.path, args.glob))
            : all
        const shown = listed.slice(0, MAX_FILE_ROWS)
        return {
          files: shown,
          total: listed.length,
          truncated: listed.length > shown.length,
        }
      }

      case 'edit_file': {
        const plan = await this._planEdit(projectId, args)
        if (plan.result) return plan.result
        await this.docUpdater.setDocument(
          projectId,
          plan.doc._id,
          userId,
          plan.lines,
          'ai-assist'
        )
        this.invalidateSnapshot(projectId)
        const newLines = plan.newText ? plan.newText.split('\n').length : 1
        this._rememberEdit(
          projectId,
          plan.path,
          plan.startLine,
          plan.startLine + newLines - 1
        )
        return {
          status: 'applied',
          path: plan.path,
          newText: plan.newText,
          oldText: plan.oldText,
          ...describeAppliedEdit(plan),
          ...(plan.note ? { note: plan.note } : {}),
        }
      }

      case 'create_file': {
        const lines = (args.content || '').split('\n')
        const normalizedPath = (args.path || '').replace(/^\//, '')
        const created = docId => {
          this._rememberEdit(projectId, normalizedPath, 1, lines.length)
          return {
            status: 'applied',
            path: args.path,
            docId,
            newText: args.content,
            startLine: 1,
            endLine: lines.length,
          }
        }

        if (this.editorController?.promises?.upsertDocWithPath) {
          try {
            const doc = await this.editorController.promises.upsertDocWithPath(
              projectId,
              normalizedPath,
              lines,
              'ai-assist',
              userId
            )
            this.invalidateSnapshot(projectId)
            return created(doc?._id)
          } catch (err) {
            // fall through to addDoc
          }
        }

        const rootFolderId =
          (await this._getRootFolderId(projectId)) || 'root-folder'
        return new Promise((resolve, reject) => {
          this.editorController.addDoc(
            projectId,
            rootFolderId,
            normalizedPath,
            lines,
            'ai-assist',
            userId,
            (err, newDoc) => {
              if (err) return reject(err)
              this.invalidateSnapshot(projectId)
              resolve(created(newDoc?._id))
            }
          )
        })
      }

      case 'compile_project': {
        const clean = wantsCleanCompile(args)

        // With the project open in the editor, the editor compiles: it waits for
        // a build the user or auto-compile already started, shows progress in
        // the PDF pane, and never races a second CLSI compile for the same
        // project ("another compile is in progress"). Its outcome is null when
        // no editor is watching the run, and only then does the server compile.
        const editorOutcome = compileInEditor
          ? await compileInEditor({ id: callId, clean })
          : null
        if (editorOutcome) {
          this._rememberBuildForDiff(
            projectId,
            userId,
            compiledBuild(editorOutcome).buildId,
            compiledBuild(editorOutcome).clsiServerId
          )
          return await this._compileToolResult(projectId, editorOutcome, clean)
        }

        if (clean && this.compileManager?.deleteAuxFiles) {
          // Clears the CLSI build directory, the clsi-cache entry, the
          // doc-updater project state and the pinned CLSI server, which is what
          // makes the next build a full one instead of an incremental one over
          // stale .aux/.fls files. Not worth abandoning the compile over: the
          // incremental build may still succeed.
          try {
            await this.compileManager.deleteAuxFiles(projectId, userId, null)
          } catch {
            // ignore, the compile below still runs
          }
        }

        const result = await this.compileManager.compile(projectId, userId, {})
        let errors = []
        let warnings = []

        const logFile = (result.outputFiles || []).find(
          f => f.path === 'output.log' || f.path?.endsWith('.log')
        )
        if (
          logFile &&
          result.buildId &&
          this.clsiManager?.getOutputFileStream
        ) {
          try {
            const stream = await this.clsiManager.getOutputFileStream(
              projectId,
              userId,
              result.clsiServerId,
              result.buildId,
              logFile.path
            )
            const chunks = []
            for await (const chunk of stream) chunks.push(chunk)
            const rawLog = Buffer.concat(chunks).toString('utf8')
            const parsed = LatexLogParser.parse(rawLog, {
              ignoreDuplicates: true,
            })
            errors = (parsed.errors || []).map(e => {
              const summary = {
                file: e.file || null,
                line:
                  typeof e.line === 'number'
                    ? e.line
                    : parseInt(e.line, 10) || null,
                message: e.message || '',
              }
              const excerpt = errorExcerpt(e)
              if (excerpt) summary.excerpt = excerpt
              return summary
            })
            warnings = (parsed.warnings || []).map(w => ({
              file: w.file || null,
              line:
                typeof w.line === 'number'
                  ? w.line
                  : parseInt(w.line, 10) || null,
              message: w.message || '',
            }))
          } catch (err) {
            // Log fetch failure is non-fatal
          }
        }

        const compileStatus =
          errors.length > 0
            ? 'failure'
            : result.status === 'success'
              ? 'success'
              : result.status
        const wrotePdf = (result.outputFiles || []).some(
          f => f.path === 'output.pdf'
        )
        if (wrotePdf) {
          this._rememberBuildForDiff(
            projectId,
            userId,
            result.buildId,
            result.clsiServerId
          )
        }
        return await this._compileToolResult(
          projectId,
          {
            status: compileStatus,
            errors,
            warnings,
            ...(wrotePdf
              ? { buildId: result.buildId, clsiServerId: result.clsiServerId }
              : {}),
          },
          clean
        )
      }

      case 'get_compile_result':
      case 'get_compile_log': {
        // Reads only. Compiling here would make a "read" slow, and reads can
        // run in parallel with each other.
        const compile = this.lastCompileResult.get(String(projectId))
        if (!compile) {
          return {
            status: 'none',
            message:
              'No compile has run in this chat yet. Call compile_project to build the project.',
          }
        }

        const severity = args.severity || 'all'
        const requestedLimit = Number(args.limit || args.maxEntries)
        const limit = requestedLimit > 0 ? Math.floor(requestedLimit) : 20
        const includeRaw =
          args.includeRaw !== false && args.includeRaw !== 'false'

        const errors = compile.errors.slice(0, limit).map(entry => {
          if (includeRaw || !entry.excerpt) return entry
          const copy = { ...entry }
          delete copy.excerpt
          return copy
        })
        const warnings = compile.warnings.slice(0, limit)

        const outcome = {
          status: compile.status,
          pdfProduced: compile.buildId != null,
          buildId: compile.buildId ?? null,
          errorCount: compile.errors.length,
          warningCount: compile.warnings.length,
          primaryError: errors.length > 0 ? errors[0] : null,
          cascadingErrorsCount: Math.max(0, compile.errors.length - 1),
          truncated:
            compile.errors.length > limit || compile.warnings.length > limit,
        }

        if (severity === 'all' || severity === 'errors') {
          outcome.errors = errors
        }
        if (severity === 'all' || severity === 'warnings') {
          outcome.warnings = warnings
        }

        return outcome
      }

      case 'view_compiled_pdf_page':
        return this._viewCompiledPdfPage(projectId, userId, args, {
          withImage: images !== false,
          imageProvider,
        })

      case 'view_compiled_pdf_overview':
        return this._viewCompiledPdfOverview(projectId, userId, args, {
          withImage: images !== false,
        })

      case 'search_compiled_pdf':
        return this._searchCompiledPdf(projectId, userId, args)

      case 'resolve_pdf_block':
        return this._resolvePdfBlock(projectId, args)

      case 'diff_compiled_pdf':
        return this._diffCompiledPdf(projectId, userId, args)

      case 'inspect_compiled_style':
        return this._inspectCompiledStyle(projectId, userId, args)

      case 'highlight_in_pdf':
        return this._highlightInPdf(projectId, userId, args)

      case 'get_outline': {
        const index = await this._getIndex(projectId)
        const section = typeof args.section === 'string' ? args.section : ''

        if (!section) {
          return {
            documentClass: index.outline.documentClass,
            sections: index.outline.sections,
            includes: index.outline.includes,
            notes: index.outline.notes,
          }
        }

        const match = matchSection(index.outline, section)
        if (match.kind === 'none') {
          return {
            error: `No section matches "${section}".`,
            candidates: index.outline.sections.map(s => s.title),
          }
        }
        if (match.kind === 'ambiguous') {
          return {
            error: `"${section}" matches more than one section. Pick one.`,
            candidates: match.candidates.map(c => ({
              title: c.title,
              path: c.path,
              line: c.line,
            })),
          }
        }
        const target = match.section
        const siblings = index.outline.sections
        const startIndex = siblings.indexOf(target)
        const nextPeer = siblings
          .slice(startIndex + 1)
          .find(candidate => candidate.level <= target.level)
        const nextPeerInFile = siblings
          .slice(startIndex + 1)
          .find(
            candidate =>
              candidate.path === target.path && candidate.level <= target.level
          )
        const end = nextPeerInFile
          ? nextPeerInFile.line - 1
          : Number.MAX_SAFE_INTEGER
        const nextIndex = nextPeer
          ? siblings.indexOf(nextPeer)
          : siblings.length
        return {
          range: { from: target.line, to: end },
          sections: siblings.slice(startIndex, nextIndex),
          hint: `read_file with path=${target.path} from=${target.line} to=${
            end === Number.MAX_SAFE_INTEGER ? 'end' : end
          } for the body`,
        }
      }

      case 'get_packages': {
        const index = await this._getIndex(projectId)
        return {
          documentClass: index.outline.documentClass,
          packages: index.packages,
        }
      }

      case 'get_references': {
        const index = await this._getIndex(projectId)
        const refs = index.references
        const kind = typeof args.kind === 'string' ? args.kind : 'all'
        const pick =
          {
            labels: {
              labels: refs.labels,
              duplicateLabels: refs.duplicateLabels,
            },
            refs: { refs: refs.refs },
            citations: { citations: refs.citations, bibKeys: refs.bibKeys },
            all: refs,
          }[kind] ?? refs

        if (!args.unresolvedOnly) return pick

        const filterUnresolved = uses => uses.filter(use => !use.resolved)
        return {
          ...('refs' in pick ? { refs: filterUnresolved(pick.refs) } : {}),
          ...('citations' in pick
            ? { citations: filterUnresolved(pick.citations) }
            : {}),
          ...('labels' in pick
            ? { labels: pick.labels, duplicateLabels: pick.duplicateLabels }
            : {}),
          ...('bibKeys' in pick ? { bibKeys: pick.bibKeys } : {}),
        }
      }

      case 'get_project_settings': {
        const project = await this.projectGetter.getProject(projectId, {
          compiler: 1,
          imageName: 1,
          rootDoc_id: 1,
          draft: 1,
          stopOnFirstError: 1,
          spellCheckLanguage: 1,
          name: 1,
          description: 1,
        })
        if (!project) return { error: 'Project not found' }

        let rootDocPath = null
        try {
          const allDocs = await this._getDocsList(projectId)
          if (project.rootDoc_id) {
            const root = allDocs.find(
              d => String(d._id) === String(project.rootDoc_id)
            )
            if (root) rootDocPath = root.path
          }
        } catch {}

        let user = null
        if (userId) {
          try {
            user = await this.userModel.findById(userId).select('ace').exec()
          } catch {}
        }
        const ace = user?.ace || {}

        return {
          status: 'ok',
          settings: {
            compiler: {
              compiler: project.compiler || 'pdflatex',
              imageName: project.imageName || null,
              rootDocId: project.rootDoc_id ? String(project.rootDoc_id) : null,
              rootDocPath,
              draft: Boolean(project.draft),
              stopOnFirstError: Boolean(project.stopOnFirstError),
            },
            appearance: {
              overallTheme:
                ace.overallTheme === ''
                  ? 'dark'
                  : ace.overallTheme === 'light-'
                    ? 'light'
                    : ace.overallTheme || 'system',
              editorTheme: ace.theme || 'textmate',
              editorLightTheme: ace.lightTheme || 'textmate',
              editorDarkTheme: ace.darkTheme || 'overleaf_dark',
              darkModePdf: ace.darkModePdf ?? false,
              fontSize: ace.fontSize != null ? Number(ace.fontSize) : 12,
              fontFamily: ace.fontFamily || null,
              lineHeight: ace.lineHeight || null,
            },
            editor: {
              mode: ace.mode || 'none',
              autoComplete: ace.autoComplete ?? true,
              autoPairDelimiters: ace.autoPairDelimiters ?? true,
              syntaxValidation: ace.syntaxValidation ?? true,
              pdfViewer: ace.pdfViewer || 'pdfjs',
              mathPreview: ace.mathPreview ?? true,
              breadcrumbs: ace.breadcrumbs ?? true,
              editorTabs: ace.editorTabs ?? true,
              spellCheckLanguage: ace.spellCheckLanguage || 'en',
            },
            spelling: {
              spellCheckLanguage: project.spellCheckLanguage || null,
            },
            name: project.name || '',
            description: project.description || '',
          },
        }
      }

      case 'configure_appearance_settings': {
        if (!userId)
          return {
            error: 'User context is required to configure appearance settings.',
          }

        // Security guardrail: explicitly block account credentials and settings
        const providedKeys = Object.keys(args || {})
        const forbiddenFound = providedKeys.filter(k =>
          FORBIDDEN_ACCOUNT_KEYS.has(k.toLowerCase())
        )
        if (forbiddenFound.length > 0) {
          return {
            error: `Cannot modify account settings (${forbiddenFound.join(', ')}). Only appearance preferences may be changed.`,
          }
        }

        const validKeys = providedKeys.filter(k =>
          ALLOWED_APPEARANCE_KEYS.has(k)
        )
        if (validKeys.length === 0) {
          return {
            error: 'Supply at least one valid appearance setting to configure.',
          }
        }

        let user = null
        try {
          user = await this.userModel.findById(userId).exec()
        } catch {}
        if (!user) return { error: 'User not found' }

        user.ace = user.ace || {}
        const updated = {}

        if (args.overallTheme !== undefined) {
          const lower = String(args.overallTheme).toLowerCase().trim()
          let norm = accountText(args.overallTheme)
          if (lower === 'dark' || lower === 'default') norm = ''
          else if (lower === 'light' || lower === 'light-') norm = 'light-'
          else if (lower === 'system') norm = 'system'
          user.ace.overallTheme = norm
          updated.overallTheme = norm
        }
        if (args.editorTheme !== undefined) {
          const themeName = accountText(args.editorTheme)
          user.ace.theme = themeName
          updated.editorTheme = themeName
          if (
            args.editorDarkTheme === undefined &&
            (DARK_EDITOR_THEMES.has(themeName) ||
              !LIGHT_EDITOR_THEMES.has(themeName))
          ) {
            user.ace.darkTheme = themeName
            updated.editorDarkTheme = themeName
          }
          if (
            args.editorLightTheme === undefined &&
            (LIGHT_EDITOR_THEMES.has(themeName) ||
              !DARK_EDITOR_THEMES.has(themeName))
          ) {
            user.ace.lightTheme = themeName
            updated.editorLightTheme = themeName
          }
        }
        if (args.editorLightTheme !== undefined) {
          user.ace.lightTheme = accountText(args.editorLightTheme)
          updated.editorLightTheme = user.ace.lightTheme
        }
        if (args.editorDarkTheme !== undefined) {
          user.ace.darkTheme = accountText(args.editorDarkTheme)
          updated.editorDarkTheme = user.ace.darkTheme
        }
        if (args.darkModePdf !== undefined) {
          user.ace.darkModePdf = Boolean(args.darkModePdf)
          updated.darkModePdf = user.ace.darkModePdf
        }
        if (args.fontSize !== undefined) {
          const fs = Number(args.fontSize)
          if (Number.isFinite(fs) && fs > 0) {
            user.ace.fontSize = fs
            updated.fontSize = fs
          }
        }
        if (args.fontFamily !== undefined) {
          user.ace.fontFamily = args.fontFamily ? accountText(args.fontFamily) : null
          updated.fontFamily = user.ace.fontFamily
        }
        if (args.lineHeight !== undefined) {
          user.ace.lineHeight = args.lineHeight ? accountText(args.lineHeight) : null
          updated.lineHeight = user.ace.lineHeight
        }

        if (typeof user.save === 'function') {
          await user.save()
        }

        return {
          status: 'applied',
          updatedSettings: updated,
          message: 'Appearance settings updated successfully.',
        }
      }

      case 'configure_compiler_settings': {
        const providedKeys = Object.keys(args || {})
        const validKeys = providedKeys.filter(k => ALLOWED_COMPILER_KEYS.has(k))
        if (validKeys.length === 0) {
          return { error: 'Supply at least one compiler setting to configure.' }
        }

        const project = await this.projectGetter.getProject(projectId, {
          _id: 1,
        })
        if (!project) return { error: 'Project not found' }

        const updated = {}

        if (args.compiler != null) {
          const comp = String(args.compiler).toLowerCase()
          if (this.editorController?.promises?.setCompiler) {
            await this.editorController.promises.setCompiler(projectId, comp)
          } else if (this.projectOptionsHandler?.setCompiler) {
            await this.projectOptionsHandler.setCompiler(projectId, comp)
          }
          updated.compiler = comp
        }

        if (args.imageName != null) {
          const img = String(args.imageName)
          if (this.editorController?.promises?.setImageName) {
            await this.editorController.promises.setImageName(projectId, img)
          } else if (this.projectOptionsHandler?.setImageName) {
            await this.projectOptionsHandler.setImageName(projectId, img)
          }
          updated.imageName = img
        }

        // A document id is an ObjectId string. The model's arguments are JSON,
        // so an object here would reach the database query as one.
        if (
          args.rootDocId != null &&
          (typeof args.rootDocId !== 'string' ||
            !OBJECT_ID_RE.test(args.rootDocId))
        ) {
          return { error: 'rootDocId must be a document id.' }
        }
        let effectiveRootDocId = args.rootDocId
        if (!effectiveRootDocId && args.rootDocPath) {
          const doc = await this._resolveDoc(projectId, args.rootDocPath)
          if (!doc)
            return {
              error: `Root document not found at path: ${args.rootDocPath}`,
            }
          effectiveRootDocId = doc._id
        }
        if (effectiveRootDocId != null) {
          if (this.editorController?.promises?.setRootDoc) {
            await this.editorController.promises.setRootDoc(
              projectId,
              effectiveRootDocId
            )
          } else if (this.editorController?.setRootDoc) {
            await new Promise((resolve, reject) => {
              this.editorController.setRootDoc(
                projectId,
                effectiveRootDocId,
                err => (err ? reject(err) : resolve())
              )
            })
          }
          updated.rootDocId = String(effectiveRootDocId)
          if (args.rootDocPath) updated.rootDocPath = args.rootDocPath
        }

        if (args.draft !== undefined) {
          const draftVal = Boolean(args.draft)
          if (this.projectOptionsHandler?.setDraft) {
            await this.projectOptionsHandler.setDraft(projectId, draftVal)
          }
          updated.draft = draftVal
        }

        if (args.stopOnFirstError !== undefined) {
          const stopVal = Boolean(args.stopOnFirstError)
          if (this.projectOptionsHandler?.setStopOnFirstError) {
            await this.projectOptionsHandler.setStopOnFirstError(
              projectId,
              stopVal
            )
          }
          updated.stopOnFirstError = stopVal
        }

        this.invalidateSnapshot(projectId)
        return {
          status: 'applied',
          updatedSettings: updated,
          message: 'Compiler settings updated successfully.',
        }
      }

      case 'configure_editor_settings': {
        if (!userId)
          return {
            error: 'User context is required to configure editor settings.',
          }

        // Security guardrail: explicitly block account credentials and settings
        const providedKeys = Object.keys(args || {})
        const forbiddenFound = providedKeys.filter(k =>
          FORBIDDEN_ACCOUNT_KEYS.has(k.toLowerCase())
        )
        if (forbiddenFound.length > 0) {
          return {
            error: `Cannot modify account settings (${forbiddenFound.join(', ')}). Only editor preferences may be changed by AI tools.`,
          }
        }

        const validKeys = providedKeys.filter(k => ALLOWED_EDITOR_KEYS.has(k))
        if (validKeys.length === 0) {
          return {
            error: 'Supply at least one valid editor setting to configure.',
          }
        }

        let user = null
        try {
          user = await this.userModel.findById(userId).exec()
        } catch {}
        if (!user) return { error: 'User not found' }

        user.ace = user.ace || {}
        const updated = {}

        if (args.mode !== undefined) {
          user.ace.mode = String(args.mode)
          updated.mode = user.ace.mode
        }
        if (args.autoComplete !== undefined) {
          user.ace.autoComplete = Boolean(args.autoComplete)
          updated.autoComplete = user.ace.autoComplete
        }
        if (args.autoPairDelimiters !== undefined) {
          user.ace.autoPairDelimiters = Boolean(args.autoPairDelimiters)
          updated.autoPairDelimiters = user.ace.autoPairDelimiters
        }
        if (args.syntaxValidation !== undefined) {
          user.ace.syntaxValidation = Boolean(args.syntaxValidation)
          updated.syntaxValidation = user.ace.syntaxValidation
        }
        if (args.pdfViewer !== undefined) {
          user.ace.pdfViewer = String(args.pdfViewer)
          updated.pdfViewer = user.ace.pdfViewer
        }
        if (args.mathPreview !== undefined) {
          user.ace.mathPreview = Boolean(args.mathPreview)
          updated.mathPreview = user.ace.mathPreview
        }
        if (args.breadcrumbs !== undefined) {
          user.ace.breadcrumbs = Boolean(args.breadcrumbs)
          updated.breadcrumbs = user.ace.breadcrumbs
        }
        if (args.editorTabs !== undefined) {
          user.ace.editorTabs = Boolean(args.editorTabs)
          updated.editorTabs = user.ace.editorTabs
        }
        if (args.spellCheckLanguage !== undefined) {
          user.ace.spellCheckLanguage = String(args.spellCheckLanguage)
          updated.spellCheckLanguage = user.ace.spellCheckLanguage
        }

        if (typeof user.save === 'function') {
          await user.save()
        }

        return {
          status: 'applied',
          updatedSettings: updated,
          message: 'Editor settings updated successfully.',
        }
      }

      case 'list_available_settings': {
        const compilers = this.settings?.safeCompilers || [
          'pdflatex',
          'latex',
          'xelatex',
          'lualatex',
        ]
        const imageNames = (this.settings?.allowedImageNames || []).map(
          img => ({
            imageName: img.imageName,
            imageDesc: img.imageDesc || img.imageName,
            default: Boolean(img.default),
          })
        )
        const spellCheckLanguages = (this.settings?.languages || []).map(
          lang => ({
            code: lang.code,
            name: lang.name,
          })
        )
        const fontFamilies = [
          { name: 'monaco', label: 'Monaco / Menlo / Consolas' },
          { name: 'lucida', label: 'Lucida / Source Code Pro' },
          { name: 'opendyslexicmono', label: 'OpenDyslexic Mono' },
        ]
        const editorThemes = [
          'cobalt',
          'dracula',
          'eclipse',
          'monokai',
          'overleaf',
          'overleaf_dark',
          'textmate',
          'ambiance',
          'chaos',
          'chrome',
          'clouds',
          'clouds_midnight',
          'crimson_editor',
          'dawn',
          'dreamweaver',
          'github',
          'gob',
          'gruvbox',
          'idle_fingers',
          'iplastic',
          'katzenmilch',
          'kr_theme',
          'kuroir',
          'merbivore',
          'merbivore_soft',
          'mono_industrial',
          'nord_dark',
          'pastel_on_dark',
          'solarized_dark',
          'solarized_light',
          'sqlserver',
          'terminal',
          'tomorrow',
          'tomorrow_night',
          'tomorrow_night_blue',
          'tomorrow_night_bright',
          'tomorrow_night_eighties',
          'twilight',
          'vibrant_ink',
          'xcode',
        ]

        return {
          status: 'ok',
          options: {
            compilers,
            imageNames:
              imageNames.length > 0
                ? imageNames
                : [
                    {
                      imageName: 'texlive-2024.1',
                      imageDesc: 'TeX Live 2024',
                      default: true,
                    },
                  ],
            spellCheckLanguages:
              spellCheckLanguages.length > 0
                ? spellCheckLanguages
                : [
                    { code: 'en', name: 'English' },
                    { code: 'fr', name: 'French' },
                    { code: 'de', name: 'German' },
                    { code: 'es', name: 'Spanish' },
                  ],
            editorModes: ['none', 'vim', 'emacs'],
            overallThemes: ['system', 'light', 'dark'],
            editorThemes,
            fontFamilies,
            lineHeights: ['compact', 'normal', 'spacious'],
            fontSizes: [10, 11, 12, 13, 14, 16, 18, 20, 24],
            pdfViewers: ['pdfjs', 'native'],
          },
        }
      }

      default:
        return { error: `Unknown tool: ${name}` }
    }
  }

  getToolSpecs() {
    const specs = [
      {
        name: 'get_outline',
        description:
          "The section tree with each section's file and line range, plus the \\input graph. Pass section for one subtree.",
        parameters: {
          type: 'object',
          properties: {
            section: {
              type: 'string',
              description: 'Return only this section and its subsections',
            },
          },
        },
      },
      {
        name: 'get_packages',
        description:
          'The documentclass and every \\usepackage, with the file and line that loads it.',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_references',
        description:
          'Every \\label, \\ref and \\cite in the project with its file, line and whether it resolves, plus any duplicated labels. Pass kind to narrow, or unresolvedOnly to see just what is broken.',
        parameters: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['labels', 'refs', 'citations', 'all'],
              description: 'Which kind to return. Defaults to all.',
            },
            unresolvedOnly: {
              type: 'boolean',
              description: 'Return only refs and citations that do not resolve',
            },
          },
        },
      },
      {
        name: 'list_files',
        description:
          "The project's files with type and line count. Pass glob to narrow it, e.g. sections/*.tex.",
        parameters: {
          type: 'object',
          properties: {
            glob: {
              type: 'string',
              description: 'Pattern to narrow the listing, e.g. sections/*.tex',
            },
          },
        },
      },
      {
        name: 'read_file',
        description:
          'Read a text file, or a line range of it, as numbered lines; without from/to, the first 500 lines. Take the range from get_outline or search_text.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to the file to read' },
            from: { type: 'number', description: 'First line, 1-indexed' },
            to: { type: 'number', description: 'Last line, inclusive' },
          },
          required: ['path'],
        },
      },
      {
        name: 'search_text',
        description:
          "Find a string or regular expression across the project's text files, with context lines. Pass glob to search only matching files.",
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            glob: {
              type: 'string',
              description:
                'Only search files matching this glob, e.g. sections/*.tex',
            },
            contextLines: {
              type: 'number',
              description:
                'Lines of surrounding context per hit. Defaults to 1.',
            },
            caseSensitive: { type: 'boolean' },
            regexp: { type: 'boolean' },
          },
          required: ['query'],
        },
      },
      {
        name: 'edit_file',
        description:
          'Edit a project file. Replace oldText with newText, or pass startLine and endLine without oldText to replace those lines with newText (use this for blocks longer than a few lines instead of copying them). Pass oldText: "" to append newText to the end of the file. Pass newText: "" to delete.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to file' },
            oldText: {
              type: 'string',
              description:
                'The exact text to replace. Omit it when passing startLine and endLine. Pass an empty string "" to append content to the end of the file.',
            },
            newText: {
              type: 'string',
              description:
                'Replacement text (or text to append if oldText is empty). Pass an empty string "" to delete.',
            },
            startLine: {
              type: 'number',
              description:
                '1-based first line, as numbered by read_file. With endLine and no oldText, the lines to replace; with oldText, narrows where to look for it.',
            },
            endLine: {
              type: 'number',
              description: '1-based last line, inclusive. See startLine.',
            },
          },
          required: ['path', 'newText'],
        },
      },
      {
        name: 'create_file',
        description: 'Create a new project file with initial content.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path for the new file' },
            content: { type: 'string', description: 'Initial file content' },
          },
          required: ['path', 'content'],
        },
      },
      {
        name: 'compile_project',
        description:
          'Compile the project and return the errors and warnings in its log; how the pages look is what view_compiled_pdf_page, view_compiled_pdf_overview and search_compiled_pdf show. A build with errors can still write a PDF: status success_with_errors and pdfProduced true mean the pages can be viewed. Set clean to rebuild from scratch: after a build with no output, a timeout, output that contradicts the source, or a change to the root document, bibliography or a package that caches state.',
        parameters: {
          type: 'object',
          properties: {
            clean: {
              type: 'boolean',
              description:
                'Clear cached build files first. Slower; use only when the incremental build is untrustworthy.',
            },
          },
        },
      },
      {
        name: 'get_compile_result',
        description:
          'The errors and warnings of the last compile_project in this chat, without rebuilding.',
        parameters: {
          type: 'object',
          properties: {
            severity: {
              type: 'string',
              enum: ['errors', 'warnings', 'all'],
              description: 'Which entries to return. Defaults to all.',
            },
            limit: {
              type: 'number',
              description: 'Cap per severity. Defaults to 20.',
            },
            includeRaw: {
              type: 'boolean',
              description:
                'Include the TeX log lines of each error. Defaults to true.',
            },
          },
        },
      },
      {
        name: 'view_compiled_pdf_page',
        description: [
          'See one page of the last compiled PDF as an image, as the PDF preview shows it, or zoom on one element of it. compile_project only reads the log, and LaTeX often builds with 0 errors while the page is visibly wrong.',
          'When: after every successful compile_project whose edits change what a page shows (tables, figures, TikZ, equations, page breaks), and before telling the user the result looks right.',
          'Page: pass page for a PDF page number, or path and line for the page where that source line is typeset. With neither, it shows the page of your last edit (page 1 if you have not edited). To find a page by its text use search_compiled_pdf; to see many pages at once use view_compiled_pdf_overview.',
          'Zoom: add endLine to path and line to zoom on where that block of lines is typeset. Pass a whole environment (\\begin{table} to \\end{table}, a tikzpicture, an align) to check it at high resolution. Or pass region to zoom into the top, middle or bottom of the page.',
          'Returns: the page image, the page count, a SyncTeX map from height on the page (% from the top) to the source file:line typeset there, and the overfull/underfull boxes on that page.',
          "Fixing: look for content running into or past the margins, overlapping text, labels or arrows, floats far from their text, ?? or [?] for broken refs and citations, missing symbols, and bad breaks. Take the map entry nearest the problem's height, read_file that line, fix it with edit_file, compile_project, then view the page again.",
          'Blocks: pass labels true to draw a numbered id (B1, B2, ...) beside each block on the page; resolve_pdf_block gives the file and lines of an id.',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            page: {
              type: 'number',
              description:
                '1-based PDF page. Omit to choose the page with path and line, or to see the page of your last edit.',
            },
            path: {
              type: 'string',
              description:
                'Source file, e.g. chapters/results.tex. With line, shows the page where that line is typeset.',
            },
            line: {
              type: 'number',
              description: '1-based line in path, as numbered by read_file.',
            },
            endLine: {
              type: 'number',
              description:
                'With path and line: the last line of the block to zoom on, e.g. the \\end{tabular} or \\end{tikzpicture} line. The image then shows only where lines line to endLine are typeset, magnified.',
            },
            region: {
              type: 'string',
              enum: PDF_PAGE_REGIONS,
              description:
                'full shows the whole page (the default without endLine). top, middle or bottom zooms into that part at double resolution, to read small text, table cells and subscripts or see whether lines and arrows touch.',
            },
            labels: {
              type: 'boolean',
              description:
                'Draw block ids (B1, B2, ...) in the margin, for resolve_pdf_block.',
            },
          },
        },
      },
      {
        name: 'view_compiled_pdf_overview',
        description: [
          'See many pages of the last compiled PDF at once: up to 12 pages as thumbnails in one image, each labelled with its page number, plus what measuring the pages found. Use it to judge the document as a whole (page count, paper size, title page, where sections start, where floats landed, page breaks, blank or half-empty pages, content sticking into the margins) and to choose which page to open with view_compiled_pdf_page. Thumbnails are too small to read text or check a table\'s cells; open the page for that.',
          'When: the user asks how the document looks or about its layout or formatting; after edits that move content across pages (floats, \\newpage, sectioning, the document class, geometry or margins); before a layout fix, to find every page it affects.',
          'Returns: the image; the page count, paper size and fonts that are not embedded or are bitmap (Type 3); then per page the source file:lines typeset on it and any problem found: blank, content ending early, large empty bands, ink past the margins, overfull/underfull boxes, ?? and [?] markers.',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            fromPage: {
              type: 'number',
              description: 'First page, 1-based. Defaults to 1.',
            },
            toPage: {
              type: 'number',
              description:
                'Last page. At most 12 pages per call; defaults to fromPage + 11. A shorter range gives larger thumbnails.',
            },
          },
        },
      },
      {
        name: 'search_compiled_pdf',
        description: [
          "Find text in the compiled PDF as the reader sees it, after macros, numbering, \\ref, \\cite and the bibliography are resolved, and get each match's page, height on the page and the source file:line that typeset it. search_text searches the .tex source; this searches the output.",
          'Use it to: find ?? (undefined \\ref) and [?] (undefined \\cite) in the output; find the page of a caption, heading, equation number or bibliography entry; check what generated text came out as (a macro\'s output, numbering, contents and list entries); and get the page number for view_compiled_pdf_page.',
          'Matching ignores case, line breaks and hyphenation; ligatures match their letters. Returns up to 20 matches with the total count and every page that has one.',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                'Text as it appears in the PDF, e.g. "Figure 3", "??", "Smith et al.". Plain text, not a regular expression.',
            },
            fromPage: {
              type: 'number',
              description:
                'Only search from this page (1-based). Defaults to the whole PDF.',
            },
            toPage: {
              type: 'number',
              description:
                'Only search up to this page (1-based). Defaults to the whole PDF.',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'resolve_pdf_block',
        description:
          'Map a block label from a page view (B1, B2, ...) to the source lines that typeset it. Labels are drawn in the margin of view_compiled_pdf_page, for the page they are on. Use it to go from a block you see in the picture to the file and lines to edit.',
        parameters: {
          type: 'object',
          properties: {
            page: {
              type: 'number',
              description: 'The page the label was shown on (1-based).',
            },
            block: {
              type: 'string',
              description: 'The label, such as "B3".',
            },
          },
          required: ['page', 'block'],
        },
      },
      {
        name: 'diff_compiled_pdf',
        description:
          'After a recompile, compare the new build with the build before the last compile, page by page. Returns the changed regions per page and one annotated picture of the new build with the changed regions boxed. Use it to check that a change moved only what you meant to move.',
        parameters: {
          type: 'object',
          properties: {
            pages: {
              type: 'array',
              items: { type: 'number' },
              description:
                'Only compare these pages of the new build (1-based). Defaults to every page.',
            },
          },
        },
      },
      {
        name: 'inspect_compiled_style',
        description:
          'Inspect the typographic style the compiled PDF actually produced: text area, margins, columns, fonts and sizes per role, line spacing, heading spacing, colors, table rules, and float placement, each linked to the controlling preamble line or package with confidence.',
        parameters: {
          type: 'object',
          properties: {
            againstBuildId: {
              type: 'string',
              description:
                'Optional buildId of an earlier build to compare this build\'s style against.',
            },
            againstClsiServerId: {
              type: 'string',
              description:
                'Optional clsiServerId for the againstBuildId.',
            },
          },
        },
      },
      {
        name: 'get_project_settings',
        description:
          'Read current project settings and preferences across compiler, appearance, editor, and spelling.',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'configure_appearance_settings',
        description:
          'Configure appearance and UI display preferences (overall theme, syntax themes, font size, line spacing, dark mode PDF). Account settings cannot be modified here.',
        parameters: {
          type: 'object',
          properties: {
            overallTheme: {
              type: 'string',
              enum: ['system', 'light', 'dark'],
              description: 'Overall UI theme',
            },
            editorTheme: {
              type: 'string',
              description:
                'Editor syntax theme name, e.g. "monokai". list_available_settings lists every theme.',
            },
            editorLightTheme: {
              type: 'string',
              description: 'Editor syntax theme for light mode',
            },
            editorDarkTheme: {
              type: 'string',
              description: 'Editor syntax theme for dark mode',
            },
            darkModePdf: {
              type: 'boolean',
              description: 'Toggle dark mode PDF preview',
            },
            fontSize: {
              type: 'number',
              description: 'Editor font size in pixels (e.g. 10 to 24)',
            },
            fontFamily: {
              type: 'string',
              enum: ['monaco', 'lucida', 'opendyslexicmono'],
              description:
                'Editor code font family: "monaco" (Monaco / Menlo / Consolas), "lucida" (Lucida / Source Code Pro), or "opendyslexicmono" (OpenDyslexic Mono)',
            },
            lineHeight: {
              type: 'string',
              enum: ['compact', 'normal', 'spacious'],
              description: 'Editor line spacing',
            },
          },
        },
      },
      {
        name: 'configure_compiler_settings',
        description:
          'Configure compiler settings: LaTeX compiler engine (pdflatex, latex, xelatex, lualatex), TeX Live version (imageName), root document path, draft mode, and stop on first error.',
        parameters: {
          type: 'object',
          properties: {
            compiler: {
              type: 'string',
              enum: ['pdflatex', 'latex', 'xelatex', 'lualatex'],
              description: 'LaTeX compiler engine',
            },
            imageName: {
              type: 'string',
              description:
                'TeX Live version/image name (e.g. "texlive-2024.1")',
            },
            rootDocPath: {
              type: 'string',
              description: 'Path of the root document, e.g. main.tex',
            },
            draft: {
              type: 'boolean',
              description:
                'Toggle draft mode compilation (faster builds by omitting images)',
            },
            stopOnFirstError: {
              type: 'boolean',
              description:
                'Toggle stopping compilation immediately on the first error',
            },
          },
        },
      },
      {
        name: 'configure_editor_settings',
        description:
          'Configure editor preferences (keybinding mode, auto-complete, bracket pairing, syntax validation, PDF viewer, math preview, breadcrumbs, editor tabs, spellcheck language). Account settings cannot be modified here.',
        parameters: {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              enum: ['none', 'vim', 'emacs'],
              description: 'Keybinding mode',
            },
            autoComplete: {
              type: 'boolean',
              description: 'Toggle auto-complete popup suggestions',
            },
            autoPairDelimiters: {
              type: 'boolean',
              description: 'Toggle auto-closing of brackets and quotes',
            },
            syntaxValidation: {
              type: 'boolean',
              description: 'Toggle LaTeX syntax validation',
            },
            pdfViewer: {
              type: 'string',
              enum: ['pdfjs', 'native'],
              description: 'PDF viewer mode',
            },
            mathPreview: {
              type: 'boolean',
              description: 'Toggle inline math preview tooltip',
            },
            breadcrumbs: {
              type: 'boolean',
              description: 'Toggle file breadcrumbs bar',
            },
            editorTabs: {
              type: 'boolean',
              description: 'Toggle editor tabs bar',
            },
            spellCheckLanguage: {
              type: 'string',
              description:
                'Default user spell-check language code (e.g. "en", "fr")',
            },
          },
        },
      },
      {
        name: 'list_available_settings',
        description:
          'List the allowed values for every setting: compilers, TeX Live versions, spell-check languages, themes, fonts, line heights, font sizes and PDF viewers.',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    ]
    return [...specs, PDF_HIGHLIGHT_SPEC]
  }
}

export default new AiAssistTools()
