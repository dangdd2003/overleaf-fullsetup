// Shows an agent the compiled PDF, so it can check how its LaTeX actually
// looks: a log with no errors says nothing about a table running off the
// page, two TikZ arrows drawn on top of each other or a float that left half
// a page empty.
//
// Three views of one build, each mapped back to the source by SyncTeX:
// - inspectPdfPage renders one page, or zooms on the block a range of source
//   lines typesets, with the source lines at each height and the page's bad
//   boxes from the log. It can split the page into halves, number the text
//   blocks in a margin (so a model can name one, see resolveBlock) and return
//   structured defect records.
// - overviewPdfPages lays the pages of a range out as labelled thumbnails in
//   one image (every page by default), and measures each page for what thumbnails are
//   too small to show: blank pages, content ending early, empty bands, ink
//   past the margins, bad boxes, ?? and [?] markers, problem fonts.
// - searchPdfText finds text as the reader sees it, after macros, numbering,
//   references and citations are resolved.
//
// poppler-utils (in the base image) does the PDF work: pdfinfo, pdffonts,
// pdftoppm rasterises and pdftotext reads the text layer. PdfRaster.mjs,
// PdfTextLayer.mjs, PdfBlockLabels.mjs and PdfDefects.mjs hold the pure parts.
// The MCP API and the AI assistant both call this module, so they see the same
// pictures.

import { execFile as execFileCallback } from 'node:child_process'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import Path from 'node:path'
import { promisify } from 'node:util'
import ClsiManager from '../Compile/ClsiManager.mjs'
import CompileManager from '../Compile/CompileManager.mjs'
import Errors from '../Errors/Errors.js'
import {
  parseLatexLog,
  normalizeLogPath,
  rootDirectory,
} from './LatexLogParser.mjs'
import {
  MAX_OUTPUT_LOG_BYTES,
  MAX_OUTPUT_PDF_BYTES,
  OutputTooLargeError,
  pipeBounded,
  readBounded,
} from './BoundedStream.mjs'
import { BoundedLru } from './PdfCache.mjs'
import {
  addMargin,
  analyzeInk,
  composeGrid,
  encodePng,
  parsePnm,
} from './PdfRaster.mjs'
import {
  blockOf,
  groupBlocks,
  numberUnits,
  rememberBlocks,
  resolveBlock,
  unitMarks,
  unitProbes,
  unitsInSpan,
} from './PdfBlockLabels.mjs'
import {
  BANNED_FIXES_BY_CATEGORY,
  BANNED_QUICK_FIXES,
  fontDefects,
  numberDefects,
  pageDefects,
} from './PdfDefects.mjs'
import {
  compileQuery,
  pageLines,
  parseBboxLayout,
  searchPage,
  splitByColumns,
  unresolvedMarkers,
} from './PdfTextLayer.mjs'

export { BANNED_FIXES_BY_CATEGORY, BANNED_QUICK_FIXES, resolveBlock }

export const DEFAULT_DPI = 150
export const REGIONS = ['full', 'top', 'middle', 'bottom']
// Layout is measured at this resolution, whatever size the thumbnails are: a
// two-point overhang is a fraction of a millimetre and a 31 DPI thumbnail
// cannot see it.
export const MEASURE_DPI = 100

// Each third overlaps its neighbour, so a table on a boundary is whole in one
// of them. Fractions of the page height from the top.
const REGION_SPANS = {
  full: [0, 1],
  top: [0, 0.4],
  middle: [0.3, 0.7],
  bottom: [0.6, 1],
}
// A region is rendered at this multiple of the page DPI: zooming in is the
// point of asking for one.
const REGION_ZOOM = 2
// Vision models downscale anything larger (Claude to 1568px, GPT to 2048px),
// so more pixels only cost bytes. Large paper sizes get a lower DPI instead.
export const MAX_EDGE_PX = 2400
const MIN_EDGE_PX = 300
// Under every provider's per-image limit once base64-encoded (Anthropic: 5MB).
export const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024
// With block labels, the margin takes this much of the long edge.
const LABEL_STRIP_PX = 96
// Each half of a split page overlaps the other by this share of the view.
const SPLIT_OVERLAP = 0.05
const COMMAND_TIMEOUT_MS = 30_000
// SyncTeX probes: a page view asks about this many heights, an overview page
// about OVERVIEW_ROWS per column.
const FULL_PAGE_ROWS = 10
const REGION_ROWS = 5
const OVERVIEW_ROWS = 4
// Lines tried after the requested one when it typesets nothing itself (a
// blank line, a comment, \begin{table}).
const LOCATE_LOOKAHEAD = 3
// Source lines asked about when zooming on a block; a long block is sampled.
const FOCUS_PROBES = 16
// Source lines a highlight asks about one by one; a longer range uses its ends,
// as the viewer's own highlight does (pdfBoxesForSource).
const HIGHLIGHT_MAX_LINES = 12
// Space kept around a zoomed block, and the least of the page it shows, as
// fractions of the page height: a single equation still comes with the text
// around it.
const FOCUS_PADDING = 0.03
const FOCUS_MIN_HEIGHT = 0.15
// A line this wide (share of the page width) crosses the columns.
const FULL_WIDTH_SHARE = 0.6
// A column line that is at least this share of the column's width is body text.
const BODY_LINE_SHARE = 0.6
const MAX_CONCURRENT_RENDERS = 2
// SyncTeX runs in the compile backend; an overview of twelve pages asks about
// dozens of points, and the backend should not see more than this at once.
const SYNCTEX_CONCURRENCY = 4
const MAX_SYNCTEX_CACHE = 2000
const MAX_CACHED_LOGS = 8
const MAX_CACHED_PAGES = 12
// Rendered images are kept as Buffers, up to this many bytes in all; base64 is
// made only for the reply.
const MAX_CACHED_IMAGE_BYTES = 24 * 1024 * 1024
// Downloaded PDFs are kept for the next call on the same build: an agent
// looks at the overview, searches, then opens pages, all of one build.
const MAX_CACHED_PDFS = 3
const PDF_IDLE_MS = 10 * 60 * 1000
const MAX_CACHED_TEXT_PAGES = 600
// pdftotext reads a long document this many pages at a time, so its output
// never has to be held whole.
const TEXT_CHUNK_PAGES = 40
// The longest edge a picture may have, whatever maxEdgePx a caller asks for.
// A page of any paper size is then rendered in bounded memory.
export const MAX_EDGE_PX_LIMIT = 4800
// The pages an overview lays out in one picture; fromPage and toPage choose the
// rest. Each page is rasterised twice and kept in memory until the picture is
// composed.
export const MAX_OVERVIEW_PAGES = 40
// Matches of a search that are located in SyncTeX (one call each). The count
// stays complete; past this many, the rest are reported without a source line.
export const MAX_LOCATED_MATCHES = 200

// The overview image is sized for about what a vision model reads at full
// resolution (Claude scales anything over ~1.15 megapixels down).
const OVERVIEW_TARGET_PIXELS = 1_150_000
const OVERVIEW_MIN_DPI = 20
// Page measurements, as fractions of the page. A running header or a page
// number is a short band set apart from the body near the top or bottom.
const INK_THRESHOLD = 235
const MARGIN_BAND_MAX_HEIGHT = 0.03
const HEADER_ZONE = 0.12
// Page numbers sit at about 83% of an A4 page with LaTeX's default margins.
const FOOTER_ZONE = 0.8
const MARGIN_BAND_GAP = 0.02
// A body that stops above this height is reported as ending early.
const ENDS_EARLY = 0.8
const MIN_EMPTY_BAND = 0.12
// Ink this far past a column's reference edge is reported. The reference is
// the median edge of the same column on the other pages, so a rule or an
// anti-aliased edge can only sit a fraction of a point off it. A millimetre
// covers that at 100 DPI (0.25 mm a pixel) plus the 0.1pt \hfuzz TeX allows
// before it calls a line overfull, and it still catches the 2pt overhangs an
// overfull line leaves.
const OVERFLOW_TOLERANCE_MM = 1
const PAPER_EDGE = 0.05
const MIN_OVERFLOW_MM = 1.5

const PAPER_SIZES = [
  ['A4', 595, 842],
  ['Letter', 612, 792],
  ['Legal', 612, 1008],
  ['A5', 420, 595],
  ['A3', 842, 1191],
  ['B5', 499, 709],
  ['Executive', 522, 756],
]

export const PDF_PAGE_ERRORS = {
  NO_PDF: 'no_pdf',
  PAGE_OUT_OF_RANGE: 'page_out_of_range',
  LINE_NOT_IN_PDF: 'line_not_in_pdf',
  SYNCTEX_UNAVAILABLE: 'synctex_unavailable',
  RENDERER_UNAVAILABLE: 'renderer_unavailable',
  RENDER_FAILED: 'render_failed',
  INVALID_QUERY: 'invalid_query',
}

/**
 * Why a page's source map is empty, and what to tell the model. The reasons
 * look alike from a picture (no coloured text, no source lines), so each has
 * its own status.
 */
export const SOURCE_NOTES = {
  mapped:
    'Each height of the picture is mapped to the source line typeset there.',
  no_synctex:
    'This build has no SyncTeX data (it was compiled without -synctex=1), so no part of the picture can be mapped to source. The picture itself is correct.',
  probe_missed:
    'The page has text, but none of the probes landed on typeset text, so the map is empty. The page is not blank: the probes missed. Pass line and endLine, or a region, to look closer.',
  line_not_in_build:
    'The requested source line is not typeset in this build: it is in a comment, the preamble, a file the build does not read, or was added after this build.',
  page_without_source:
    'No text on this page is typeset from source here, so there is nothing to map. The page is blank or holds only graphics.',
}

export class PdfPageError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'PdfPageError'
    this.code = code
    if (details) this.details = details
  }
}

const NO_SYNCTEX_MESSAGE =
  'This build has no SyncTeX data (it was compiled without -synctex=1), so source lines cannot be found in its PDF.'

/** A path as the project names it: no leading "./" or "/". */
function projectPath(raw) {
  return String(raw ?? '')
    .replace(/\\/g, '/')
    .replace(/^(\.\/|\/)+/, '')
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function percent(fraction) {
  return clamp(Math.round(fraction * 100), 0, 100)
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

/**
 * The page count, and the size in points of `page`, from `pdfinfo -f page -l
 * page`. A rotated page reports its unrotated box, so 90 and 270 swap the
 * sides to match what is rendered.
 */
export function parsePdfInfo(stdout, page) {
  const text = String(stdout ?? '')
  const pages = /^Pages:\s+(\d+)/m.exec(text)
  const sized =
    new RegExp(`^Page\\s+${page}\\s+size:\\s+([\\d.]+) x ([\\d.]+)`, 'm').exec(
      text
    ) || /^Page size:\s+([\d.]+) x ([\d.]+)/m.exec(text)
  const rotated = new RegExp(`^Page\\s+${page}\\s+rot:\\s+(\\d+)`, 'm').exec(
    text
  )
  const pageCount = pages ? parseInt(pages[1], 10) : 0
  if (!sized) return { pageCount, pageSize: null }
  let width = parseFloat(sized[1])
  let height = parseFloat(sized[2])
  const rotation = rotated ? parseInt(rotated[1], 10) % 360 : 0
  if (rotation === 90 || rotation === 270) [width, height] = [height, width]
  return { pageCount, pageSize: { width, height } }
}

/**
 * Every page size `pdfinfo -f A -l B` lists, rotated as rendered, by page
 * number.
 */
export function parsePageSizes(stdout) {
  const text = String(stdout ?? '')
  const pages = /^Pages:\s+(\d+)/m.exec(text)
  const sizes = new Map()
  for (const match of text.matchAll(
    /^Page\s+(\d+)\s+size:\s+([\d.]+) x ([\d.]+)/gm
  )) {
    sizes.set(parseInt(match[1], 10), {
      width: parseFloat(match[2]),
      height: parseFloat(match[3]),
    })
  }
  for (const match of text.matchAll(/^Page\s+(\d+)\s+rot:\s+(\d+)/gm)) {
    const size = sizes.get(parseInt(match[1], 10))
    const rotation = parseInt(match[2], 10) % 360
    if (size && (rotation === 90 || rotation === 270)) {
      ;[size.width, size.height] = [size.height, size.width]
    }
  }
  return { pageCount: pages ? parseInt(pages[1], 10) : 0, sizes }
}

/** The name of a standard paper size, either way round, or null. */
export function paperName({ width, height }) {
  const short = Math.min(width, height)
  const long = Math.max(width, height)
  const found = PAPER_SIZES.find(
    ([, w, h]) => Math.abs(short - w) <= 2 && Math.abs(long - h) <= 2
  )
  return found ? found[0] : null
}

/**
 * The fonts in `pdffonts` output that a publisher or reader would notice:
 * not embedded (another machine substitutes its own), and Type 3 (usually
 * bitmap glyphs, blurry when zoomed and rejected by many submission
 * checkers). Columns are cut where the dashed rule under the header puts
 * them, since font types and encodings contain spaces.
 */
export function parsePdfFonts(stdout) {
  const lines = String(stdout ?? '').split('\n')
  const rule = lines.findIndex(line => /^-+( -+)+\s*$/.test(line))
  const fonts = { total: 0, notEmbedded: [], type3: [] }
  if (rule < 0) return fonts
  const columns = [...lines[rule].matchAll(/-+/g)].map(match => [
    match.index,
    match.index + match[0].length,
  ])
  const cell = (line, index) =>
    line.slice(columns[index][0], columns[index + 1]?.[0] ?? line.length).trim()
  const notEmbedded = new Set()
  const type3 = new Set()
  for (const line of lines.slice(rule + 1)) {
    if (!line.trim() || columns.length < 4) continue
    fonts.total++
    const name = cell(line, 0).replace(/^[A-Z]{6}\+/, '') || '[none]'
    if (cell(line, 1) === 'Type 3') type3.add(name)
    if (cell(line, 3) === 'no') notEmbedded.add(name)
  }
  fonts.notEmbedded = [...notEmbedded]
  fonts.type3 = [...type3]
  return fonts
}

/** Pixel size of a PNG or JPEG, or null for anything else. */
export function imageSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null
  if (buffer.readUInt32BE(0) === 0x89504e47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null
  let offset = 2
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) return null
    const marker = buffer[offset + 1]
    const length = buffer.readUInt16BE(offset + 2)
    // SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC)
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    ) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      }
    }
    offset += 2 + length
  }
  return null
}

/** The band of the page a region names: a REGIONS name or a { top, bottom } span. */
function spanOf(region) {
  if (region && typeof region === 'object') {
    return { top: region.top, bottom: region.bottom }
  }
  const [top, bottom] = REGION_SPANS[region] ?? REGION_SPANS.full
  return { top, bottom }
}

const isWhole = span => span.top <= 0 && span.bottom >= 1

/**
 * The resolution and crop for a band of a page (fractions of its height), with
 * the long edge at most `maxEdgePx`. `zoom` multiplies the DPI, `crop` says
 * whether the band is cut out of the page.
 */
function planSpan(pageSize, top, bottom, { dpi, maxEdgePx, zoom, crop }) {
  const heightPt = pageSize.height * (bottom - top)
  const longest = Math.max(pageSize.width, heightPt)
  // The edge cap wins over the DPI: a very large page is rendered at a lower DPI
  // rather than past maxEdgePx (1 DPI is the floor, as nothing lower is drawn).
  const effectiveDpi = Math.max(
    1,
    Math.min(dpi * zoom, Math.floor((maxEdgePx * 72) / longest))
  )
  const scale = effectiveDpi / 72
  return {
    dpi: effectiveDpi,
    top,
    bottom,
    crop: crop
      ? {
          x: 0,
          y: Math.floor(pageSize.height * top * scale),
          width: Math.ceil(pageSize.width * scale),
          height: Math.ceil(heightPt * scale),
        }
      : null,
  }
}

/**
 * The resolution and crop that render part of a page within `maxEdgePx`
 * (MAX_EDGE_PX when not given). `region` is one of REGIONS, or a { top, bottom }
 * band in fractions of the page height (a zoomed block). Exported for tests;
 * pixel values are what pdftoppm is given.
 */
export function renderPlan(
  pageSize,
  region = 'full',
  dpi = DEFAULT_DPI,
  maxEdgePx = MAX_EDGE_PX
) {
  const span = spanOf(region)
  const whole = isWhole(span)
  return {
    ...planSpan(pageSize, span.top, span.bottom, {
      dpi,
      maxEdgePx,
      zoom: whole ? 1 : REGION_ZOOM,
      crop: !whole,
    }),
  }
}

/**
 * The two overlapping halves of a view, top then bottom. Each has its own
 * resolution, so the cap applies to each half: a small-image model reads the
 * body text of either.
 */
function halvesOf(pageSize, span, { dpi, maxEdgePx, zoom }) {
  const height = span.bottom - span.top
  const overlap = SPLIT_OVERLAP * height
  const middle = span.top + height / 2
  const options = { dpi, maxEdgePx, zoom, crop: true }
  return [
    {
      part: 'top',
      plan: planSpan(pageSize, span.top, middle + overlap / 2, options),
    },
    {
      part: 'bottom',
      plan: planSpan(pageSize, middle - overlap / 2, span.bottom, options),
    },
  ]
}

/**
 * The band of a page a block of source lines takes up, from SyncTeX's boxes
 * (in points; a box's v is its bottom edge and height reaches up from it),
 * padded and at least FOCUS_MIN_HEIGHT of the page, as fractions.
 */
export function focusSpan(boxes, pageHeight) {
  let top = Infinity
  let bottom = -Infinity
  for (const box of boxes) {
    top = Math.min(top, box.v - (box.height || 0))
    bottom = Math.max(bottom, box.v)
  }
  top = top / pageHeight - FOCUS_PADDING
  bottom = bottom / pageHeight + FOCUS_PADDING
  if (bottom - top < FOCUS_MIN_HEIGHT) {
    const middle = (top + bottom) / 2
    top = middle - FOCUS_MIN_HEIGHT / 2
    bottom = middle + FOCUS_MIN_HEIGHT / 2
  }
  if (top < 0) [top, bottom] = [0, bottom - top]
  if (bottom > 1) [top, bottom] = [top - (bottom - 1), 1]
  return { top: clamp(top, 0, 1), bottom: clamp(bottom, 0, 1) }
}

/**
 * Up to `count` lines from `first` to `last`, both ends included, spread
 * evenly: what a long block is sampled by.
 */
export function sampleLines(first, last, count = FOCUS_PROBES) {
  const span = last - first
  if (span + 1 <= count) {
    return Array.from({ length: span + 1 }, (_, i) => first + i)
  }
  const lines = new Set()
  for (let i = 0; i < count; i++) {
    lines.add(first + Math.round((span * i) / (count - 1)))
  }
  return [...lines]
}

/** Contiguous line spans per file, in the order the files first appear. */
export function sourceRangesFrom(entries) {
  const spans = new Map()
  for (const { path, line } of entries) {
    const span = spans.get(path)
    if (!span) spans.set(path, { path, startLine: line, endLine: line })
    else {
      span.startLine = Math.min(span.startLine, line)
      span.endLine = Math.max(span.endLine, line)
    }
  }
  return [...spans.values()]
}

/**
 * The bad boxes that belong on `page`: reported while TeX was building it, or
 * from a source line SyncTeX places on it.
 */
export function badBoxesOnPage(typesetting, { page, ranges, rootDocPath }) {
  const baseDir = rootDirectory(rootDocPath)
  const inRanges = (path, line) =>
    path != null &&
    line != null &&
    ranges.some(
      range =>
        range.path === path &&
        line >= range.startLine - 1 &&
        line <= range.endLine + 1
    )
  const boxes = []
  for (const entry of typesetting ?? []) {
    const path = normalizeLogPath(entry.file, baseDir)
    const line = entry.line ?? null
    if (entry.page !== page && !inRanges(path, line)) continue
    boxes.push({ path, line, message: entry.message })
  }
  return boxes
}

/**
 * Bad boxes grouped by page, with the count and the worst one: the widest
 * overfull box, or else the first reported. `pages` maps each page to a list
 * of bad boxes `{ path, line, message }`.
 */
function summariseBadBoxes(pages) {
  const byPage = new Map()
  for (const [page, boxes] of pages) {
    let worst = null
    let width = -2
    for (const box of boxes) {
      const tooWide = /Overfull .*?\(([\d.]+)pt too/.exec(box.message ?? '')
      const boxWidth = tooWide ? parseFloat(tooWide[1]) : -1
      if (boxWidth > width) {
        width = boxWidth
        worst = box
      }
    }
    byPage.set(page, { count: boxes.length, worst, boxes })
  }
  return byPage
}

/**
 * The bad boxes TeX reported while building each page, counted, with the
 * worst one: the widest overfull box, or else the first reported. Pages come
 * from the `[N` markers of the log; see locatedBadBoxes for SyncTeX's pages.
 */
export function badBoxesByPage(typesetting, rootDocPath) {
  const baseDir = rootDirectory(rootDocPath)
  const pages = new Map()
  for (const entry of typesetting ?? []) {
    if (!Number.isInteger(entry.page)) continue
    const list = pages.get(entry.page) ?? []
    list.push({
      path: normalizeLogPath(entry.file, baseDir),
      line: entry.line ?? null,
      message: entry.message,
    })
    pages.set(entry.page, list)
  }
  const summary = summariseBadBoxes(pages)
  for (const found of summary.values()) {
    found.worst = found.worst
      ? {
          path: found.worst.path,
          line: found.worst.line,
          message: found.worst.message,
        }
      : null
  }
  return summary
}

/**
 * The bands that hold the page's body: a short band set apart at the very
 * top (a running header) or bottom (the page number) is not body.
 */
export function bodyBands(bands) {
  let body = bands ?? []
  const short = band => band.bottom - band.top < MARGIN_BAND_MAX_HEIGHT
  const first = body[0]
  if (
    first &&
    short(first) &&
    first.bottom < HEADER_ZONE &&
    (!body[1] || body[1].top - first.bottom > MARGIN_BAND_GAP)
  ) {
    body = body.slice(1)
  }
  const last = body.at(-1)
  const beforeLast = body.at(-2)
  if (
    last &&
    short(last) &&
    last.top > FOOTER_ZONE &&
    (!beforeLast || last.top - beforeLast.bottom > MARGIN_BAND_GAP)
  ) {
    body = body.slice(0, -1)
  }
  return body
}

/**
 * What measuring a page found, from its ink bands: blank, where the body ends
 * when that is early, and large empty bands inside it. Fractions of the page
 * in, percent out. The last page of a document may end anywhere.
 */
export function layoutFindings(bands, { lastPage = false } = {}) {
  const body = bodyBands(bands)
  if (body.length === 0) {
    return { blank: true, endsAt: null, gaps: [], body: null }
  }
  const box = {
    top: body[0].top,
    bottom: body.at(-1).bottom,
    left: Math.min(...body.map(band => band.left)),
    right: Math.max(...body.map(band => band.right)),
  }
  const gaps = []
  for (let i = 1; i < body.length; i++) {
    if (body[i].top - body[i - 1].bottom >= MIN_EMPTY_BAND) {
      gaps.push({
        top: percent(body[i - 1].bottom),
        bottom: percent(body[i].top),
      })
    }
  }
  return {
    blank: false,
    endsAt: !lastPage && box.bottom < ENDS_EARLY ? percent(box.bottom) : null,
    gaps,
    body: box,
  }
}

function isInk(data, offset, channels) {
  if (channels === 1) return data[offset] < INK_THRESHOLD
  return (
    data[offset] < INK_THRESHOLD ||
    data[offset + 1] < INK_THRESHOLD ||
    data[offset + 2] < INK_THRESHOLD
  )
}

/**
 * Runs of rows, between `top` and `bottom` (fractions), with ink in the
 * x-range [from, to) (fractions of the width). `side` 'right' reports the
 * outermost ink nearest `to`, 'left' the one nearest `from`; each run carries
 * that edge as a fraction of the width (`extent`).
 */
export function inkBetween(raster, { side, from, to, top = 0, bottom = 1 }) {
  const { width, height, channels, data } = raster
  const start = clamp(Math.round(from * width), 0, width)
  const end = clamp(Math.round(to * width), 0, width)
  const firstRow = Math.max(0, Math.floor(top * height))
  const lastRow = Math.min(height, Math.ceil(bottom * height))
  const mergeRows = Math.max(1, Math.round(height * 0.01))
  const runs = []
  let run = null
  for (let row = firstRow; row < lastRow; row++) {
    // The outermost inked column of the row, scanning inwards from the side
    let outer = -1
    if (side === 'right') {
      for (let x = end - 1; x >= start && outer < 0; x--) {
        if (isInk(data, (row * width + x) * channels, channels)) outer = x + 1
      }
    } else {
      for (let x = start; x < end && outer < 0; x++) {
        if (isInk(data, (row * width + x) * channels, channels)) outer = x
      }
    }
    if (outer < 0) continue
    const further = (a, b) =>
      side === 'right' ? Math.max(a, b) : Math.min(a, b)
    if (run && row - run.lastRow <= mergeRows) {
      run.lastRow = row
      run.outer = further(run.outer, outer)
    } else {
      run = { firstRow: row, lastRow: row, outer }
      runs.push(run)
    }
  }
  return runs.map(found => ({
    top: found.firstRow / height,
    bottom: (found.lastRow + 1) / height,
    extent: found.outer / width,
  }))
}

/**
 * Runs of rows, between `top` and `bottom` (fractions), with ink to the
 * right of `limit` (side 'right') or to the left of it (side 'left'), each
 * with the outermost ink's edge as a fraction of the width.
 */
export function inkBeyond(raster, { side, limit, top = 0, bottom = 1 }) {
  const runs = inkBetween(raster, {
    side,
    from: side === 'right' ? limit : 0,
    to: side === 'right' ? 1 : limit,
    top,
    bottom,
  })
  return runs.map(run => ({
    ...run,
    beyond: side === 'right' ? run.extent - limit : limit - run.extent,
  }))
}

/** A fraction of the page width that is OVERFLOW_TOLERANCE_MM wide. */
function toleranceOf(widthPt) {
  return (OVERFLOW_TOLERANCE_MM * (72 / 25.4)) / widthPt
}

function millimetres(fraction, widthPt) {
  return Math.round(((fraction * widthPt * 25.4) / 72) * 10) / 10
}

/**
 * Ink past the text block that the other pages of the same size share, or
 * past the paper's safe edge. `textBlock` is null when there are too few
 * pages to tell what the text block is.
 */
export function overflowFindings(raster, { body, textBlock, widthPt }) {
  if (!body) return []
  const tolerance = toleranceOf(widthPt)
  const toMm = fraction => millimetres(fraction, widthPt)
  const found = []
  for (const side of ['right', 'left']) {
    const reference = textBlock ? 'textBlock' : 'paper'
    const limit = textBlock
      ? side === 'right'
        ? Math.min(textBlock.right + tolerance, 1 - PAPER_EDGE)
        : Math.max(textBlock.left - tolerance, PAPER_EDGE)
      : side === 'right'
        ? 1 - PAPER_EDGE
        : PAPER_EDGE
    const runs = inkBeyond(raster, {
      side,
      limit,
      top: body.top,
      bottom: body.bottom,
    })
    for (const run of runs) {
      // Past the text block: measured from its edge, not from the tolerance
      // line. Near the paper: how much paper is left beyond the ink.
      const mm = textBlock
        ? toMm(
            side === 'right'
              ? run.extent - textBlock.right
              : textBlock.left - run.extent
          )
        : toMm(side === 'right' ? 1 - run.extent : run.extent)
      if (textBlock && mm < MIN_OVERFLOW_MM) continue
      found.push({
        side,
        reference,
        mm,
        top: percent(run.top),
        bottom: percent(run.bottom),
      })
    }
  }
  return keepWorstRuns(found, Boolean(textBlock))
}

/**
 * Ink past each column of a multi-column page. `refs` are the reference
 * columns, `{ left, right }` as fractions of the width, one per column left to
 * right. `bands` holds, for each column, the vertical extent of each of its
 * text lines (`{ top, bottom }` as fractions of the height): ink is only looked
 * for beside a line of the column's own text, so a footer in the gutter is not
 * taken for an overhang. Ink between a column and its neighbour's reference
 * edge is the gutter, and counts; ink past the neighbour's edge is that
 * column's text. `gutterBands` are the rows of words that sit in a gutter (a
 * page number or a header beside the columns): a text line on the same row
 * shares that ink, so it is not checked.
 */
export function columnOverflowFindings(
  raster,
  { refs, bands, widthPt, gutterBands = [] }
) {
  const tolerance = toleranceOf(widthPt)
  const toMm = fraction => millimetres(fraction, widthPt)
  const found = []
  refs.forEach((ref, index) => {
    const lineBands = bands[index] ?? []
    const next = refs[index + 1]
    const previous = refs[index - 1]
    const rightStop = next ? next.left - tolerance : 1 - PAPER_EDGE
    const leftStop = previous ? previous.right + tolerance : PAPER_EDGE
    for (const band of lineBands) {
      if (
        gutterBands.some(
          gutter => gutter.top < band.bottom && gutter.bottom > band.top
        )
      ) {
        continue
      }
      const sides = [
        {
          runs: inkBetween(raster, {
            side: 'right',
            from: ref.right + tolerance,
            to: rightStop,
            top: band.top,
            bottom: band.bottom,
          }),
          side: 'right',
          beyond: extent => extent - ref.right,
        },
        {
          runs: inkBetween(raster, {
            side: 'left',
            from: leftStop,
            to: ref.left - tolerance,
            top: band.top,
            bottom: band.bottom,
          }),
          side: 'left',
          beyond: extent => ref.left - extent,
        },
      ]
      for (const { side, runs, beyond } of sides) {
        for (const run of runs) {
          const mm = toMm(beyond(run.extent))
          if (mm < MIN_OVERFLOW_MM) continue
          found.push({
            side,
            reference: 'column',
            column: index + 1,
            mm,
            top: percent(run.top),
            bottom: percent(run.bottom),
          })
        }
      }
    }
  })
  return keepWorstRuns(found, true)
}

// A column's edges from its own body lines need this many of them.
const LOCAL_REF_MIN_LINES = 5

function percentileOf(sorted, share) {
  const at = clamp(
    Math.round(share * (sorted.length - 1)),
    0,
    sorted.length - 1
  )
  return sorted[at]
}

/**
 * The reference columns of one page, from its own body lines, for when the
 * document has too few pages of the same layout for columnReferences. The
 * edges are the 90th percentile of the lines' right ends and the 10th of their
 * left ends: a line that overhangs is one of the few at the far end, while
 * ragged lines still reach their column's edge. Null for a column with too
 * few body lines to tell.
 *
 * @param {Array<{left: number, right: number}>} columns in points
 * @param {Array<{xMin: number, xMax: number}>} lines lines of the page, in points
 * @param {number} widthPt the page width
 * @returns {Array<{left: number, right: number}|null>} fractions of the width
 */
export function localColumnReferences(columns, lines, widthPt) {
  return columns.map(column => {
    const columnWidth = column.right - column.left
    const body = lines.filter(line => {
      const centre = (line.xMin + line.xMax) / 2
      return (
        centre >= column.left - 1 &&
        centre <= column.right + 1 &&
        line.xMax - line.xMin >= BODY_LINE_SHARE * columnWidth
      )
    })
    if (body.length < LOCAL_REF_MIN_LINES) return null
    const lefts = body.map(line => line.xMin).sort((a, b) => a - b)
    const rights = body.map(line => line.xMax).sort((a, b) => a - b)
    return {
      left: percentileOf(lefts, 0.1) / widthPt,
      right: percentileOf(rights, 0.9) / widthPt,
    }
  })
}

/**
 * The worst few runs, furthest past the edge first, then in reading order. An
 * overhang seen on both sides of one row band (a line past a column's edge
 * into the gutter, and the gutter ink as the next column's) is one run.
 */
function keepWorstRuns(found, pastEdge) {
  found.sort((a, b) => (pastEdge ? b.mm - a.mm : a.mm - b.mm))
  const kept = []
  for (const run of found) {
    if (kept.some(other => other.top < run.bottom && run.top < other.bottom))
      continue
    kept.push(run)
  }
  return kept.sort((a, b) => a.top - b.top)
}

/**
 * The text block of each page size: the median body edges of its pages, once
 * at least three pages of that size have a single-column body. Pages with
 * several columns have their own references, see columnReferences.
 */
export function textBlocks(pages) {
  const groups = new Map()
  for (const page of pages) {
    if (!page.body || (page.columns?.length ?? 1) > 1) continue
    const key = `${Math.round(page.size.width)}x${Math.round(page.size.height)}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(page.body)
  }
  const blocks = new Map()
  for (const [key, bodies] of groups) {
    if (bodies.length < 3) continue
    blocks.set(key, {
      left: median(bodies.map(body => body.left)),
      right: median(bodies.map(body => body.right)),
    })
  }
  return size =>
    blocks.get(`${Math.round(size.width)}x${Math.round(size.height)}`) ?? null
}

/**
 * The reference columns of each page size with `count` columns: the median
 * edges of each column's text over the pages of that size, once at least three
 * pages have that many columns. A column's text edges come from the text
 * layer, and a median across pages keeps one overhanging line from moving it.
 */
export function columnReferences(pages) {
  const groups = new Map()
  for (const page of pages) {
    const count = page.columns?.length ?? 0
    if (count < 2) continue
    const key = `${Math.round(page.size.width)}x${Math.round(page.size.height)}x${count}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(page)
  }
  const refs = new Map()
  for (const [key, members] of groups) {
    if (members.length < 3) continue
    const count = members[0].columns.length
    const width = members[0].size.width
    refs.set(
      key,
      Array.from({ length: count }, (_, index) => ({
        left: median(members.map(page => page.columns[index].left / width)),
        right: median(members.map(page => page.columns[index].right / width)),
      }))
    )
  }
  return (size, count) =>
    refs.get(`${Math.round(size.width)}x${Math.round(size.height)}x${count}`) ??
    null
}

/**
 * How many thumbnails per row, and the DPI that fits them into about
 * OVERVIEW_TARGET_PIXELS.
 */
export function overviewLayout(sizes) {
  const n = Math.max(1, sizes.length)
  const columns = n <= 4 ? n : n <= 6 || n === 9 ? 3 : 4
  const rows = Math.ceil(n / columns)
  const width = Math.max(...sizes.map(size => size.width), 1)
  const height = Math.max(...sizes.map(size => size.height), 1)
  const scale = Math.sqrt(
    OVERVIEW_TARGET_PIXELS / (columns * rows * width * height)
  )
  return {
    columns,
    dpi: Math.max(OVERVIEW_MIN_DPI, Math.floor(scale * 72)),
  }
}

/** The output options after defaults and limits. Absent options keep the old output. */
export function renderOptions({
  grayscale,
  maxEdgePx,
  split,
  labels,
  defects,
} = {}) {
  const edge = Number(maxEdgePx)
  return {
    grayscale: grayscale === true,
    maxEdgePx:
      maxEdgePx == null || !Number.isFinite(edge)
        ? MAX_EDGE_PX
        : Math.min(
            MAX_EDGE_PX_LIMIT,
            Math.max(MIN_EDGE_PX, Math.round(edge))
          ),
    split: split === 'halves' ? 'halves' : 'none',
    labels: labels === true,
    defects: defects === true,
  }
}

function isMissingOutput(err) {
  return (
    err instanceof Errors.OutputFileFetchFailedError ||
    err instanceof Errors.NotFoundError
  )
}

function isNoSynctex(err) {
  return err?.code === PDF_PAGE_ERRORS.SYNCTEX_UNAVAILABLE
}

/** Runs at most `limit` tasks at once; the rest wait their turn. */
function limiter(limit) {
  let active = 0
  const waiting = []
  return async function run(task) {
    if (active >= limit) await new Promise(resolve => waiting.push(resolve))
    active++
    try {
      return await task()
    } finally {
      active--
      waiting.shift()?.()
    }
  }
}

/** The bytes of the images a cached result holds, for the cache budget. */
function imageBytesOf(value) {
  let bytes = 4096
  for (const image of [...(value.images ?? []), value.image]) {
    if (image?.buffer) bytes += image.buffer.length
  }
  return bytes
}

function imageOutput(image, extra = {}) {
  return {
    mediaType: image.mediaType,
    data: image.buffer.toString('base64'),
    bytes: image.buffer.length,
    dpi: image.dpi,
    width: image.width,
    height: image.height,
    ...extra,
  }
}

/**
 * Build an inspector over the given compile backends. The default export uses
 * the real ones; tests pass fakes.
 */
export function createPdfPageInspector({
  getOutputFileStream = (...args) =>
    ClsiManager.promises.getOutputFileStream(...args),
  syncTeX = (...args) => CompileManager.promises.syncTeX(...args),
  execFile = promisify(execFileCallback),
  tmpDir = os.tmpdir(),
  maxOverviewPages = MAX_OVERVIEW_PAGES,
  maxLocatedMatches = MAX_LOCATED_MATCHES,
} = {}) {
  const queue = limiter(MAX_CONCURRENT_RENDERS)
  const syncLimit = limiter(SYNCTEX_CONCURRENCY)
  // Results hold rendered images as Buffers, within a byte budget.
  const cache = new BoundedLru({
    maxEntries: MAX_CACHED_PAGES,
    maxBytes: MAX_CACHED_IMAGE_BYTES,
    sizeOf: imageBytesOf,
  })
  const synctexCache = new BoundedLru({ maxEntries: MAX_SYNCTEX_CACHE })
  const logCache = new BoundedLru({ maxEntries: MAX_CACHED_LOGS })
  const pdfs = new Map()
  let sweepTimer = null

  async function run(command, args, { maxBuffer = 1024 * 1024 } = {}) {
    try {
      return await execFile(command, args, {
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer,
      })
    } catch (err) {
      if (err?.code === 'ENOENT') {
        throw new PdfPageError(
          PDF_PAGE_ERRORS.RENDERER_UNAVAILABLE,
          `PDF pages cannot be rendered on this server: ${command} (poppler-utils) is not installed.`
        )
      }
      throw new PdfPageError(
        PDF_PAGE_ERRORS.RENDER_FAILED,
        `${command} could not read the PDF${err?.killed ? ' in time' : ''}.`
      )
    }
  }

  async function download(build, target) {
    let stream
    try {
      stream = await getOutputFileStream(
        build.projectId,
        build.userId,
        build.clsiServerId,
        build.buildId,
        'output.pdf'
      )
    } catch (err) {
      if (isMissingOutput(err)) {
        throw new PdfPageError(
          PDF_PAGE_ERRORS.NO_PDF,
          'This build has no PDF: the compile failed before LaTeX wrote one.'
        )
      }
      throw err
    }
    try {
      await pipeBounded(stream, target, MAX_OUTPUT_PDF_BYTES)
    } catch (err) {
      if (err instanceof OutputTooLargeError) {
        throw new PdfPageError(
          PDF_PAGE_ERRORS.RENDER_FAILED,
          'The PDF of this build is too large to inspect.'
        )
      }
      throw err
    }
  }

  async function fetchPdf(build) {
    const dir = await fsPromises.mkdtemp(Path.join(tmpDir, 'pdf-page-'))
    try {
      const path = Path.join(dir, 'output.pdf')
      await download(build, path)
      return { dir, path, text: new Map(), fonts: null, renders: 0 }
    } catch (err) {
      await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => {})
      throw err
    }
  }

  /**
   * Drops PDFs nobody is using once there are too many or they have sat
   * unused for PDF_IDLE_MS, and checks again later while any are kept.
   */
  function sweep() {
    const now = Date.now()
    let excess = pdfs.size - MAX_CACHED_PDFS
    for (const [key, entry] of pdfs) {
      if (entry.users > 0) continue
      if (excess > 0 || now - entry.usedAt > PDF_IDLE_MS) {
        pdfs.delete(key)
        excess--
        entry.file.then(
          file =>
            fsPromises
              .rm(file.dir, { recursive: true, force: true })
              .catch(() => {}),
          () => {}
        )
      }
    }
    if (!sweepTimer && pdfs.size > 0) {
      sweepTimer = setTimeout(() => {
        sweepTimer = null
        sweep()
      }, PDF_IDLE_MS)
      sweepTimer.unref?.()
    }
  }

  /** Runs `task` with the build's PDF on disk, downloading it once. */
  async function withPdf(build, task) {
    const key = [build.projectId, build.userId, build.buildId].join(':')
    let entry = pdfs.get(key)
    if (entry) {
      pdfs.delete(key)
    } else {
      entry = { users: 0, usedAt: Date.now(), file: fetchPdf(build) }
      entry.file.catch(() => {
        if (pdfs.get(key) === entry) pdfs.delete(key)
      })
    }
    pdfs.set(key, entry)
    entry.users++
    try {
      return await task(await entry.file)
    } finally {
      entry.users--
      entry.usedAt = Date.now()
      sweep()
    }
  }

  function unreadable() {
    return new PdfPageError(
      PDF_PAGE_ERRORS.RENDER_FAILED,
      'The PDF of this build could not be read.'
    )
  }

  function outOfRange(page, pageCount) {
    return new PdfPageError(
      PDF_PAGE_ERRORS.PAGE_OUT_OF_RANGE,
      `Page ${page} does not exist: the PDF has ${pageCount} page(s).`,
      { pageCount }
    )
  }

  async function pageCountOf(file) {
    if (!file.pageCount) {
      const { pageCount } = parsePageSizes(
        (await run('pdfinfo', [file.path])).stdout
      )
      if (!pageCount) throw unreadable()
      file.pageCount = pageCount
    }
    return file.pageCount
  }

  /**
   * The page count, and the sizes of pages `from` to `to`. pdfinfo refuses a
   * first page past the end, so that is checked against the count first.
   */
  async function pageSizes(file, from, to) {
    const pageCount = await pageCountOf(file)
    if (from > pageCount) throw outOfRange(from, pageCount)
    const info = await run('pdfinfo', [
      '-f',
      String(from),
      '-l',
      String(Math.min(to, pageCount)),
      file.path,
    ])
    const { sizes } = parsePageSizes(info.stdout)
    if (!sizes.has(from)) throw unreadable()
    return { pageCount, sizes }
  }

  /**
   * The text layer of pages `from` to `to`, read TEXT_CHUNK_PAGES at a time
   * and kept with the PDF for the next search.
   */
  async function textPages(file, from, to) {
    const missing = []
    for (let page = from; page <= to; page++) {
      if (!file.text.has(page)) missing.push(page)
    }
    const read = new Map()
    for (let i = 0; i < missing.length; ) {
      const first = missing[i]
      let last = first
      while (
        i + 1 < missing.length &&
        missing[i + 1] === last + 1 &&
        last - first + 1 < TEXT_CHUNK_PAGES
      ) {
        last = missing[++i]
      }
      i++
      const out = Path.join(file.dir, `text-${first}-${last}.html`)
      await run('pdftotext', [
        '-bbox-layout',
        '-enc',
        'UTF-8',
        '-f',
        String(first),
        '-l',
        String(last),
        file.path,
        out,
      ])
      try {
        const parsed = parseBboxLayout(await fsPromises.readFile(out, 'utf8'))
        parsed.forEach((page, index) => read.set(first + index, page))
      } finally {
        await fsPromises.rm(out, { force: true }).catch(() => {})
      }
    }
    for (const [page, text] of read) {
      if (file.text.size < MAX_CACHED_TEXT_PAGES) file.text.set(page, text)
    }
    const pages = []
    for (let page = from; page <= to; page++) {
      pages.push({
        page,
        text: file.text.get(page) ??
          read.get(page) ?? { width: 0, height: 0, lines: [], blocks: [] },
      })
    }
    return pages
  }

  async function fontsOf(file) {
    if (!file.fonts) {
      file.fonts = run('pdffonts', [file.path], { maxBuffer: 4 * 1024 * 1024 })
        .then(info => parsePdfFonts(info.stdout))
        .catch(() => null)
    }
    return file.fonts
  }

  async function readLog(build) {
    let stream
    try {
      stream = await getOutputFileStream(
        build.projectId,
        build.userId,
        build.clsiServerId,
        build.buildId,
        'output.log'
      )
    } catch (err) {
      if (isMissingOutput(err)) return null
      throw err
    }
    // A runaway log is cut at its start: the bad boxes it holds come first.
    const { buffer } = await readBounded(stream, MAX_OUTPUT_LOG_BYTES)
    return buffer.toString('utf8')
  }

  /** The bad boxes of a build's log, parsed once per build. */
  async function typesettingOf(build) {
    const key = [build.projectId, build.userId, build.buildId].join(':')
    const cached = logCache.get(key)
    if (cached) return cached
    const log = await readLog(build).catch(() => null)
    if (log == null) return []
    const typesetting = parseLatexLog(log).typesetting ?? []
    logCache.set(key, typesetting)
    return typesetting
  }

  function syncOptions(build, validatedOptions) {
    return {
      compileFromClsiCache: false,
      clsiServerId: build.clsiServerId,
      validatedOptions: build.buildId
        ? { ...validatedOptions, buildId: build.buildId }
        : validatedOptions,
    }
  }

  /**
   * One SyncTeX question about a build. Answers are kept per build and user,
   * so a second look at the same page costs nothing; at most SYNCTEX_CONCURRENCY
   * run at once. A build with no SyncTeX file says so as its own error.
   */
  async function runSyncTeX(build, direction, validated) {
    const key = JSON.stringify([
      build.projectId,
      build.userId,
      build.buildId,
      direction,
      validated,
    ])
    const cached = synctexCache.get(key)
    if (cached) return cached
    let result
    try {
      result = await syncLimit(() =>
        syncTeX(build.projectId, build.userId, {
          direction,
          ...syncOptions(build, validated),
        })
      )
    } catch (err) {
      if (err instanceof Errors.NotFoundError) {
        throw new PdfPageError(
          PDF_PAGE_ERRORS.SYNCTEX_UNAVAILABLE,
          NO_SYNCTEX_MESSAGE
        )
      }
      throw err
    }
    synctexCache.set(key, result)
    return result
  }

  /** The source line at (h, v) on a page, in points from the top left. */
  async function sourceAt(build, page, h, v) {
    const result = await runSyncTeX(build, 'pdf', {
      page,
      h: Math.round(h),
      v: Math.round(v),
    })
    const hit = (result?.code ?? []).find(
      entry => entry?.file && Number.isInteger(entry.line) && entry.line > 0
    )
    return hit ? { path: projectPath(hit.file), line: hit.line } : null
  }

  /** Where SyncTeX typesets one source line: its boxes, maybe none. */
  async function positionsOf(build, file, line) {
    const result = await runSyncTeX(build, 'code', {
      file,
      line,
      column: 0,
    })
    return (result?.pdf ?? []).filter(
      position => Number.isInteger(position?.page) && position.page > 0
    )
  }

  /** Where a source line is typeset, trying the next few when it is not. */
  async function locate(build, path, line) {
    const file = projectPath(path)
    for (let probe = line; probe <= line + LOCATE_LOOKAHEAD; probe++) {
      const position = (await positionsOf(build, file, probe))[0]
      if (position) return { path: file, line: probe, position }
    }
    return null
  }

  /**
   * Where a block of source lines is typeset: the page its first typeset line
   * is on, the boxes on that page, and any later pages it runs onto.
   */
  async function locateBlock(build, path, line, endLine) {
    const file = projectPath(path)
    const probes = sampleLines(line, endLine)
    const found = await Promise.all(
      probes.map(async probe => ({
        line: probe,
        positions: await positionsOf(build, file, probe),
      }))
    )
    const first = found.find(entry => entry.positions.length > 0)
    if (!first) return null
    const page = first.positions[0].page
    const boxes = []
    const later = new Set()
    for (const entry of found) {
      for (const position of entry.positions) {
        if (position.page === page) boxes.push(position)
        else if (position.page > page) later.add(position.page)
      }
    }
    return {
      located: { path: file, line: first.line, position: first.positions[0] },
      boxes,
      continuesOn: [...later].sort((a, b) => a - b),
    }
  }

  /**
   * The source at a probe on a text line, trying its middle, then its quarter
   * and three-quarter points: a probe that lands between two words misses.
   * `state.unavailable` is set when the build has no SyncTeX at all.
   */
  async function probeLine(build, page, line, state) {
    const y = (line.yMin + line.yMax) / 2
    const width = line.xMax - line.xMin
    const xs = [
      (line.xMin + line.xMax) / 2,
      line.xMin + width * 0.25,
      line.xMin + width * 0.75,
    ]
    for (const x of xs) {
      const hit = await sourceAt(build, page, x, y).catch(err => {
        if (isNoSynctex(err)) state.unavailable = true
        return null
      })
      if (hit || state.unavailable) return hit
    }
    return null
  }

  /**
   * The source typeset at points of a page, probed on its text. Each column
   * gets `rows` probes spread over `span` (fractions of the height), each
   * snapped to the nearest text line in that column; with no text in the span,
   * the middle of the page is probed instead. Returns the map (percent heights,
   * merged where consecutive probes agree) and why it is or is not empty.
   */
  async function sourceMap(
    build,
    page,
    pageSize,
    text,
    span,
    { rows, columns = [] }
  ) {
    const height = pageSize.height
    const top = span.top * height
    const bottom = span.bottom * height
    const at = i => top + ((bottom - top) * (i + 0.5)) / rows
    const lines = (text?.lines ?? []).filter(line => {
      const y = (line.yMin + line.yMax) / 2
      return y >= top && y <= bottom
    })
    const state = { unavailable: false }
    let probes
    if (lines.length === 0) {
      probes = Array.from({ length: rows }, (_, i) => ({
        x: pageSize.width / 2,
        y: at(i),
      }))
    } else {
      const groups = columns.length > 1 ? columns : [null]
      const perColumn =
        groups.length > 1 ? Math.max(3, Math.round(rows / groups.length)) : rows
      probes = []
      for (const column of groups) {
        // Lines across the page (titles, full-width floats) belong to no column.
        const inColumn = column
          ? lines.filter(line => {
              const centre = (line.xMin + line.xMax) / 2
              const narrow =
                line.xMax - line.xMin < FULL_WIDTH_SHARE * pageSize.width
              return (
                narrow &&
                centre >= column.left - 1 &&
                centre <= column.right + 1
              )
            })
          : lines
        if (inColumn.length === 0) continue
        for (let i = 0; i < perColumn; i++) {
          const target = top + ((bottom - top) * (i + 0.5)) / perColumn
          const nearest = inColumn.reduce((best, line) => {
            const y = (line.yMin + line.yMax) / 2
            return Math.abs(y - target) <
              Math.abs((best.yMin + best.yMax) / 2 - target)
              ? line
              : best
          })
          probes.push({ line: nearest })
        }
      }
    }
    // Probes at the same spot once are enough.
    const seen = new Set()
    probes = probes.filter(probe => {
      const key = probe.line
        ? `${probe.line.xMin},${probe.line.yMin}`
        : `${Math.round(probe.x)},${Math.round(probe.y)}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    const hits = await Promise.all(
      probes.map(probe => {
        if (probe.line) return probeLine(build, page, probe.line, state)
        return sourceAt(build, page, probe.x, probe.y).catch(err => {
          if (isNoSynctex(err)) state.unavailable = true
          return null
        })
      })
    )
    const points = probes.map((probe, i) => ({
      y: probe.line ? (probe.line.yMin + probe.line.yMax) / 2 : probe.y,
      hit: hits[i],
    }))
    points.sort((a, b) => a.y - b.y)
    const map = []
    for (const { y, hit } of points) {
      if (!hit) continue
      const previous = map.at(-1)
      if (
        previous &&
        previous.path === hit.path &&
        previous.line === hit.line
      ) {
        continue
      }
      map.push({ y: Math.round((100 * y) / height), ...hit })
    }
    let status
    if (state.unavailable) status = 'no_synctex'
    else if (map.length > 0) status = 'mapped'
    else status = lines.length > 0 ? 'probe_missed' : 'page_without_source'
    return { map, status, sourceNote: SOURCE_NOTES[status] }
  }

  /**
   * The units of a page that are shown, each with the source it typesets: its
   * first and last lines are probed, and the span runs from one to the other
   * when both are in the same file.
   */
  async function mapUnits(build, page, units) {
    const state = { unavailable: false }
    const entries = await Promise.all(
      units.map(async unit => {
        const probes = unitProbes(unit)
        const [first, last] = await Promise.all(
          probes.map(probe =>
            sourceAt(build, page, probe.x, probe.y).catch(err => {
              if (isNoSynctex(err)) state.unavailable = true
              return null
            })
          )
        )
        const head = first ?? last
        let source = null
        if (head) {
          const tail = last && last.path === head.path ? last : head
          source = {
            path: head.path,
            line: Math.min(head.line, tail.line),
            endLine: Math.max(head.line, tail.line),
          }
        }
        return { unit, source }
      })
    )
    return { entries, unavailable: state.unavailable }
  }

  /** Renders pages `from` to `to` with pdftoppm, one raster per page. */
  async function rasterise(file, from, to, dpi, { gray = false } = {}) {
    const dir = await fsPromises.mkdtemp(Path.join(file.dir, 'thumbs-'))
    try {
      await run('pdftoppm', [
        ...(gray ? ['-gray'] : []),
        '-r',
        String(dpi),
        '-f',
        String(from),
        '-l',
        String(to),
        file.path,
        Path.join(dir, 'p'),
      ])
      const rasters = new Map()
      for (const name of await fsPromises.readdir(dir)) {
        const match = /-(\d+)\.p[pgm]m$/.exec(name)
        if (!match) continue
        rasters.set(
          parseInt(match[1], 10),
          parsePnm(await fsPromises.readFile(Path.join(dir, name)))
        )
      }
      return rasters
    } finally {
      await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  /** One page, cropped as `plan` says, as a raster (PNM); nothing else drawn. */
  async function rasterPage(file, page, plan, { grayscale = false } = {}) {
    const cropArgs = plan.crop
      ? [
          '-x',
          String(plan.crop.x),
          '-y',
          String(plan.crop.y),
          '-W',
          String(plan.crop.width),
          '-H',
          String(plan.crop.height),
        ]
      : []
    const prefix = Path.join(file.dir, `page-${page}-${file.renders++}`)
    await run('pdftoppm', [
      ...(grayscale ? ['-gray'] : []),
      '-r',
      String(plan.dpi),
      '-f',
      String(page),
      '-l',
      String(page),
      ...cropArgs,
      '-singlefile',
      file.path,
      prefix,
    ])
    const output = `${prefix}.${grayscale ? 'pgm' : 'ppm'}`
    const data = await fsPromises.readFile(output)
    await fsPromises.rm(output, { force: true }).catch(() => {})
    return parsePnm(data)
  }

  /**
   * A page image with its block tags in a margin. The tags are placed where
   * the blocks fall in the image, so the crop and the split halves get the
   * blocks they show. The image is PNG; when it is too large to send it is
   * drawn again at a lower DPI, since a JPEG cannot carry the tags.
   */
  async function renderLabelled(
    file,
    page,
    pageSize,
    plan,
    { grayscale, units, maxEdgePx }
  ) {
    let current = plan
    for (let attempt = 0; attempt < 3; attempt++) {
      const raster = await rasterPage(file, page, current, { grayscale })
      const span = { top: current.top, bottom: current.bottom }
      const marks = unitMarks(units, {
        span,
        pageHeight: pageSize.height,
        rasterHeight: raster.height,
      }).filter(mark => mark.bottom > 0 && mark.top < raster.height)
      const longest = Math.max(raster.width, raster.height)
      const scale = clamp(Math.round(longest / 600), 2, 4)
      const labelled = addMargin(raster, marks, { scale })
      const png = encodePng(labelled)
      if (png.length <= MAX_IMAGE_BYTES) {
        return {
          buffer: png,
          mediaType: 'image/png',
          dpi: current.dpi,
          width: labelled.width,
          height: labelled.height,
        }
      }
      current = planSpan(pageSize, current.top, current.bottom, {
        dpi: current.dpi * 0.8,
        maxEdgePx,
        zoom: 1,
        crop: current.crop != null,
      })
    }
    throw new PdfPageError(
      PDF_PAGE_ERRORS.RENDER_FAILED,
      'The rendered page is too large to send as an image; view one region of it instead.'
    )
  }

  /** A picture of one plan: PNG, or JPEG when the PNG is too large to send. */
  async function render(
    file,
    page,
    pageSize,
    plan,
    { grayscale = false, units = null, maxEdgePx = MAX_EDGE_PX } = {}
  ) {
    if (units)
      return renderLabelled(file, page, pageSize, plan, {
        grayscale,
        units,
        maxEdgePx,
      })
    const cropArgs = plan.crop
      ? [
          '-x',
          String(plan.crop.x),
          '-y',
          String(plan.crop.y),
          '-W',
          String(plan.crop.width),
          '-H',
          String(plan.crop.height),
        ]
      : []
    // PNG keeps text and thin rules sharp; a page full of photographs can
    // outgrow the image limit, and only then is it sent as JPEG.
    const formats = [
      { args: ['-png'], ext: 'png', mediaType: 'image/png' },
      {
        args: ['-jpeg', '-jpegopt', 'quality=85'],
        ext: 'jpg',
        mediaType: 'image/jpeg',
      },
      {
        args: ['-jpeg', '-jpegopt', 'quality=60'],
        ext: 'jpg',
        mediaType: 'image/jpeg',
      },
    ]
    const name = `page-${page}-${file.renders++}`
    for (const format of formats) {
      const prefix = Path.join(file.dir, `${name}-${format.ext}`)
      await run('pdftoppm', [
        ...(grayscale ? ['-gray'] : []),
        ...format.args,
        '-r',
        String(plan.dpi),
        '-f',
        String(page),
        '-l',
        String(page),
        ...cropArgs,
        '-singlefile',
        file.path,
        prefix,
      ])
      const output = `${prefix}.${format.ext}`
      const data = await fsPromises.readFile(output)
      await fsPromises.rm(output, { force: true }).catch(() => {})
      if (data.length > MAX_IMAGE_BYTES) continue
      return {
        mediaType: format.mediaType,
        buffer: data,
        dpi: plan.dpi,
        ...(imageSize(data) ?? {}),
      }
    }
    throw new PdfPageError(
      PDF_PAGE_ERRORS.RENDER_FAILED,
      'The rendered page is too large to send as an image; view one region of it instead.'
    )
  }

  /**
   * What measuring a page for layout found, at MEASURE_DPI in grey: the ink
   * bands, the body, and the overflow past the paper's edges (the text block
   * is not known from one page).
   */
  async function measurePage(file, page, pageSize, lastPage) {
    const plan = planSpan(pageSize, 0, 1, {
      dpi: MEASURE_DPI,
      maxEdgePx: MAX_EDGE_PX_LIMIT,
      zoom: 1,
      crop: false,
    })
    const raster = await rasterPage(file, page, plan, { grayscale: true })
    const layout = layoutFindings(analyzeInk(raster).bands, { lastPage })
    const overflow = layout.body
      ? overflowFindings(raster, {
          body: layout.body,
          textBlock: null,
          widthPt: pageSize.width,
        })
      : []
    return { layout, overflow }
  }

  function remember(key, value) {
    cache.set(key, value)
  }

  function buildOf({ projectId, userId, buildId, clsiServerId }) {
    return {
      projectId: String(projectId),
      userId: String(userId),
      buildId,
      clsiServerId: clsiServerId || undefined,
    }
  }

  function pageNumber(value, fallback) {
    const n = Math.floor(Number(value))
    return Number.isFinite(n) && n >= 1 ? n : fallback
  }

  /**
   * Inspect one page of a build.
   *
   * Give `page`, or `path` and `line` to show the page where that line is
   * typeset. With `endLine` too, the image zooms on where lines `line` to
   * `endLine` are typeset (a table, a figure, a tikzpicture), unless a
   * `region` is given. `region` zooms into one third of the page.
   * `rootDocPath` resolves the file names in the log. `withImage: false`
   * skips rasterising, for a caller whose model cannot take images; the map,
   * the bad boxes and the page's text come instead.
   *
   * Options with defaults that keep the old output: `grayscale` (8-bit grey
   * picture), `maxEdgePx` (long-edge cap, default 2400), `split: 'halves'`
   * (two overlapping pictures, parts 'top' and 'bottom'), `labels` (a margin
   * with block IDs B1.. and a `blocks` list), `defects` (a `defects` list of
   * records), and `contentHash`, echoed back for the caller's staleness check.
   *
   * @returns {Promise<{
   *   page: number, pageCount: number, pageSize: {width: number, height: number},
   *   region: string, span: {top: number, bottom: number},
   *   located: {path: string, line: number, y: number}|null,
   *   focus: {path: string, line: number, endLine: number, top: number, bottom: number, continuesOn: number[]}|null,
   *   sourceMap: Array<{y: number, path: string, line: number}>,
   *   sourceRanges: Array<{path: string, startLine: number, endLine: number}>,
   *   sourceStatus: string, sourceNote: string,
   *   badBoxes: Array<{path: string|null, line: number|null, message: string}>,
   *   text: {lines: Array<{y: number, text: string}>}|null,
   *   image: {mediaType: string, data: string, bytes: number, dpi: number, width?: number, height?: number}|null,
   *   images: Array<{data: string, mimeType: string, width: number, height: number, part: string, span: object, bytes: number, dpi: number}>,
   *   blocks?: Array<object>, defects?: Array<object>, contentHash?: string
   * }>}
   */
  async function inspect({
    projectId,
    userId,
    buildId,
    clsiServerId,
    page,
    path,
    line,
    endLine,
    region,
    rootDocPath = null,
    withImage = true,
    contentHash,
    ...options
  }) {
    const explicitRegion = REGIONS.includes(region) ? region : null
    const build = buildOf({ projectId, userId, buildId, clsiServerId })
    const shape = renderOptions(options)

    let located = null
    let block = null
    if (page == null && path) {
      const first = pageNumber(line, 1)
      const last = pageNumber(endLine, null)
      if (last && last > first && !explicitRegion) {
        block = await locateBlock(build, path, first, last)
        located = block?.located ?? null
      } else {
        located = await locate(build, path, first)
      }
      if (!located) {
        const lines =
          last && last > first ? `lines ${first}-${last}` : `line ${first}`
        throw new PdfPageError(
          PDF_PAGE_ERRORS.LINE_NOT_IN_PDF,
          `${projectPath(path)} ${lines} ${last && last > first ? 'are' : 'is'} not typeset in this PDF: in the preamble, a comment, a file the build does not include, or added after this build.`,
          {
            sourceStatus: 'line_not_in_build',
            sourceNote: SOURCE_NOTES.line_not_in_build,
          }
        )
      }
      page = located.position.page
    }
    page = pageNumber(page, 1)

    const view = block
      ? `focus:${located.path}:${pageNumber(line, 1)}-${pageNumber(endLine, 1)}`
      : (explicitRegion ?? 'full')
    const key = [
      'inspect',
      build.projectId,
      build.userId,
      buildId,
      page,
      view,
      withImage,
      rootDocPath || '',
      shape.grayscale,
      shape.maxEdgePx,
      shape.split,
      shape.labels,
      shape.defects,
    ].join(':')
    let shown = cache.get(key)
    if (!shown) {
      shown = await withPdf(build, file =>
        queue(async () => {
          const { pageCount, sizes } = await pageSizes(file, page, page)
          const pageSize = sizes.get(page)
          if (page > pageCount || !pageSize) throw outOfRange(page, pageCount)

          const span = block
            ? focusSpan(block.boxes, pageSize.height)
            : spanOf(explicitRegion ?? 'full')
          const zoomed = !isWhole(span)
          // With labels the margin takes part of the long edge.
          const cap = shape.labels
            ? shape.maxEdgePx - LABEL_STRIP_PX
            : shape.maxEdgePx
          const plan = planSpan(pageSize, span.top, span.bottom, {
            dpi: DEFAULT_DPI,
            maxEdgePx: cap,
            zoom: zoomed ? REGION_ZOOM : 1,
            crop: zoomed,
          })
          const text = await textPages(file, page, page)
            .then(read => read[0].text)
            .catch(() => null)
          // Lines that cross a gutter are cut into one piece per column.
          const laid = text ? splitByColumns(text) : null
          const laidText = laid?.page ?? text
          const columns = laid?.columns ?? []
          const wantsBlocks = shape.labels || shape.defects
          const units =
            wantsBlocks && laidText ? numberUnits(groupBlocks(laidText)) : []
          const inView = unitsInSpan(units, pageSize.height, span)
          const mapped = wantsBlocks
            ? await mapUnits(build, page, inView)
            : { entries: [], unavailable: false }
          const source = await sourceMap(
            build,
            page,
            pageSize,
            laidText,
            span,
            {
              rows: zoomed ? REGION_ROWS : FULL_PAGE_ROWS,
              columns: columns.map(column => ({
                left: column.left,
                right: column.right,
              })),
            }
          )
          const ranges = sourceRangesFrom(source.map)
          const badBoxes = badBoxesOnPage(await typesettingOf(build), {
            page,
            ranges,
            rootDocPath,
          })

          const parts =
            shape.split === 'halves'
              ? halvesOf(pageSize, span, {
                  dpi: DEFAULT_DPI,
                  maxEdgePx: cap,
                  zoom: zoomed ? REGION_ZOOM : 1,
                })
              : [{ part: 'full', plan }]
          const images = []
          if (withImage) {
            for (const { part, plan: partPlan } of parts) {
              const image = await render(file, page, pageSize, partPlan, {
                grayscale: shape.grayscale,
                units: shape.labels ? inView : null,
                maxEdgePx: cap,
              })
              images.push({
                ...image,
                part,
                span: {
                  top: percent(partPlan.top),
                  bottom: percent(partPlan.bottom),
                },
              })
            }
          }

          const blocks = mapped.entries.map(({ unit, source: where }) =>
            blockOf(unit, page, where)
          )
          if (shape.labels || shape.defects) {
            rememberBlocks(
              buildId,
              page,
              new Map(
                mapped.entries.map(({ unit, source: where }) => [
                  unit.id,
                  where ? { ...where } : null,
                ])
              ),
              build.projectId
            )
          }

          let defectRecords = null
          if (shape.defects) {
            const measured = await measurePage(
              file,
              page,
              pageSize,
              page === pageCount
            )
            defectRecords = pageDefects({
              page,
              pageSize,
              layout: measured.layout,
              overflow: measured.overflow,
              badBoxes,
              markers: text ? unresolvedMarkers(text) : { refs: 0, cites: 0 },
              blocks,
              near: percentY => sourceNear(source.map, percentY),
            })
          }

          return {
            page,
            pageCount,
            pageSize: {
              width: Math.round(pageSize.width),
              height: Math.round(pageSize.height),
            },
            region: block ? 'focus' : (explicitRegion ?? 'full'),
            span: { top: percent(span.top), bottom: percent(span.bottom) },
            focus: block
              ? {
                  path: located.path,
                  line: pageNumber(line, 1),
                  endLine: pageNumber(endLine, 1),
                  top: percent(span.top),
                  bottom: percent(span.bottom),
                  continuesOn: block.continuesOn,
                }
              : null,
            sourceMap: source.map,
            sourceRanges: ranges,
            sourceStatus: source.status,
            sourceNote: source.sourceNote,
            badBoxes,
            text: withImage || !text ? null : pageLines(text),
            images,
            blocks: shape.labels ? blocks : null,
            defects: shape.defects ? numberDefects(defectRecords) : null,
          }
        })
      )
      remember(key, shown)
    }

    const height = shown.pageSize?.height ?? 842
    const { images, blocks, defects, ...rest } = shown
    const output = {
      ...rest,
      images: images.map(image =>
        imageOutput(image, {
          part: image.part,
          span: image.span,
          mimeType: image.mediaType,
        })
      ),
      image: images[0] ? imageOutput(images[0]) : null,
      located: located
        ? {
            path: located.path,
            line: located.line,
            y: percent(located.position.v / height),
          }
        : null,
    }
    if (shape.labels) output.blocks = blocks
    if (shape.defects) output.defects = defects
    if (contentHash != null) output.contentHash = contentHash
    return output
  }

  /**
   * The text layer of pages `from` to `to`, read TEXT_CHUNK_PAGES at a time
   * and kept with the PDF for the next search.
   */

  /**
   * The pages of a build (from fromPage to toPage, all by default) as labelled
   * thumbnails in one image, with what measuring each page found and the source typeset on it.
   * `withImage: false` measures the pages without sending the picture.
   * `defects: true` adds the defect records of the pages and of the fonts.
   */
  async function overview({
    projectId,
    userId,
    buildId,
    clsiServerId,
    fromPage = 1,
    toPage,
    rootDocPath = null,
    withImage = true,
    defects = false,
    contentHash,
  }) {
    const build = buildOf({ projectId, userId, buildId, clsiServerId })
    const from = pageNumber(fromPage, 1)
    const last = Math.max(from, pageNumber(toPage, Infinity))

    const key = [
      'overview',
      build.projectId,
      build.userId,
      buildId,
      from,
      last,
      withImage,
      rootDocPath || '',
      defects === true,
    ].join(':')
    let shown = cache.get(key)
    if (!shown) {
      shown = await withPdf(build, file =>
        queue(async () => {
          const { pageCount, sizes } = await pageSizes(file, from, last)
          if (from > pageCount) throw outOfRange(from, pageCount)
          // Every page of a long build would be rasterised whole, so a range
          // past the cap is cut; toPage in the reply says where it stopped.
          const to = Math.min(last, pageCount, from + maxOverviewPages - 1)
          const pages = []
          for (let page = from; page <= to; page++) {
            const size = sizes.get(page)
            if (size) pages.push({ page, size })
          }
          const layout = overviewLayout(pages.map(entry => entry.size))

          const [measured, thumbs, fonts, texts, typesetting] =
            await Promise.all([
              rasterise(file, from, to, MEASURE_DPI, { gray: true }),
              withImage ? rasterise(file, from, to, layout.dpi) : null,
              fontsOf(file),
              textPages(file, from, to).catch(() => []),
              typesettingOf(build).catch(() => []),
            ])
          const textOf = new Map(texts.map(entry => [entry.page, entry.text]))
          const located = await locatedBadBoxes(build, typesetting, rootDocPath)
          const badBoxes = summariseBadBoxes(located)
          const markers = new Map(
            texts.map(entry => [entry.page, unresolvedMarkers(entry.text)])
          )

          for (const entry of pages) {
            entry.text = textOf.get(entry.page) ?? null
            const laid = entry.text ? splitByColumns(entry.text) : null
            entry.laid = laid?.page ?? entry.text
            entry.columns = laid?.columns ?? []
            // Words beside the columns (a page number, a header): their rows.
            entry.gutterBands = (entry.laid?.lines ?? [])
              .flatMap(line => line.words)
              .filter(word => {
                const centre = (word.xMin + word.xMax) / 2
                return !entry.columns.some(
                  column =>
                    centre >= column.left - 1 && centre <= column.right + 1
                )
              })
              .map(word => ({
                top: word.yMin / entry.size.height,
                bottom: word.yMax / entry.size.height,
              }))
            // Each column's own body lines, as bands of the page height: a line
            // a column's width long. A heading or a word of a title set across
            // the gutter is short, and its ink is not an overhang.
            entry.columnLineBands = entry.columns.map(column =>
              (entry.laid?.lines ?? [])
                .filter(line => {
                  const centre = (line.xMin + line.xMax) / 2
                  return (
                    centre >= column.left - 1 &&
                    centre <= column.right + 1 &&
                    line.xMax - line.xMin >=
                      BODY_LINE_SHARE * (column.right - column.left)
                  )
                })
                .map(line => ({
                  top: line.yMin / entry.size.height,
                  bottom: line.yMax / entry.size.height,
                }))
            )
            entry.raster = measured.get(entry.page) ?? null
            const ink = entry.raster ? analyzeInk(entry.raster) : null
            Object.assign(
              entry,
              layoutFindings(ink?.bands ?? [], {
                lastPage: entry.page === pageCount,
              })
            )
          }
          const textBlockOf = textBlocks(pages)
          const columnRefsOf = columnReferences(pages)
          await Promise.all(
            pages.map(async entry => {
              const count = entry.columns.length
              if (!entry.raster) entry.overflow = []
              else if (count > 1) {
                const refs =
                  columnRefsOf(entry.size, count) ??
                  localColumnReferences(
                    entry.columns,
                    entry.laid?.lines ?? [],
                    entry.size.width
                  )
                entry.overflow =
                  refs && refs.every(Boolean)
                    ? columnOverflowFindings(entry.raster, {
                        refs,
                        bands: entry.columnLineBands,
                        widthPt: entry.size.width,
                        gutterBands: entry.gutterBands,
                      })
                    : []
              } else {
                entry.overflow =
                  entry.raster && entry.body
                    ? overflowFindings(entry.raster, {
                        body: entry.body,
                        textBlock: textBlockOf(entry.size),
                        widthPt: entry.size.width,
                      })
                    : []
              }
              if (entry.body && entry.laid) {
                const found = await sourceMap(
                  build,
                  entry.page,
                  entry.size,
                  entry.laid,
                  {
                    top: entry.body.top,
                    bottom: entry.body.bottom,
                  },
                  { rows: OVERVIEW_ROWS, columns: entry.columns }
                )
                entry.source = found.map
                entry.sourceStatus = found.status
                entry.sourceNote = found.sourceNote
              } else {
                entry.source = []
                entry.sourceStatus = 'page_without_source'
                entry.sourceNote = SOURCE_NOTES.page_without_source
              }
            })
          )

          let image = null
          if (withImage) {
            const tiles = pages
              .filter(entry => thumbs.get(entry.page))
              .map(entry => ({
                raster: thumbs.get(entry.page),
                label: String(entry.page),
              }))
            const png = encodePng(
              composeGrid(tiles, { columns: layout.columns })
            )
            if (png.length <= MAX_IMAGE_BYTES) {
              image = {
                buffer: png,
                mediaType: 'image/png',
                dpi: layout.dpi,
                ...(imageSize(png) ?? {}),
              }
            }
          }

          const first = pages[0]?.size ?? { width: 0, height: 0 }
          const pageRows = pages.map(entry => {
            const boxes = badBoxes.get(entry.page)
            return {
              page: entry.page,
              source: entry.source,
              sourceStatus: entry.sourceStatus,
              sourceNote: entry.sourceNote,
              blank: entry.blank,
              endsAt: entry.endsAt,
              gaps: entry.gaps,
              overflow: entry.overflow,
              badBoxes: boxes?.count ?? 0,
              worstBadBox: boxes?.worst ?? null,
              unresolved: markers.get(entry.page) ?? { refs: 0, cites: 0 },
            }
          })
          const fontsFound = (await fonts) ?? {
            total: 0,
            notEmbedded: [],
            type3: [],
          }
          let defectList = null
          if (defects) {
            defectList = [
              ...pages.flatMap(entry => {
                const row = pageRows.find(item => item.page === entry.page)
                return pageDefects({
                  page: entry.page,
                  pageSize: entry.size,
                  layout:
                    entry.body !== undefined
                      ? {
                          blank: entry.blank,
                          endsAt: entry.endsAt,
                          gaps: entry.gaps,
                        }
                      : null,
                  overflow: entry.overflow,
                  badBoxes: badBoxes.get(entry.page)?.boxes ?? [],
                  markers: row.unresolved,
                  blocks: [],
                  near: percentY => sourceNear(entry.source, percentY),
                })
              }),
              ...fontDefects(fontsFound),
            ]
          }

          return {
            fromPage: from,
            toPage: to,
            pageCount,
            paper: {
              width: Math.round(first.width),
              height: Math.round(first.height),
              name: paperName(first),
              orientation:
                first.width > first.height ? 'landscape' : 'portrait',
            },
            mixedSizes: pages.some(
              entry =>
                Math.abs(entry.size.width - first.width) > 1 ||
                Math.abs(entry.size.height - first.height) > 1
            ),
            fonts: fontsFound,
            columns: layout.columns,
            pages: pageRows,
            image,
            defects: defectList ? numberDefects(defectList) : null,
          }
        })
      )
      remember(key, shown)
    }

    const { image, defects: defectRows, ...rest } = shown
    const output = {
      ...rest,
      image: image ? imageOutput(image) : null,
    }
    if (defects === true) output.defects = defectRows
    if (contentHash != null) output.contentHash = contentHash
    return output
  }

  /**
   * The bad boxes of a build, each on the page SyncTeX places its source line
   * on: the log's `[N` markers break when page numbering restarts, so they are
   * only the fallback, used when SyncTeX is unavailable or does not place a
   * line. Returns `{ page, path, line, message }` for each box, page null when
   * neither says.
   */
  async function locatedBadBoxes(build, typesetting, rootDocPath) {
    const baseDir = rootDirectory(rootDocPath)
    const state = { unavailable: false }
    const found = []
    for (const entry of typesetting ?? []) {
      const path = normalizeLogPath(entry.file, baseDir)
      const line = entry.line ?? null
      let page = Number.isInteger(entry.page) ? entry.page : null
      if (path && line != null && !state.unavailable) {
        const positions = await positionsOf(
          build,
          projectPath(path),
          line
        ).catch(err => {
          if (isNoSynctex(err)) state.unavailable = true
          return []
        })
        if (positions.length > 0) page = positions[0].page
      }
      if (page != null) {
        found.push([page, { path, line, message: entry.message }])
      }
    }
    const byPage = new Map()
    for (const [page, box] of found) {
      const list = byPage.get(page) ?? []
      list.push(box)
      byPage.set(page, list)
    }
    return byPage
  }

  /**
   * Text as it reads in the PDF, with the page, height and source line of
   * each match. Pages are read TEXT_CHUNK_PAGES at a time; every match is
   * located.
   */
  async function search({
    projectId,
    userId,
    buildId,
    clsiServerId,
    query,
    fromPage,
    toPage,
    contentHash,
  }) {
    const regex = compileQuery(String(query ?? ''))
    if (!regex) {
      throw new PdfPageError(
        PDF_PAGE_ERRORS.INVALID_QUERY,
        'Pass the text to find as query.'
      )
    }
    const build = buildOf({ projectId, userId, buildId, clsiServerId })
    const from = pageNumber(fromPage, 1)

    const found = await withPdf(build, file =>
      queue(async () => {
        const { pageCount } = await pageSizes(file, from, from)
        if (from > pageCount) throw outOfRange(from, pageCount)
        const to = Math.min(pageNumber(toPage, pageCount), pageCount)
        const matches = []
        const pages = []
        let matchCount = 0
        for (let chunk = from; chunk <= to; chunk += TEXT_CHUNK_PAGES) {
          const read = await textPages(
            file,
            chunk,
            Math.min(to, chunk + TEXT_CHUNK_PAGES - 1)
          )
          for (const { page, text } of read) {
            const hits = searchPage(text, regex)
            if (hits.length === 0) continue
            pages.push(page)
            matchCount += hits.length
            for (const hit of hits) {
              if (matches.length < maxLocatedMatches) {
                matches.push({ page, height: text.height, hit })
              }
            }
          }
        }
        return { pageCount, to, matches, pages, matchCount }
      })
    )

    // Each located match is a SyncTeX call, so only the first are located; the
    // count and the pages still cover every match.
    const located = await Promise.all(
      found.matches.map(async ({ page, height, hit }) => {
        const source = await sourceAt(
          build,
          page,
          hit.anchor.x,
          hit.anchor.y
        ).catch(() => null)
        return {
          page,
          y: height ? percent(hit.anchor.y / height) : null,
          text: hit.text,
          context: hit.context,
          path: source?.path ?? null,
          line: source?.line ?? null,
        }
      })
    )
    const result = {
      query: String(query),
      fromPage: from,
      toPage: found.to,
      pageCount: found.pageCount,
      matchCount: found.matchCount,
      pages: found.pages,
      matches: located,
    }
    if (found.matchCount > found.matches.length) result.truncated = true
    if (contentHash != null) result.contentHash = contentHash
    return result
  }

  /**
   * The boxes a source range is typeset in, on every page it reaches, in the
   * viewer's own terms: PDF points from the top of each page, as SyncTeX gives
   * them. Mirrors pdfBoxesForSource on the frontend: a short range is asked
   * line by line, a long one by its two ends.
   */
  async function highlight({
    projectId,
    userId,
    buildId,
    clsiServerId,
    path,
    line,
    endLine,
  }) {
    const build = buildOf({ projectId, userId, buildId, clsiServerId })
    const file = projectPath(path)
    const first = pageNumber(line, 1)
    const last = Math.max(first, pageNumber(endLine, first))
    const span = last - first + 1
    const lines =
      span <= HIGHLIGHT_MAX_LINES
        ? Array.from({ length: span }, (_, index) => first + index)
        : [first, last]
    const found = await Promise.all(
      lines.map(probe => positionsOf(build, file, probe))
    )
    const boxes = found.flat().flatMap(position => {
      const { page, h, v, width, height } = position
      const numbers = [page, h, v, width, height]
      return numbers.every(n => Number.isFinite(n))
        ? [{ page, h, v, width, height }]
        : []
    })
    if (boxes.length === 0) {
      const range = last > first ? `lines ${first}-${last}` : `line ${first}`
      throw new PdfPageError(
        PDF_PAGE_ERRORS.LINE_NOT_IN_PDF,
        `${file} ${range} ${last > first ? 'are' : 'is'} not typeset in this PDF: in the preamble, a comment, a file the build does not include, or added after this build.`,
        {
          sourceStatus: 'line_not_in_build',
          sourceNote: SOURCE_NOTES.line_not_in_build,
        }
      )
    }
    return boxes
  }

  return { inspect, overview, search, highlight }
}

/** The source line of the map entry nearest a height (percent of the page). */
function sourceNear(map, percentY) {
  if (!map || map.length === 0 || percentY == null) return null
  let best = map[0]
  for (const entry of map) {
    if (Math.abs(entry.y - percentY) < Math.abs(best.y - percentY)) best = entry
  }
  return { path: best.path, line: best.line }
}

const defaultInspector = createPdfPageInspector()

export function inspectPdfPage(options) {
  return defaultInspector.inspect(options)
}

export function overviewPdfPages(options) {
  return defaultInspector.overview(options)
}

export function searchPdfText(options) {
  return defaultInspector.search(options)
}

export function highlightSourceInPdf(options) {
  return defaultInspector.highlight(options)
}


export default {
  inspectPdfPage,
  overviewPdfPages,
  searchPdfText,
  highlightSourceInPdf,
  createPdfPageInspector,
  resolveBlock,
}
