// The units an agent refers to when it looks at a page: each paragraph, float
// caption, display equation and table body gets an ID such as B3, drawn in a
// margin beside the page image, so the model can say "B3 overflows" and the
// server can turn that into a source line without a second SyncTeX round trip.
//
// pdftotext already splits a page into blocks; this module decides which of
// them are one unit (a paragraph broken across two blocks is one) and what kind
// of unit each is. The kinds are guesses from the geometry of the lines, good
// enough to name a unit, not a parse of the typesetting.
//
// Pure, except for the bounded table of IDs per build and page, which
// resolveBlock reads back.

import { BoundedLru } from './PdfCache.mjs'
import {
  maxOf,
  minOf,
  pageColumns,
  splitByColumns,
} from './PdfTextLayer.mjs'

const CAPTION = /^(figure|fig\.|table|algorithm|listing|scheme)\s+[\w.:-]+/i
// A gap between two words this wide (points) is a cell boundary, not a space.
const CELL_GAP_PT = 9
// A first line indented this many line heights in its column starts a
// paragraph; a line set this many times the usual pitch below the last does.
const INDENT_BREAK = 0.8
const PITCH_BREAK = 1.25
const DISPLAY_MAX_LINES = 3
const DISPLAY_CENTRED = 0.03
const MAX_BLOCK_TABLES = 200

// projectId:buildId:page -> Map(blockId -> { path, line, endLine }). The project
// is part of the key so one project's source map is never read for another.
const blockTables = new BoundedLru({ maxEntries: MAX_BLOCK_TABLES })

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

function boxOf(lines) {
  const xMin = minOf(lines, line => line.xMin)
  const yMin = minOf(lines, line => line.yMin)
  const xMax = maxOf(lines, line => line.xMax)
  const yMax = maxOf(lines, line => line.yMax)
  return { x: xMin, y: yMin, w: xMax - xMin, h: yMax - yMin }
}

/** The words of a line in order, and the gaps between them in points. */
function wordGaps(line) {
  const gaps = []
  for (let i = 1; i < line.words.length; i++) {
    gaps.push(line.words[i].xMin - line.words[i - 1].xMax)
  }
  return gaps
}

/** Whether a line has a gap wide enough to be a table cell boundary. */
function hasCellGap(line) {
  return wordGaps(line).some(gap => gap >= CELL_GAP_PT)
}

/**
 * The lines in reading order: each run of lines across the page in the order
 * pdftotext gives, and between them each column top to bottom, left to right.
 * pdftotext can interleave the columns of a page block by block.
 */
function readingOrder(entries) {
  const segments = []
  for (const entry of entries) {
    const last = segments.at(-1)
    const full = entry.column < 0
    if (!last || last.full !== full) segments.push({ full, items: [entry] })
    else last.items.push(entry)
  }
  return segments.flatMap(({ full, items }) =>
    full
      ? items
      : items
          .map((entry, order) => ({ entry, order }))
          .sort(
            (a, b) =>
              a.entry.column - b.entry.column ||
              a.entry.line.yMin - b.entry.line.yMin ||
              a.order - b.order
          )
          .map(({ entry }) => entry)
  )
}

/**
 * Units of a page, in reading order. A unit is `{ kind, bbox, lines, text }`
 * where kind is 'text', 'caption', 'display' or 'table', bbox is `{x, y, w, h}`
 * in points from the top left, lines are the text lines it holds, and text is
 * the start of its first line. Numbering is left to numberUnits.
 *
 * A unit starts at a new pdftotext block, a change of column, a first line
 * indented in its column (a paragraph), or a line set a good way further down
 * than the last. Table rows stay together. pdftotext often runs several
 * paragraphs into one block, so the blocks alone are not the units.
 *
 * @param {object} page a page from parseBboxLayout
 * @returns {Array<{kind: string, bbox: {x: number, y: number, w: number, h: number}, lines: object[], text: string}>}
 */
export function groupBlocks(source) {
  // Lines that cross a gutter are cut into one piece per column first.
  const page = source ? splitByColumns(source).page : source
  const blocks = (page?.blocks ?? []).filter(block => block.lines.length > 0)
  if (blocks.length === 0) return []
  const width = page.width || 1
  const columns = pageColumns(page)
  const lineHeight =
    median(
      blocks.flatMap(block => block.lines.map(line => line.yMax - line.yMin))
    ) || 1

  // The column a line sits in; -1 for a line across the page's width.
  const columnOfLine = line => {
    const centre = (line.xMin + line.xMax) / 2
    return columns.findIndex(
      column => centre >= column.left - 1 && centre <= column.right + 1
    )
  }
  const entries = readingOrder(
    blocks.flatMap((block, index) =>
      block.lines.map(line => ({
        line,
        block: index,
        column: columnOfLine(line),
      }))
    )
  )
  // The usual baseline distance: between consecutive lines of one column.
  const pitches = []
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1]
    const next = entries[i]
    const gap = next.line.yMin - prev.line.yMin
    if (prev.column === next.column && gap > 0 && gap < 3 * lineHeight) {
      pitches.push(gap)
    }
  }
  const pitch = median(pitches) || lineHeight

  const startsUnit = (prev, next) => {
    if (!prev) return true
    if (prev.column !== next.column) return true
    // pdftotext often gives every line of a column its own block: a block
    // only ends a unit where it starts a caption.
    if (CAPTION.test(next.line.text)) return true
    if (next.line.yMin - prev.line.yMin > PITCH_BREAK * pitch) return true
    // A table row is not a paragraph, whatever its indentation.
    if (hasCellGap(prev.line) || hasCellGap(next.line)) return false
    const column = columns[Math.max(0, next.column)] ?? { left: 0 }
    return next.line.xMin - column.left > INDENT_BREAK * lineHeight
  }

  const runs = []
  let previous = null
  for (const entry of entries) {
    if (startsUnit(previous, entry))
      runs.push({ column: entry.column, lines: [] })
    runs.at(-1).lines.push(entry.line)
    previous = entry
  }

  return runs.map(({ column: index, lines }) => {
    const bbox = boxOf(lines)
    const column = columns[Math.max(0, index)] ?? { left: 0, right: width }
    const columnCentre = (column.left + column.right) / 2
    const columnWidth = column.right - column.left
    const tableRows = lines.filter(hasCellGap).length
    let kind = 'text'
    if (CAPTION.test(lines[0].text)) kind = 'caption'
    else if (
      lines.length >= 2 &&
      tableRows >= 2 &&
      tableRows >= lines.length / 2
    ) {
      kind = 'table'
    } else if (
      lines.length <= DISPLAY_MAX_LINES &&
      lines.every(
        line =>
          Math.abs((line.xMin + line.xMax) / 2 - columnCentre) <
            DISPLAY_CENTRED * width && line.xMax - line.xMin < 0.8 * columnWidth
      )
    ) {
      kind = 'display'
    }
    return {
      kind,
      bbox,
      lines,
      text: lines[0].text,
    }
  })
}

/** Gives the units of a page their IDs, B1 upwards, in reading order. */
export function numberUnits(units) {
  return units.map((unit, index) => ({ ...unit, id: `B${index + 1}` }))
}

/** Units whose boxes reach into `span` (fractions of the page height). */
export function unitsInSpan(units, pageHeight, span) {
  return units.filter(unit => {
    const top = unit.bbox.y / pageHeight
    const bottom = (unit.bbox.y + unit.bbox.h) / pageHeight
    return bottom > span.top && top < span.bottom
  })
}

/**
 * Where to probe SyncTeX for a unit: the middle of its first and last lines,
 * which lie on text whatever the unit's shape. One point for a one-line unit.
 */
export function unitProbes(unit) {
  const centre = line => ({
    x: (line.xMin + line.xMax) / 2,
    y: (line.yMin + line.yMax) / 2,
  })
  const first = centre(unit.lines[0])
  const last = centre(unit.lines.at(-1))
  return first.x === last.x && first.y === last.y ? [first] : [first, last]
}

/**
 * The margin marks for the units in view: a tag and the pixel rows its box
 * covers in an image of `span` (fractions) of a page `pageHeight` points high,
 * `rasterHeight` pixels tall.
 */
export function unitMarks(units, { span, pageHeight, rasterHeight }) {
  const scale = rasterHeight / ((span.bottom - span.top) * pageHeight)
  return units.map(unit => ({
    tag: unit.id,
    top: (unit.bbox.y - span.top * pageHeight) * scale,
    bottom: (unit.bbox.y + unit.bbox.h - span.top * pageHeight) * scale,
  }))
}

/**
 * The output form of a unit: its ID, page, box in points, what it typesets in
 * the source (path and line, endLine when it runs on), and its text start.
 * `source` is what SyncTeX gave for the unit, or null.
 */
export function blockOf(unit, page, source) {
  return {
    id: unit.id,
    page,
    kind: unit.kind,
    bbox: {
      x: Math.round(unit.bbox.x),
      y: Math.round(unit.bbox.y),
      w: Math.round(unit.bbox.w),
      h: Math.round(unit.bbox.h),
    },
    path: source?.path ?? null,
    line: source?.line ?? null,
    ...(source?.endLine != null && source.endLine !== source.line
      ? { endLine: source.endLine }
      : {}),
    text: unit.text,
  }
}

/**
 * Keeps the IDs of a page's labelled units, for resolveBlock. `entries` maps
 * each ID to `{ path, line, endLine }`; units with no source are left out.
 */
export function rememberBlocks(buildId, page, entries, projectId = '') {
  const table = new Map()
  for (const [id, where] of entries) {
    if (where?.path) table.set(id, where)
  }
  blockTables.set(`${projectId}:${buildId}:${page}`, table)
}

/**
 * The source of block `blockId` on `page` of a build, as last labelled: the
 * path and first line, endLine when it runs on. Null when no label of that ID
 * is known, or the block typesets no source.
 *
 * @returns {{path: string, line: number, endLine?: number} | null}
 */
export function resolveBlock({ projectId = '', buildId, page, blockId }) {
  const table = blockTables.get(`${projectId}:${buildId}:${page}`)
  const where = table?.get(String(blockId ?? '').toUpperCase())
  if (!where) return null
  return {
    path: where.path,
    line: where.line,
    ...(where.endLine != null ? { endLine: where.endLine } : {}),
  }
}
