// Reads the typographic style a LaTeX build actually produced: text area,
// margins, columns, fonts and sizes per role, line spacing, heading spacing,
// colours, table and header rules, float placement. Each value is tied to the
// preamble line or package that controls it, when one can be found, with a
// confidence tag, so a model can change the right line instead of guessing.
//
// The reading is done with pdf.js (legacy build, no fonts) in a worker thread
// (PdfWorkerPool.mjs). Sizes come out in big points (bp) and are converted to
// TeX points, so the values match \fontsize and \textwidth arguments.
//
// extractStyle, summarizePages, compareStyles, parsePreamble and parseLog are
// pure given their inputs. inspectCompiledStyle fetches a build's output.pdf
// and output.log the same way PdfPageInspector does.

import ClsiManager from '../Compile/ClsiManager.mjs'
import Errors from '../Errors/Errors.js'
import {
  MAX_OUTPUT_LOG_BYTES,
  MAX_OUTPUT_PDF_BYTES,
  readBounded,
} from './BoundedStream.mjs'
import { defaultPdfWorkerPool, PdfWorkerError } from './PdfWorkerPool.mjs'
import {
  PAPER_NAMES,
  PROPERTY_SETTINGS,
  classDefaults,
} from './LatexStyleDefaults.mjs'

// Least and greatest of `pick` over a list. Loops, not spreads: a spread of a
// long list runs out of stack.
const minOf = (items, pick) =>
  items.reduce((best, item) => Math.min(best, pick(item)), Infinity)
const maxOf = (items, pick) =>
  items.reduce((best, item) => Math.max(best, pick(item)), -Infinity)


const BP_TO_PT = 72.27 / 72
const CAPTION_RE = /^(figure|fig\.|table|algorithm|listing)\s*[\dA-Z]+[.:]?\s/i
const PAGE_NUMBER_RE = /^(page\s+)?-?\s*\d{1,4}\s*-?(\s*(of|\/)\s*\d{1,4})?$/i
const MATH_FONT_RE = /^(CMMI|CMSY|CMEX|MSAM|MSBM|CMM|Math|STIX|Cambria Math|Symbol)/i
const MONO_RE = /(CMTT|Courier|Mono|Consol|Inconsolata|Menlo|Typewriter)/i
const TITLE_MAX_WORDS = 12

export const PDF_STYLE_ERRORS = {
  NO_PDF: 'no_pdf',
  NOT_A_PDF: 'not_a_pdf',
  TOO_LARGE: 'too_large',
  UNREADABLE: 'unreadable',
  BUSY: 'busy',
}

export { MAX_STYLE_PAGES, samplePageNumbers, walkOps } from './PdfPageReader.mjs'

export class PdfStyleError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'PdfStyleError'
    this.code = code
  }
}


function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null
  const f = 10 ** digits
  return Math.round(value * f) / f
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** The key with the largest total weight in [key, weight] pairs. */
function mode(pairs) {
  const sums = new Map()
  for (const [key, weight] of pairs) sums.set(key, (sums.get(key) ?? 0) + weight)
  let best = null
  let bestWeight = -1
  for (const [key, weight] of sums) {
    if (weight > bestWeight) {
      best = key
      bestWeight = weight
    }
  }
  return best
}

// ---------------------------------------------------------------- fonts

// Computer Modern file codes after "CM": CMR10, CMBX12, CMTI10, CMMI10...
const CM_CODES = {
  R: { family: 'CM' },
  BX: { family: 'CM', bold: true },
  TI: { family: 'CM', italic: true },
  BXTI: { family: 'CM', bold: true, italic: true },
  SL: { family: 'CM', italic: true },
  BXSL: { family: 'CM', bold: true, italic: true },
  CSC: { family: 'CM', smallcaps: true },
  SS: { family: 'CM-Sans' },
  SSBX: { family: 'CM-Sans', bold: true },
  SSI: { family: 'CM-Sans', italic: true },
  TT: { family: 'CM-Mono', mono: true },
  MI: { family: 'CM', math: true },
  SY: { family: 'CM', math: true },
  EX: { family: 'CM', math: true },
}

/**
 * Family, weight, style and role of a font from its PDF base name. Subset
 * prefixes (ABCDEF+) are dropped. Handles pdfTeX names (CMBX12,
 * NimbusRomNo9L-Regu), XeTeX and LuaTeX names (LMRoman10-Bold) and common
 * outline fonts.
 */
export function classifyFont(raw) {
  const name = String(raw ?? '').replace(/^[A-Z]{6}\+/, '')
  const base = { name, family: 'other', bold: false, italic: false, mono: false, math: false, smallcaps: false }
  const cm = name.match(/^CM([A-Z]*)\d*/)
  if (cm && CM_CODES[cm[1]]) return { ...base, family: 'CM', ...CM_CODES[cm[1]] }
  const lower = name.toLowerCase()
  const bold = /bold|black|heavy|demi|-bd|bx\b/i.test(name)
  const italic = /italic|oblique|-it\b|\bit\b|slanted/i.test(name)
  const math = MATH_FONT_RE.test(name) || /math/i.test(name)
  const mono = MONO_RE.test(name)
  let family = 'other'
  if (/^LM/.test(name)) family = 'LM'
  else if (/times|nimbusrom|tiro|liberation ?serif|timesnewroman/i.test(lower)) family = 'Times'
  else if (/helvet|arial|nimbussans|calibri|verdana|liberationsans/i.test(lower)) family = 'Helvetica'
  else if (/palatino|palladio|pagella|mathpazo/i.test(lower)) family = 'Palatino'
  else if (/garamond/i.test(lower)) family = 'Garamond'
  else if (/charter/i.test(lower)) family = 'Charter'
  else if (/libertin/i.test(lower)) family = 'Libertine'
  else if (/cambria/i.test(lower)) family = 'Cambria'
  else if (/georgia/i.test(lower)) family = 'Georgia'
  else if (/minion/i.test(lower)) family = 'Minion'
  else if (mono) family = 'Mono'
  return { ...base, family, bold, italic, mono, math }
}

// ---------------------------------------------------------- pure helpers

/** A LaTeX length as TeX points, or null when it needs a font (em, ex). */
export function parseLength(raw) {
  const m = String(raw ?? '').trim().match(/^(-?[\d.]+)\s*(pt|bp|in|cm|mm|pc|dd)?/)
  if (!m) return null
  const value = Number.parseFloat(m[1])
  if (!Number.isFinite(value)) return null
  switch (m[2]) {
    case 'bp': return value * BP_TO_PT
    case 'in': return value * 72.27
    case 'cm': return value * 72.27 / 2.54
    case 'mm': return value * 72.27 / 25.4
    case 'pc': return value * 12
    case 'dd': return value * 1238 / 1157
    case undefined:
      return /\s*(em|ex)\b/.test(raw) ? null : value
    default: return value
  }
}

function stripComment(line) {
  return line.replace(/(^|[^\\])%.*$/, '$1')
}

function parseGeometryOptions(opts) {
  const kv = {}
  const flags = []
  for (const opt of opts) {
    const eq = opt.indexOf('=')
    if (eq === -1) flags.push(opt)
    else kv[opt.slice(0, eq).trim()] = opt.slice(eq + 1).trim()
  }
  return { kv, flags }
}

/**
 * The parts of a preamble that set the style, each with its line number. The
 * text is the root document's preamble, \documentclass up to
 * \begin{document}. Without it the links fall back to packages in the log.
 */
export function parsePreamble(text) {
  const out = {
    documentClass: null,
    packages: {},
    geometry: null,
    setlength: {},
    linespread: null,
    stretch: null,
    spacingEnv: null,
    rules: {},
    headings: [],
    fancy: [],
    colors: [],
    floats: [],
    fontPackage: null,
    parskipPackage: null,
  }
  if (!text) return out
  String(text).split(/\r?\n/).forEach((raw, index) => {
    const line = stripComment(raw)
    const at = index + 1
    const dc = line.match(/\\documentclass\s*(?:\[([^\]]*)\])?\s*\{([^}]+)\}/)
    if (dc && !out.documentClass) {
      const opts = (dc[1] || '').split(',').map(s => s.trim()).filter(Boolean)
      const size = opts.map(o => o.match(/^(\d+)pt$/)).find(Boolean)
      out.documentClass = { name: dc[2].trim(), options: opts, sizePt: size ? Number(size[1]) : null, line: at }
    }
    for (const pk of line.matchAll(/\\usepackage\s*(?:\[([^\]]*)\])?\s*\{([^}]+)\}/g)) {
      const opts = (pk[1] || '').split(',').map(s => s.trim()).filter(Boolean)
      for (const name of pk[2].split(',').map(s => s.trim()).filter(Boolean)) {
        out.packages[name] = { options: opts, line: at }
        if (name === 'geometry') out.geometry = { options: parseGeometryOptions(opts), line: at }
        if (/^(times|mathptmx|newtxtext|helvet|palatino|mathpazo|charter|libertine|garamond|ebgaramond|lmodern|fontspec|fourier|kpfonts)$/.test(name)) {
          out.fontPackage ??= { name, line: at }
        }
        if (name === 'parskip') out.parskipPackage = { line: at }
      }
    }
    for (const sl of line.matchAll(/\\setlength\s*\{?\s*\\(\w+)\s*\}?\s*\{([^}]*)\}/g)) {
      out.setlength[sl[1]] = { raw: sl[2].trim(), pt: parseLength(sl[2]), line: at }
    }
    const ls = line.match(/\\linespread\s*\{([\d.]+)\}/)
    if (ls) out.linespread = { value: Number(ls[1]), line: at }
    const st = line.match(/\\setstretch\s*\{([\d.]+)\}/)
    const bs = line.match(/\\renewcommand\s*\{?\\baselinestretch\}?\s*\{([\d.]+)\}/)
    if (st) out.stretch = { value: Number(st[1]), line: at, cmd: '\\setstretch' }
    else if (bs) out.stretch = { value: Number(bs[1]), line: at, cmd: '\\baselinestretch' }
    if (/\\onehalfspacing\b/.test(line)) out.stretch = { value: 1.5, line: at, cmd: '\\onehalfspacing' }
    if (/\\doublespacing\b/.test(line)) out.stretch = { value: 2, line: at, cmd: '\\doublespacing' }
    if (/\\singlespacing\b/.test(line)) out.stretch = { value: 1, line: at, cmd: '\\singlespacing' }
    const sp = line.match(/\\begin\s*\{spacing\}\s*\{([\d.]+)\}/)
    if (sp) out.spacingEnv = { value: Number(sp[1]), line: at }
    for (const rr of line.matchAll(/\\(?:renewcommand|setlength)\s*\{?\\(headrulewidth|footrulewidth|arrayrulewidth|heavyrulewidth|lightrulewidth)\}?\s*\{([^}]*)\}/g)) {
      out.rules[rr[1]] = { raw: rr[2].trim(), pt: parseLength(rr[2]), line: at }
    }
    if (/\\(titleformat|titlespacing)\b|\\renewcommand\s*\\?(section|subsection|paragraph)\b|\\@startsection/.test(line)) {
      out.headings.push({ line: at, raw: line.trim() })
    }
    if (/\\(pagestyle|fancyhf|fancyhead|fancyfoot|lhead|chead|rhead|lfoot|cfoot|rfoot|thispagestyle)\b/.test(line)) {
      out.fancy.push({ line: at, raw: line.trim() })
    }
    if (/\\definecolor\s*\{/.test(line) || /\\color\s*(\[[^\]]*\])?\s*\{/.test(line) || /\\(textcolor|colorlet|arrayrulecolor)\b/.test(line)) {
      out.colors.push({ line: at, raw: line.trim() })
    }
    if (/\\(floatplacement|restylefloat|topfraction|bottomfraction|textfraction)\b/.test(line)) out.floats.push({ line: at, raw: line.trim() })
  })
  return out
}

/** The class, its date, and the packages the log shows as loaded. */
export function parseLog(logText) {
  const text = String(logText ?? '')
  const dc = text.match(/^Document Class: (\S+) (\S+)/m)
  const packages = new Set()
  for (const m of text.matchAll(/^Package: ([\w-]+) /gm)) packages.add(m[1])
  // The directory part stops at a space or a bracket, so each "(" scans only
  // its own token; the lazy form backtracked quadratically on a long one.
  for (const m of text.matchAll(/\((?:[^\s()]*\/)?([\w-]+)\.sty\b/g)) packages.add(m[1])
  return {
    documentClass: dc ? { name: dc[1], date: dc[2] } : null,
    packages: [...packages].sort(),
  }
}

// ------------------------------------------------------- pdf.js reading

// pdf.js parses the PDF in a worker thread (see PdfWorkerPool.mjs): the PDF is
// user-compiled, untrusted input, and a malformed or runaway one must not stall
// or crash the web process.
async function readPdf(buffer) {
  if (!buffer || buffer.length === 0) {
    throw new PdfStyleError(PDF_STYLE_ERRORS.NO_PDF, 'This build has no PDF.')
  }
  // The pool takes ownership of what it transfers, so the caller keeps its bytes.
  const bytes = copyBytes(buffer)
  try {
    return await defaultPdfWorkerPool.run({ bytes }, [bytes])
  } catch (err) {
    if (err instanceof PdfWorkerError) {
      if (err.code === 'not_a_pdf') {
        throw new PdfStyleError(PDF_STYLE_ERRORS.NOT_A_PDF, 'The file is not a readable PDF.')
      }
      if (err.code === 'busy') {
        throw new PdfStyleError(PDF_STYLE_ERRORS.BUSY, err.message)
      }
      throw new PdfStyleError(PDF_STYLE_ERRORS.UNREADABLE, err.message)
    }
    throw err
  }
}

/** A copy of the bytes in a buffer of exactly their length, as a transferable ArrayBuffer. */
function copyBytes(buffer) {
  const view = new Uint8Array(buffer)
  const copy = new Uint8Array(view.byteLength)
  copy.set(view)
  return copy.buffer
}

// ----------------------------------------------------------- analysis

/**
 * Text lines of a page: items on one baseline, split where the gap is wider
 * than a word space (columns, tab stops). Positions in big points.
 */
export function buildLines(items) {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x)
  const rows = []
  for (const item of sorted) {
    const row = rows[rows.length - 1]
    if (row && Math.abs(item.y - row.y) <= 0.35 * item.size) row.items.push(item)
    else rows.push({ y: item.y, items: [item] })
  }
  const lines = []
  for (const row of rows) {
    const cells = row.items.sort((a, b) => a.x - b.x)
    let current = null
    for (const cell of cells) {
      if (!current || cell.x - current.x1 > 0.7 * Math.max(current.size, cell.size)) {
        if (current) lines.push(current)
        current = { items: [], x0: cell.x, x1: cell.x }
      }
      current.items.push(cell)
      current.x1 = Math.max(current.x1, cell.x + cell.w)
    }
    if (current) lines.push(current)
  }
  return lines.map(finishLine).filter(line => line.text.length > 0)
}

function finishLine(line) {
  let text = ''
  let prevEnd = null
  const chars = new Map()
  let y = line.items[0].y
  let bestSize = -1
  for (const item of line.items) {
    if (prevEnd !== null && item.x - prevEnd > 0.15 * item.size) text += ' '
    text += item.s
    prevEnd = item.x + (item.w || 0)
    const key = `${round(item.size * BP_TO_PT, 2)}|${item.font}`
    chars.set(key, (chars.get(key) ?? 0) + item.s.length)
    if (item.size > bestSize) {
      bestSize = item.size
      y = item.y
    }
  }
  const [top] = [...chars.entries()].sort((a, b) => b[1] - a[1])
  const [sizeKey, fontRaw] = top ? top[0].split('|') : ['0', '']
  const font = classifyFont(fontRaw)
  const total = [...chars.values()].reduce((a, b) => a + b, 0)
  const mathChars = [...chars.entries()].reduce((n, [key, c]) => n + (classifyFont(key.split('|')[1]).math ? c : 0), 0)
  return {
    x0: line.x0,
    x1: line.x1,
    y,
    text: text.replace(/\s+/g, ' ').trim(),
    sizePt: Number(sizeKey),
    font,
    chars: total,
    mathShare: total ? mathChars / total : 0,
  }
}

/** Removes lines that sit alone beyond a big gap at the top or bottom of a page. */
function trimIsolated(lines, gapBp) {
  const out = [...lines].sort((a, b) => b.y - a.y)
  while (out.length > 2 && out[0].y - out[1].y > gapBp) out.shift()
  while (out.length > 2 && out[out.length - 2].y - out[out.length - 1].y > gapBp) out.pop()
  return out
}

/**
 * Two text columns, from where lines start. pdf.js joins a line that crosses
 * the gutter into one item, so the gap is not there to find; the second
 * column shows as a second cluster of line starts, a third of the way across
 * or further. Null for one column.
 */
export function findColumns(lines) {
  if (lines.length < 12) return null
  const bins = (values, step = 2) => {
    const counts = new Map()
    for (const v of values) {
      const key = Math.round(v / step) * step
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
  }
  const top = (counts, filter = () => true) => [...counts].filter(([k]) => filter(k)).sort((a, b) => b[1] - a[1])[0]
  const minX = minOf(lines, l => l.x0)
  const maxX = maxOf(lines, l => l.x1)
  const width = maxX - minX
  const leftStart = top(bins(lines.map(l => l.x0)))
  if (!leftStart) return null
  const right = top(bins(lines.map(l => l.x0)), k => k - leftStart[0] >= 0.3 * width)
  if (!right || right[1] < Math.max(4, 0.15 * lines.length)) return null
  const rightStart = right[0]
  const leftLines = lines.filter(l => Math.abs(l.x0 - leftStart[0]) <= 2 && l.x1 < rightStart - 3)
  const rightLines = lines.filter(l => Math.abs(l.x0 - rightStart) <= 2)
  const colRight = top(bins(leftLines.map(l => l.x1), 1))
  const rightEdge = top(bins(rightLines.map(l => l.x1), 1))
  if (!colRight || !rightEdge || leftLines.length < 4 || rightLines.length < 4) return null
  return {
    leftStart: leftStart[0],
    colRight: colRight[0],
    rightStart,
    rightEdge: rightEdge[0],
  }
}

function summariseRules(rules) {
  if (!rules.length) return null
  const byThick = new Map()
  for (const r of rules) {
    const pt = round(r.thickBp * BP_TO_PT, 2)
    byThick.set(pt, (byThick.get(pt) ?? 0) + 1)
  }
  const [[thicknessPt]] = [...byThick.entries()].sort((a, b) => b[1] - a[1])
  return { thicknessPt, count: rules.length, distinct: byThick.size }
}

// A line with another line on its baseline is a table row or a column of
// several cells, not a heading.
function sharesBaseline(lines, line) {
  return lines.some(other => other !== line && Math.abs(other.y - line.y) < 0.5)
}

/**
 * The style of a document from its pages. `pages` are readings from readPage,
 * or synthesised ones with the same fields. Returns the summary that
 * buildOutput links to the preamble.
 */
export function summarizePages(pages, { documentClass, preambleText, logText } = {}) {
  const log = parseLog(logText)
  const pre = parsePreamble(preambleText)
  const className = (pre.documentClass?.name || documentClass || log.documentClass?.name || '').toLowerCase() || null
  const allLines = pages.map(p => buildLines(p.items))

  // Body size: the size that carries most characters on lines of some length.
  const sizeWeights = []
  for (const lines of allLines) {
    for (const line of lines) if (line.text.length >= 20) sizeWeights.push([round(line.sizePt, 1), line.chars])
  }
  const bodyPt = Number(mode(sizeWeights)) || 10
  const isBody = line => Math.abs(line.sizePt - bodyPt) < 0.3 && !line.font.bold && line.mathShare < 0.5 && !line.font.mono
  const bodyGapBp = 2.2 * bodyPt / BP_TO_PT
  const blGuessBp = 1.6 * bodyPt / BP_TO_PT

  // Body text per page, without running heads and page numbers.
  const perPage = allLines.map((lines, index) => ({
    lines,
    body: trimIsolated(lines.filter(isBody), bodyGapBp),
    width: pages[index].width,
    height: pages[index].height,
  }))
  const withBody = perPage.filter(p => p.body.length >= 3)
  const pageMin = minOf(withBody, p => minOf(p.body, l => l.x0))
  const pageMax = maxOf(withBody, p => maxOf(p.body, l => l.x1))
  const allBody = withBody.flatMap(p => p.body)
  const columns = withBody.length ? findColumns(allBody) : null
  const cols = columns ? 2 : 1

  const paperWBp = median(perPage.map(p => p.width))
  const paperHBp = median(perPage.map(p => p.height))
  const paperWPt = paperWBp * BP_TO_PT
  const paperHPt = paperHBp * BP_TO_PT
  const paper = PAPER_NAMES.find(([, w, h]) => Math.abs(w - paperWBp) < 1.5 && Math.abs(h - paperHBp) < 1.5)
  const paperName = paper ? paper[0] : 'custom'

  // Running heads: a text that repeats on most pages, numbers blanked.
  const headerKeys = new Set()
  {
    const seen = new Map()
    for (const p of perPage) {
      const bodyTopY = p.body.length ? maxOf(p.body, b => b.y) : Infinity
      const keys = new Set(p.lines.filter(l => l.y > bodyTopY).map(l => l.text.replace(/\d+/g, '#')))
      for (const key of keys) seen.set(key, (seen.get(key) ?? 0) + 1)
    }
    for (const [key, n] of seen) if (n >= Math.max(3, pages.length / 2)) headerKeys.add(key)
  }

  // Area in TeX points from the paper's top-left corner. Top and bottom are the
  // highest and lowest text baselines over the pages, headings included, with
  // running heads, footnotes and page numbers left out.
  const textLines = perPage.flatMap(p => p.lines.filter(l => l.sizePt >= bodyPt - 0.4 && !PAGE_NUMBER_RE.test(l.text) && !headerKeys.has(l.text.replace(/\d+/g, '#'))))
  const topBaseline = maxOf(textLines, l => l.y)
  const botBaseline = minOf(textLines, l => l.y)
  const leftPt = median(withBody.map(p => minOf(p.body, l => l.x0))) * BP_TO_PT
  const rightPt = paperWPt - median(withBody.map(p => maxOf(p.body, l => l.x1))) * BP_TO_PT
  const topPt = paperHPt - (topBaseline * BP_TO_PT + 0.75 * bodyPt)
  const bottomPt = botBaseline * BP_TO_PT - 0.25 * bodyPt
  const heightPt = maxOf(withBody, p => maxOf(p.body, l => l.y) - minOf(p.body, l => l.y)) * BP_TO_PT + bodyPt
  const widthPt = (pageMax - pageMin) * BP_TO_PT
  const gutterPt = columns ? (columns.rightStart - columns.colRight) * BP_TO_PT : null

  // Baseline distance: the gap between two body lines that are neighbours in
  // the page's line order, so a heading or figure between them breaks the pair.
  const gaps = []
  for (const p of withBody) {
    const sorted = [...p.lines].sort((a, b) => b.y - a.y)
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1]
      const b = sorted[i]
      if (!isBody(a) || !isBody(b)) continue
      const gapBp = a.y - b.y
      if (gapBp > 0.5 && gapBp < blGuessBp * 2) gaps.push(gapBp * BP_TO_PT)
    }
  }
  const baselinePt = round(median(gaps), 2)
  // Paragraph skip: the extra gap where a paragraph starts, 0 when none.
  const skips = gaps.filter(g => g > baselinePt + 0.5 && g < 1.9 * baselinePt).map(g => g - baselinePt)
  const parSkipPt = round(skips.length >= 5 ? median(skips) : 0, 2)

  // Class defaults for the class and the size measured (or declared).
  const sizeOpt = pre.documentClass?.sizePt ?? (bodyPt >= 11.5 ? 12 : bodyPt >= 10.5 ? 11 : 10)
  const defaults = classDefaults(className, sizeOpt)

  // Roles: captions, footnotes, maths, monospace, headings, header and page number.
  const captionLines = []
  const footnoteLines = []
  const mathLines = []
  const monoLines = []
  const headerTexts = []
  const headingLines = []
  let pageNumberAlign = null
  let hasPageNumber = false
  for (let pi = 0; pi < perPage.length; pi++) {
    const p = perPage[pi]
    const bodyTop = p.body.length ? maxOf(p.body, l => l.y) : null
    const bodyBottom = p.body.length ? minOf(p.body, l => l.y) : null
    for (const line of p.lines) {
      const belowBody = bodyBottom !== null && line.y < bodyBottom - 1
      const aboveBody = bodyTop !== null && line.y > bodyTop + 1
      const headingish = line.sizePt > bodyPt + 0.4 || line.font.bold
      if (CAPTION_RE.test(line.text)) {
        captionLines.push({ line, top: bodyTop, bottom: bodyBottom })
      } else if (line.font.math || line.mathShare >= 0.5) {
        mathLines.push(line)
      } else if (line.font.mono) {
        monoLines.push(line)
      } else if (belowBody && line.sizePt < bodyPt - 0.4) {
        footnoteLines.push(line)
      } else if (belowBody && PAGE_NUMBER_RE.test(line.text)) {
        hasPageNumber = true
        const mid = (pageMin + pageMax) / 2
        const centre = (line.x0 + line.x1) / 2
        pageNumberAlign ??= Math.abs(centre - mid) < 0.1 * (pageMax - pageMin) ? 'center' : centre < mid ? 'left' : 'right'
      } else if (aboveBody && !headingish && line.text.length < 80) {
        headerTexts.push({ text: line.text, page: pi })
      } else if (!isBody(line) && headingish && line.text.split(' ').length <= TITLE_MAX_WORDS && !/[.;:,]$/.test(line.text) && !sharesBaseline(p.lines, line)) {
        headingLines.push({ line, page: pi })
      }
    }
  }

  // A running head is the text repeated on most pages, with numbers blanked.
  const headerCount = new Map()
  for (const { text, page } of headerTexts) {
    const key = text.replace(/\d+/g, '#')
    headerCount.set(key, new Set([...(headerCount.get(key) ?? []), page]))
  }
  const [repeated] = [...headerCount.entries()].sort((a, b) => b[1].size - a[1].size)
  const headerPages = repeated ? repeated[1].size : 0
  const enough = headerPages >= Math.max(2, pages.length / 2)
  const staticHeader = enough
    ? headerTexts.find(t => t.text.replace(/\d+/g, '#') === repeated[0]).text.slice(0, 40)
    : null

  // Heading levels: distinct (size, bold) pairs, largest first. A pair that
  // occurs only on the first page, a few times, is the title.
  const keyOf = line => `${round(line.sizePt, 1)}|${line.font.bold ? 'b' : ''}`
  const byKey = new Map()
  for (const h of headingLines) byKey.set(keyOf(h.line), [...(byKey.get(keyOf(h.line)) ?? []), h])
  // A title is much larger than the body, once, on the first page. Report and
  // book chapters look the same, so those classes have no title found here.
  const chapterClass = /^(report|book)$/.test(className ?? '')
  const titleKeys = new Set(pages.length > 1 && !chapterClass
    ? [...byKey].filter(([k, hs]) => hs.length <= 2 && hs.every(h => h.page === 0) && Number(k.split('|')[0]) >= 1.5 * bodyPt).map(([k]) => k)
    : [])
  // Plain (not bold) larger lines are headings only when they recur on more
  // than one page; on the first page they are the author and date lines.
  const recurs = k => k.endsWith('|b') || new Set(byKey.get(k).map(h => h.page)).size >= 2
  const levelKeys = [...byKey.keys()]
    .filter(k => !titleKeys.has(k) && recurs(k))
    .sort((a, b) => {
      const [sa, ba] = a.split('|')
      const [sb, bb] = b.split('|')
      return Number(sb) - Number(sa) || (bb ? 1 : 0) - (ba ? 1 : 0)
    })
  const headings = levelKeys.slice(0, 4).map((key, i) => {
    const hs = byKey.get(key)
    const rep = hs[0].line
    const befores = []
    const afters = []
    for (const { line, page } of hs) {
      const col = [...perPage[page].lines].sort((a, b) => b.y - a.y)
      const idx = col.indexOf(line)
      if (idx > 0) befores.push((col[idx - 1].y - line.y) * BP_TO_PT - baselinePt)
      if (idx >= 0 && idx < col.length - 1) afters.push((line.y - col[idx + 1].y) * BP_TO_PT - baselinePt)
    }
    return {
      level: i + 1,
      sizePt: round(rep.sizePt, 2),
      bold: rep.font.bold,
      italic: rep.font.italic,
      font: rep.font.name,
      count: hs.length,
      beforePt: round(median(befores.filter(v => v > -2)), 1),
      afterPt: round(median(afters.filter(v => v > -2)), 1),
    }
  })
  const titleHs = headingLines.filter(h => titleKeys.has(keyOf(h.line)))
  const title = titleHs.length ? { sizePt: round(titleHs[0].line.sizePt, 2), bold: titleHs[0].line.font.bold } : null

  const fontRole = list => {
    if (!list.length) return null
    const size = mode(list.map(l => [round(l.sizePt, 2), l.chars]))
    const face = mode(list.map(l => [l.font.name, l.chars]))
    const font = list.find(l => l.font.name === face)?.font ?? classifyFont(face)
    return { name: font.name, family: font.family, sizePt: Number(size), bold: font.bold, italic: font.italic, count: list.length }
  }

  // Rules: a horizontal rule above the body is the header rule; between body
  // lines it is a table rule.
  const rules = perPage.flatMap((p, pi) => (pages[pi].rules ?? []).map(r => ({ ...r, page: pi })))
  const bodyTopBp = topBaseline
  const bodyBottomBp = botBaseline
  const hRules = rules.filter(r => r.dir === 'h')
  // A header rule sits above the body on most pages, at the same height.
  const aboveBody = hRules.filter(r => r.at > bodyTopBp + 1 && r.at < bodyTopBp + 0.2 * paperHBp)
  const pagesAt = new Map()
  for (const r of aboveBody) {
    const key = Math.round(r.at)
    pagesAt.set(key, new Set([...(pagesAt.get(key) ?? []), r.page]))
  }
  const repeatedAt = new Set([...pagesAt].filter(([, set]) => set.size >= Math.max(2, pages.length / 2)).map(([key]) => key))
  const headRules = aboveBody.filter(r => repeatedAt.has(Math.round(r.at)))
  // A rule between one page's first and last body lines is a table rule.
  const pageRange = perPage.map(p => (p.body.length
    ? { top: maxOf(p.body, l => l.y), bottom: minOf(p.body, l => l.y) }
    : null))
  // A table's top and bottom rules sit just outside its first and last rows.
  // A footnote rule is short and sits under the body; a table rule is as wide
  // as its table.
  const bodyRules = hRules.filter(r => {
    const range = pageRange[r.page]
    if (!range || r.at > range.top + 1.5 * bodyPt / BP_TO_PT || r.at < range.bottom - 1.5 * bodyPt / BP_TO_PT) return false
    return !(r.at < range.bottom && Math.abs(r.to - r.from) < 0.5 * (pageMax - pageMin))
  }).concat(aboveBody.filter(r => !repeatedAt.has(Math.round(r.at))))
  const verticalCount = rules.filter(r => r.dir === 'v' && r.at >= pageMin - 1 && r.at <= pageMax + 1).length

  // Colours: text by glyph count, rules by count.
  const textTotals = {}
  for (const p of pages) for (const [hex, n] of Object.entries(p.textColours ?? {})) textTotals[hex] = (textTotals[hex] ?? 0) + n
  const ruleTotals = {}
  for (const r of rules) ruleTotals[r.colour] = (ruleTotals[r.colour] ?? 0) + 1
  const colourShares = (totals, max) => {
    const all = Object.values(totals).reduce((a, b) => a + b, 0)
    return Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, max).map(([hex, n]) => [hex, all ? round(n / all, 2) : 0])
  }

  // Widow and orphan lines: a paragraph that starts or ends a page alone.
  let widows = 0
  let orphans = 0
  const parIndent = pre.setlength.parindent?.pt ?? defaults?.parindentPt ?? null
  for (const p of withBody) {
    const sorted = [...p.body].sort((a, b) => b.y - a.y)
    if (sorted.length < 3 || parIndent === null) continue
    const left = minOf(p.body, l => l.x0)
    const indented = line => line.x0 - left > 0.5 * parIndent / BP_TO_PT
    if (!indented(sorted[0]) && /^[a-z]/.test(sorted[0].text) && indented(sorted[1])) widows++
    if (indented(sorted[sorted.length - 1])) orphans++
  }

  // Floats: where captions sit in the body (top third, bottom third, between).
  const floats = { top: 0, bottom: 0, here: 0 }
  for (const { line, top, bottom } of captionLines) {
    if (top === null || bottom === null || top <= bottom) continue
    const f = (line.y - bottom) / (top - bottom)
    if (f > 0.7) floats.top++
    else if (f < 0.3) floats.bottom++
    else floats.here++
  }

  const values = {
    pages: pages.length,
    paper: { name: paperName, wPt: round(paperWPt, 1), hPt: round(paperHPt, 1) },
    className,
    sizeOpt,
    date: log.documentClass?.date ?? null,
    options: pre.documentClass?.options ?? [],
    packages: log.packages,
    area: {
      widthPt: round(widthPt, 1),
      heightPt: round(heightPt, 1),
      leftPt: round(leftPt, 1),
      rightPt: round(rightPt, 1),
      topPt: round(topPt, 1),
      bottomPt: round(bottomPt, 1),
      cols,
      gutterPt: round(gutterPt, 1),
    },
    body: {
      sizePt: round(bodyPt, 2),
      baselinePt,
      parSkipPt,
      stretch: baselinePt && defaults ? round(baselinePt / defaults.baselinePt, 3) : null,
      font: fontRole(allBody),
    },
    parIndentPt: round(parIndent, 2),
    headings,
    title,
    roles: {
      caption: fontRole(captionLines.map(c => c.line)),
      footnote: fontRole(footnoteLines),
      math: fontRole(mathLines),
      mono: fontRole(monoLines),
    },
    table: summariseRules(bodyRules),
    verticalRules: verticalCount,
    header: { rule: summariseRules(headRules), text: staticHeader, dynamic: !staticHeader && enough, pageNumber: hasPageNumber ? pageNumberAlign : null },
    colours: { text: colourShares(textTotals, 4), rules: colourShares(ruleTotals, 3) },
    widowOrphan: { widows, orphans, pages: withBody.length },
    floats,
    defaults,
  }
  return { values, pre, log }
}

const TOLERANCE = {
  edge: 1,
  verticalEdge: 2.5,
  baseline: 0.2,
  size: 0.05,
  rule: 0.05,
  spacing: 1,
  indent: 0.5,
}

/** Tags a value with the line, package or default that sets it, if any. */
function link(by, c) {
  return by ? { by, c } : null
}

/**
 * Ties each measured value to the preamble line or package that sets it, or to
 * the class default it matches, with a confidence tag. High means the preamble
 * line is there and its value matches the measurement.
 */
export function linkValues(summary) {
  const { values, pre, log } = summary
  const defaults = values.defaults
  const geo = pre.geometry?.options.kv ?? {}
  const geoLine = pre.geometry?.line
  const fromGeometry = (keys, measured, tolerance = TOLERANCE.edge) => {
    const key = keys.find(k => geo[k] !== undefined) ?? (geo.margin !== undefined ? 'margin' : null)
    if (key) {
      const pt = parseLength(geo[key])
      const ok = pt !== null && Math.abs(pt - measured) <= tolerance
      return link(`geometry L${geoLine}`, ok ? 'high' : 'medium')
    }
    if (geoLine) return link(`geometry L${geoLine} (default)`, 'medium')
    return null
  }
  const pick = (...candidates) => candidates.find(Boolean) ?? null
  // Width given as what is left between the left and right margins.
  const fromMargins = measured => {
    const left = geo.left !== undefined ? parseLength(geo.left) : null
    const right = geo.right !== undefined ? parseLength(geo.right) : null
    if (left === null || right === null || !geoLine) return null
    const expected = measured.paper.wPt - left - right
    const close = Math.abs(expected - measured.area.widthPt) <= 1.5
    return link(`geometry L${geoLine} (left+right)`, close ? 'high' : 'medium')
  }
  // A class default is the link when the measurement is close to it; a
  // measurement far from the default matches no known setting.
  const byDefault = (measured, expected, tolerance) => {
    if (!defaults) return null
    if (expected === undefined || expected === null || measured === null) return link('class default', 'low')
    return link('class default', Math.abs(measured - expected) <= tolerance ? 'medium' : 'low')
  }
  const topDefault = defaults && 72.27 + defaults.topmarginPt + defaults.headheightPt + defaults.headsepPt
  const setlength = name => (pre.setlength[name] ? link(`setlength L${pre.setlength[name].line}`, 'high') : null)
  const baselineLink = pick(
    pre.linespread && link(`linespread L${pre.linespread.line}`, 'high'),
    pre.stretch && link(`${pre.stretch.cmd} L${pre.stretch.line}`, 'high'),
    pre.spacingEnv && link(`spacing L${pre.spacingEnv.line}`, 'high'),
    setlength('baselineskip'),
    pre.packages.setspace && link(`setspace L${pre.packages.setspace.line}`, 'medium'),
    defaults && link('class default', 'medium'),
  )
  const headRule = values.header.rule && pick(
    pre.rules.headrulewidth && link(`headrulewidth L${pre.rules.headrulewidth.line}`, 'high'),
    pre.packages.fancyhdr && link(`fancyhdr L${pre.packages.fancyhdr.line}`, 'medium'),
  )
  const tableRule = values.table && pick(
    pre.rules.arrayrulewidth && link(`arrayrulewidth L${pre.rules.arrayrulewidth.line}`, 'high'),
    pre.packages.booktabs && link(`booktabs L${pre.packages.booktabs.line}`, 'medium'),
    link('hline default 0.4pt', 'medium'),
  )
  return {
    area: {
      widthPt: pick(
        fromGeometry(['textwidth'], values.area.widthPt),
        setlength('textwidth'),
        fromMargins(values),
        byDefault(values.area.widthPt, defaults?.textwidthPt, TOLERANCE.edge),
      ),
      heightPt: pick(fromGeometry(['textheight'], values.area.heightPt, TOLERANCE.verticalEdge), setlength('textheight'), byDefault(values.area.heightPt, defaults?.textheightPt, TOLERANCE.verticalEdge)),
      leftPt: pick(fromGeometry(['left', 'hmargin'], values.area.leftPt), byDefault(values.area.leftPt, defaults && 72.27 + defaults.oddsidemarginPt, TOLERANCE.edge)),
      rightPt: pick(fromGeometry(['right', 'hmargin'], values.area.rightPt), byDefault(values.area.rightPt, null, 0)),
      topPt: pick(fromGeometry(['top', 'vmargin'], values.area.topPt, TOLERANCE.verticalEdge), byDefault(values.area.topPt, topDefault, TOLERANCE.verticalEdge)),
      bottomPt: pick(fromGeometry(['bottom', 'vmargin'], values.area.bottomPt, TOLERANCE.verticalEdge), byDefault(values.area.bottomPt, null, 0)),
    },
    baselinePt: baselineLink,
    parIndentPt: pick(setlength('parindent'), byDefault(values.parIndentPt, defaults?.parindentPt, TOLERANCE.indent)),
    parSkipPt: pick(setlength('parskip'), pre.parskipPackage && link(`parskip L${pre.parskipPackage.line}`, 'high'), byDefault(values.body.parSkipPt, 0, TOLERANCE.indent)),
    size: pick(
      pre.documentClass?.sizePt && link(`documentclass L${pre.documentClass.line}`, 'high'),
      link('measured', 'medium'),
    ),
    headRule,
    tableRule,
    headings: pre.headings.length ? link(`heading cmd L${pre.headings[0].line}`, 'medium') : (defaults ? link('class default', 'medium') : null),
    font: pre.fontPackage ? link(`${pre.fontPackage.name} L${pre.fontPackage.line}`, 'high') : null,
    colours: pre.colors.length ? link(`colour L${pre.colors[0].line}`, 'high') : null,
    floats: pre.floats.length ? link(`float L${pre.floats[0].line}`, 'high') : null,
    fancy: pre.fancy.length ? link(`fancy L${pre.fancy[0].line}`, 'high') : null,
  }
}

/**
 * The output the model reads. Each measured value carries `by` (the line or
 * package that sets it) and `c` (confidence) when a link is found, and the
 * LaTeX setting to change it is in PROPERTY_SETTINGS.
 */
export function buildOutput(summary) {
  const links = linkValues(summary)
  const { values } = summary
  const tag = (v, l) => (l ? { v, by: l.by, c: l.c } : { v, c: 'low' })
  const out = {
    v: 1,
    pages: values.pages,
    paper: values.paper.name,
    class: `${values.className ?? 'unknown'} ${values.sizeOpt}pt`,
    area: {
      w: tag(values.area.widthPt, links.area.widthPt),
      h: tag(values.area.heightPt, links.area.heightPt),
      left: tag(values.area.leftPt, links.area.leftPt),
      right: tag(values.area.rightPt, links.area.rightPt),
      top: tag(values.area.topPt, links.area.topPt),
      bottom: tag(values.area.bottomPt, links.area.bottomPt),
      cols: values.area.cols,
      gutter: values.area.gutterPt,
    },
    body: {
      size: tag(values.body.sizePt, links.size),
      font: values.body.font && { name: values.body.font.name, family: values.body.font.family },
      baseline: tag(values.body.baselinePt, links.baselinePt),
      stretch: values.body.stretch,
    },
    parIndent: tag(values.parIndentPt, links.parIndentPt),
    parSkip: tag(values.body.parSkipPt, links.parSkipPt),
    headings: values.headings.map(h => ({
      lvl: h.level,
      size: h.sizePt,
      bold: h.bold,
      font: h.font,
      before: h.beforePt,
      after: h.afterPt,
      c: links.headings?.c ?? 'low',
    })),
    title: values.title,
    roles: values.roles,
    rules: {
      table: values.table && { ...values.table, ...(links.tableRule ?? { c: 'low' }) },
      verticalRules: values.verticalRules,
      header: values.header.rule && { ...values.header.rule, ...(links.headRule ?? { c: 'low' }) },
    },
    header: { text: values.header.text, dynamic: values.header.dynamic, pageNumber: values.header.pageNumber },
    colours: { text: values.colours.text, rules: values.colours.rules, c: links.colours?.c ?? 'low' },
    widowOrphan: { ...values.widowOrphan, c: 'low' },
    floats: values.floats,
    packages: values.packages.slice(0, 40),
  }
  return prune(out)
}

function prune(obj) {
  if (Array.isArray(obj)) return obj.map(prune)
  if (obj && typeof obj === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || v === undefined) continue
      out[k] = prune(v)
    }
    return out
  }
  return obj
}

/** Values compared with the template, as paths into buildOutput's shape. */
const COMPARED = [
  ['area.w', 'area.w.v', TOLERANCE.edge],
  ['area.h', 'area.h.v', TOLERANCE.verticalEdge],
  ['area.left', 'area.left.v', TOLERANCE.edge],
  ['area.right', 'area.right.v', TOLERANCE.edge],
  ['area.top', 'area.top.v', TOLERANCE.verticalEdge],
  ['area.bottom', 'area.bottom.v', TOLERANCE.verticalEdge],
  ['area.gutter', 'area.gutter', TOLERANCE.edge],
  ['area.cols', 'area.cols', 0],
  ['body.size', 'body.size.v', TOLERANCE.size],
  ['body.baseline', 'body.baseline.v', TOLERANCE.baseline],
  ['parIndent', 'parIndent.v', TOLERANCE.indent],
  ['parSkip', 'parSkip.v', TOLERANCE.indent],
  ['rules.table', 'rules.table.thicknessPt', TOLERANCE.rule],
  ['rules.header', 'rules.header.thicknessPt', TOLERANCE.rule],
  ['headings.1.size', 'headings.0.size', TOLERANCE.size],
  ['headings.2.size', 'headings.1.size', TOLERANCE.size],
  ['headings.1.before', 'headings.0.before', TOLERANCE.spacing],
  ['headings.1.after', 'headings.0.after', TOLERANCE.spacing],
]

function pick_(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

const SETTING_FOR = {
  'area.w': 'area.width',
  'area.h': 'area.height',
  'area.left': 'area.left',
  'area.right': 'area.right',
  'area.top': 'area.top',
  'area.bottom': 'area.bottom',
  'area.gutter': 'area.columnGap',
  'area.cols': 'area.columns',
  'body.size': 'fonts.body.sizePt',
  'body.baseline': 'baselinePt',
  parIndent: 'parIndentPt',
  parSkip: 'parSkipPt',
  'rules.table': 'tableRules.thicknessPt',
  'rules.header': 'header.ruleThicknessPt',
  'headings.1.size': 'fonts.headings.section.sizePt',
  'headings.2.size': 'fonts.headings.subsection.sizePt',
  'headings.1.before': 'headings.before',
  'headings.1.after': 'headings.after',
}

/**
 * Compares two outputs of buildOutput: `a` the build, `b` the template. Lists
 * the values that differ beyond their tolerance, each with the template's value
 * and the LaTeX setting that would change the build to match it.
 */
export function compareStyles(a, b) {
  const diffs = []
  let same = 0
  for (const [prop, path, tolerance] of COMPARED) {
    const left = pick_(a, path)
    const right = pick_(b, path)
    if (typeof left !== 'number' || typeof right !== 'number') continue
    if (Math.abs(left - right) <= tolerance) {
      same++
      continue
    }
    diffs.push({ prop, now: round(left, 2), template: round(right, 2), fix: fixFor(prop, right, b) })
  }
  const familyNow = a.body?.font?.family ?? null
  const familyTpl = b.body?.font?.family ?? null
  if (familyNow !== familyTpl) diffs.push({ prop: 'body.family', now: familyNow, template: familyTpl, fix: PROPERTY_SETTINGS['fonts.body.family']?.setting ?? null })
  else same++
  const textNow = (a.colours?.text ?? []).map(([hex]) => hex).join(',')
  const textTpl = (b.colours?.text ?? []).map(([hex]) => hex).join(',')
  if (textNow !== textTpl) diffs.push({ prop: 'colors.text', now: textNow || null, template: textTpl || null, fix: PROPERTY_SETTINGS['colors.text'].setting })
  else same++
  return { same, diffs }
}

function fixFor(prop, value, template) {
  const key = SETTING_FOR[prop]
  const entry = key && PROPERTY_SETTINGS[key]
  if (!entry) return null
  let text = entry.setting.replace('<value>', `${round(value, 2)}pt`)
  if (prop === 'body.baseline') {
    const ratio = template.body?.stretch ?? round(value / 12, 2)
    text = text.replace(/<ratio>/g, String(ratio))
  }
  if (prop === 'body.size') {
    text = text.replace('<size>', String(round(value, 0)))
  }
  if (prop === 'headings.1.size' || prop === 'headings.2.size') {
    const sizeCmd = value >= 17 ? 'Large' : value >= 14 ? 'large' : 'normalsize'
    text = text.replace('<size>', sizeCmd)
  }
  if (prop === 'headings.1.before') {
    const after = template.headings?.[0]?.after ?? 10
    text = text.replace('<before>', `${round(value, 1)}pt`).replace('<after>', `${round(after, 1)}pt`)
  }
  if (prop === 'headings.1.after') {
    const before = template.headings?.[0]?.before ?? 15
    text = text.replace('<before>', `${round(before, 1)}pt`).replace('<after>', `${round(value, 1)}pt`)
  }
  return text
}

// -------------------------------------------------------- entry points

/**
 * The style of a PDF, as buildOutput gives it. `logText` gives the class and
 * the loaded packages, `preambleText` the lines that set the style, and
 * `documentClass` names the class when the log has none.
 */
export async function extractStyle(pdfBuffer, options = {}) {
  const { pages, pageCount } = await readPdf(pdfBuffer)
  const summary = summarizePages(pages, options)
  summary.values.pages = pageCount
  return buildOutput(summary)
}

/** As extractStyle, from pages already read. Pure. */
export function extractStyleFromPages(pages, options = {}) {
  return buildOutput(summarizePages(pages, options))
}

/**
 * The inspector bound to a CLSI file reader. The default reader is the one
 * PdfPageInspector uses. Tests inject their own.
 */
export function createPdfStyleInspector({
  getOutputFileStream = (...args) => ClsiManager.promises.getOutputFileStream(...args),
} = {}) {
  /** `{ buffer, truncated }` of a build file read up to maxBytes, or null when absent. */
  async function readBuildFile(build, name, maxBytes) {
    let stream
    try {
      stream = await getOutputFileStream(build.projectId, build.userId, build.clsiServerId, build.buildId, name)
    } catch (err) {
      if (err instanceof Errors.OutputFileFetchFailedError || err instanceof Errors.NotFoundError) return null
      throw err
    }
    return readBounded(stream, maxBytes)
  }

  async function styleOfBuild(build, { preambleText, documentClass }) {
    const pdf = await readBuildFile(build, 'output.pdf', MAX_OUTPUT_PDF_BYTES)
    if (!pdf || pdf.buffer.length === 0) {
      throw new PdfStyleError(PDF_STYLE_ERRORS.NO_PDF, 'This build has no PDF: the compile failed before LaTeX wrote one.')
    }
    if (pdf.truncated) {
      throw new PdfStyleError(PDF_STYLE_ERRORS.TOO_LARGE, 'The PDF of this build is too large to read.')
    }
    // A log cut short still has the class and the packages it loaded first.
    const log = await readBuildFile(build, 'output.log', MAX_OUTPUT_LOG_BYTES)
    return extractStyle(pdf.buffer, { logText: log ? log.buffer.toString('utf8') : null, preambleText, documentClass })
  }

  /**
   * The style of one build, and with `against` a diff to another. `against` is
   * { buildId, clsiServerId, preambleText } for another build, or
   * { pdf, logText, preambleText } for a PDF the caller already holds.
   */
  async function inspectCompiledStyle({ projectId, userId, buildId, clsiServerId, preambleText, documentClass, against }) {
    const build = { projectId: String(projectId), userId: String(userId), buildId, clsiServerId: clsiServerId || undefined }
    const style = await styleOfBuild(build, { preambleText, documentClass })
    if (!against) return { style }
    let other
    if (against.pdf) {
      other = await extractStyle(against.pdf, { logText: against.logText, preambleText: against.preambleText, documentClass: against.documentClass })
    } else {
      other = await styleOfBuild(
        { ...build, buildId: against.buildId, clsiServerId: against.clsiServerId || build.clsiServerId },
        { preambleText: against.preambleText, documentClass: against.documentClass }
      )
    }
    return { style, diff: compareStyles(style, other) }
  }

  return { inspectCompiledStyle }
}

const defaultInspector = createPdfStyleInspector()

export const inspectCompiledStyle = (...args) => defaultInspector.inspectCompiledStyle(...args)
