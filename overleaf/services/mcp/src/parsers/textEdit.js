import { CODES, OverleafApiError } from '../errors.js'

// The nearest-text search scores every window of the document, so its cost is
// lines x needle lines. Past this budget the hint is skipped rather than
// stalling the event loop on a large document.
const MAX_NEAREST_WORK = 20000
const MAX_NEAREST_NEEDLE_LINES = 200
const NEAREST_MIN_SIMILARITY = 0.4

/** 1-based line number of a character offset. */
export function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') line++
  }
  return line
}

/**
 * A lookup from character offset to 1-based line number for one text. The
 * newline offsets are indexed once, so a parser that resolves many offsets pays
 * a binary search for each instead of a scan from the start of the document.
 *
 * @param {string} text
 * @returns {(index: number) => number}
 */
export function lineLookup(text) {
  const breaks = []
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    breaks.push(i)
  }
  return index => {
    // Each newline strictly before index starts a line after the first.
    let lo = 0
    let hi = breaks.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (breaks[mid] < index) lo = mid + 1
      else hi = mid
    }
    return lo + 1
  }
}

/**
 * Split text into lines. A single trailing newline ends the last line rather
 * than starting an empty one, so "drop me\n" is one line.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitLines(text) {
  if (text === '') return []
  const lines = String(text).split('\n')
  if (text.endsWith('\n')) lines.pop()
  return lines
}

/**
 * Render lines with their 1-based numbers, `N<TAB>text`, the form read_file
 * returns. The number and tab are presentation only, never part of the file.
 *
 * @param {string[]} lines
 * @param {number} startLine the number of the first line
 */
export function numberLines(lines, startLine) {
  return lines.map((line, i) => `${startLine + i}\t${line}`).join('\n')
}

function squash(text) {
  return String(text).replace(/\s+/g, ' ').trim()
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Non-overlapping exact occurrences of needle, as { index, length }. */
export function findExact(text, needle) {
  if (!needle) return []
  const spans = []
  let at = text.indexOf(needle)
  while (at !== -1) {
    spans.push({ index: at, length: needle.length })
    at = text.indexOf(needle, at + needle.length)
  }
  return spans
}

/**
 * Occurrences of needle where any run of whitespace in the file matches any
 * run of whitespace in the needle. Catches indentation and line-break drift.
 */
export function findLoose(text, needle) {
  const tokens = String(needle ?? '').trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return []
  const pattern = new RegExp(tokens.map(escapeRegex).join('\\s+'), 'g')
  return [...text.matchAll(pattern)].map(match => ({
    index: match.index,
    length: match[0].length,
  }))
}

function bigrams(text) {
  const counts = new Map()
  for (let i = 0; i < text.length - 1; i++) {
    const pair = text.slice(i, i + 2)
    counts.set(pair, (counts.get(pair) ?? 0) + 1)
  }
  return counts
}

function dice(a, b) {
  let sizeA = 0
  let sizeB = 0
  for (const count of a.values()) sizeA += count
  for (const count of b.values()) sizeB += count
  if (sizeA + sizeB === 0) return 0
  let shared = 0
  for (const [pair, count] of a) shared += Math.min(count, b.get(pair) ?? 0)
  return (2 * shared) / (sizeA + sizeB)
}

/**
 * The window of lines most similar to needle, for "did you mean" guidance on a
 * failed match. Returns null for very large documents, where scanning every
 * window would cost more than the hint is worth.
 *
 * @returns {{ startLine: number, endLine: number, similarity: number, text: string } | null}
 */
export function nearestWindow(text, needle) {
  const size = Math.max(1, String(needle).split('\n').length)
  // Cost is roughly windows x window size, so an oversized oldString gets no hint.
  if (size > MAX_NEAREST_NEEDLE_LINES) return null
  const lines = text.split('\n')
  const want = squash(needle)
  if (!want || lines.length * size > MAX_NEAREST_WORK) return null
  const target = bigrams(want)
  let best = null
  for (let start = 0; start < lines.length; start++) {
    const end = Math.min(lines.length, start + size)
    const score = dice(target, bigrams(squash(lines.slice(start, end).join('\n'))))
    if (!best || score > best.score) best = { start, end, score }
  }
  return {
    startLine: best.start + 1,
    endLine: best.end,
    similarity: Math.round(best.score * 100) / 100,
    text: numberLines(lines.slice(best.start, best.end), best.start + 1),
  }
}

/** The full line of text that contains index, trimmed. */
function lineTextAt(text, index) {
  const start = text.lastIndexOf('\n', index - 1) + 1
  const end = text.indexOf('\n', index)
  return text.slice(start, end === -1 ? text.length : end).trim()
}

/**
 * A compact `- removed` / `+ added` rendering of one replacement.
 *
 * @param {string} before the text that was replaced ('' for none)
 * @param {string} after the text that replaced it ('' for none)
 */
export function diffText(before, after) {
  const removed = splitLines(before)
  const added = splitLines(after)
  return [...removed.map(line => `- ${line}`), ...added.map(line => `+ ${line}`)].join('\n')
}

/**
 * Build the function that moves a position once replacements have been made.
 * `spans` are the replaced ranges in the text before the change, in ascending
 * order and non-overlapping; `lengths` are their new lengths.
 *
 * Prefix sums and a binary search make each lookup O(log n), so a replaceAll
 * over thousands of occurrences stays linear rather than quadratic.
 */
function remapper(spans, lengths) {
  // shift[i] is how far the first i spans have moved everything after them.
  const shift = [0]
  spans.forEach((span, i) => shift.push(shift[i] + lengths[i] - span.length))
  return pos => {
    // The spans ending at or before pos form a prefix, so search for its end.
    let lo = 0
    let hi = spans.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (spans[mid].index + spans[mid].length <= pos) lo = mid + 1
      else hi = mid
    }
    return pos + shift[lo]
  }
}

function notFoundError(current, path, editIndex, total, oldString) {
  const nearest = nearestWindow(current, oldString)
  const label = total > 1 ? `edit ${editIndex + 1} of ${total}` : 'oldString'
  const details = { editIndex }
  let hint =
    'Copy oldString exactly as read_file printed it (without the line-number prefix), or use edit_lines with a line range.'
  if (nearest && nearest.similarity >= NEAREST_MIN_SIMILARITY) {
    details.nearest = nearest
    hint =
      `The closest text is at lines ${nearest.startLine}-${nearest.endLine} (details.nearest). ` +
      'Copy it exactly into oldString, or use edit_lines with those line numbers.'
  }
  return new OverleafApiError(
    CODES.VALIDATION_ERROR,
    `${label} was not found in ${path}; nothing was changed`,
    400,
    { hint, details }
  )
}

function ambiguousError(current, path, editIndex, total, spans) {
  const shown = spans.slice(0, 10).map(span => ({
    line: lineOf(current, span.index),
    preview: lineTextAt(current, span.index),
  }))
  const label = total > 1 ? `edit ${editIndex + 1} of ${total}` : 'oldString'
  return new OverleafApiError(
    CODES.VALIDATION_ERROR,
    `${label} matches ${spans.length} places in ${path}; nothing was changed`,
    400,
    {
      hint:
        `Add surrounding lines to oldString so it matches once, or set replaceAll: true ` +
        `to change all ${spans.length} occurrences.`,
      details: { editIndex, count: spans.length, matches: shown },
    }
  )
}

/**
 * Apply edits in order to a document, all or nothing.
 *
 * Each edit sees the result of the edits before it. An edit matches exactly
 * first; only when that finds nothing does it retry ignoring whitespace
 * differences, and only a unique loose match is taken.
 *
 * @param {string} text the document as stored
 * @param {{ oldString: string, newString: string, replaceAll?: boolean }[]} edits
 * @param {{ path: string }} options
 * @returns {{ text: string, replacements: number, changes: object[], warnings: string[] }}
 * @throws {OverleafApiError} validation_error naming the failing edit, with nearest
 *   or candidate matches in details; the document is not changed
 */
export function applyEdits(text, edits, { path }) {
  let current = text
  let regions = []
  let replacements = 0
  const warnings = []

  edits.forEach((edit, editIndex) => {
    const { oldString, newString, replaceAll } = edit
    let spans = findExact(current, oldString)
    let matchedBy = 'exact'
    if (spans.length === 0) {
      spans = findLoose(current, oldString)
      matchedBy = 'whitespace-insensitive'
    }
    if (spans.length === 0) {
      throw notFoundError(current, path, editIndex, edits.length, oldString)
    }
    if (spans.length > 1 && !replaceAll) {
      throw ambiguousError(current, path, editIndex, edits.length, spans)
    }
    if (matchedBy !== 'exact') {
      warnings.push(
        `edit ${editIndex + 1} matched ignoring whitespace differences; check the result`
      )
    }

    const targets = replaceAll ? spans : spans.slice(0, 1)
    const lengths = targets.map(() => newString.length)
    let next = ''
    let cursor = 0
    for (const span of targets) {
      next += current.slice(cursor, span.index) + newString
      cursor = span.index + span.length
    }
    next += current.slice(cursor)

    const moved = remapper(targets, lengths)
    regions = regions.map(region => ({
      ...region,
      start: moved(region.start),
    }))
    targets.forEach(span => {
      regions.push({
        start: moved(span.index),
        before: current.slice(span.index, span.index + span.length),
        after: newString,
        editIndex,
      })
    })
    replacements += targets.length
    current = next
  })

  if (current === text) {
    warnings.push('the edits left the document unchanged')
  }

  // Regions are in document order, so one forward scan yields every start line;
  // calling lineOf per region would rescan the document from the top each time.
  let line = 1
  let scanned = 0
  const changes = regions
    .sort((a, b) => a.start - b.start)
    .map(region => {
      for (; scanned < region.start && scanned < current.length; scanned++) {
        if (current[scanned] === '\n') line++
      }
      const startLine = line
      const newLineCount = splitLines(region.after).length
      return {
        editIndex: region.editIndex,
        startLine,
        endLine: newLineCount > 0 ? startLine + newLineCount - 1 : startLine,
        diff: diffText(region.before, region.after),
      }
    })

  return {
    text: current,
    replacements,
    changes,
    warnings,
  }
}
