// Shows what a recompile changed, so the agent can check that its edit landed
// where it meant to, and the user can see the same regions highlighted in the
// PDF viewer. Two builds are rasterised in grayscale at a modest DPI and
// compared page by page:
// - a row the two pages share in the same place is compared pixel by pixel, so
//   a word changed inside an unmoved line is caught;
// - a row that moved (a paragraph was added above it, a figure moved) is matched
//   to its counterpart by content, so text pushed down by a reflow is reported
//   as "content below shifted" instead of being boxed as a change;
// - ink with no counterpart is a change. Anti-aliasing noise is removed by a
//   threshold, dilation and a minimum component size before boxes are merged.
//
// Previous builds: the compile server only keeps the newest build directories
// of a project. A per-user compile keeps two (clsi OutputCacheManager
// .expireOutputFiles, limit: 1 plus the build just made) and drops any build
// older than 90 minutes (CACHE_AGE). A diff against an older build therefore
// fails with 'previous_build_gone' unless the integrator calls
// rememberBuildPages when that build is compiled. That keeps deflated
// grayscale rasters in a bounded LRU.
//
// poppler-utils does the PDF work (pdfinfo, pdftoppm, pdftotext); the pixel
// logic is pure and lives in diffRasters. The inspector (PdfPageInspector.mjs)
// fetches build output the same way, so both see the same PDF.

import { execFile as execFileCallback } from 'node:child_process'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import Path from 'node:path'
import { promisify } from 'node:util'
import ClsiManager from '../Compile/ClsiManager.mjs'
import Errors from '../Errors/Errors.js'
import {
  MAX_OUTPUT_PDF_BYTES,
  OutputTooLargeError,
  pipeBounded,
} from './BoundedStream.mjs'
import { composeGrid, encodePng, parsePnm } from './PdfRaster.mjs'

export const DIFF_DPI = 100
// Gray levels a pixel must move by to count as changed. Sub-pixel shifts of
// anti-aliased text stay below this; ink against paper is far above it.
export const PIXEL_THRESHOLD = 100
// Ink for the change mask, and the level at or above which a row is blank.
const INK_LEVEL = 200
const BLANK_LEVEL = 250
// A row is compared as ROW_BUCKETS horizontal mean levels, so a row survives a
// sub-pixel shift and a changed word still changes its buckets.
const ROW_BUCKETS = 64
const ROW_TOLERANCE = 12
// A bucket mean between these levels is anti-aliased ink, and a row with
// TEXTURE_MIN_BUCKETS of them is text rather than a flat fill.
const TEXTURE_LOW = 40
const TEXTURE_HIGH = 215
const TEXTURE_MIN_BUCKETS = 3
// Row alignment is an LCS over rows; past this many cells the middle of the page
// is not aligned, so its rows read as removed and inserted (the prefix and the
// suffix are still matched in place).
const MAX_ALIGN_CELLS = 4_000_000
const DILATE_PX = 4
const MERGE_GAP_X_PX = 20
const MERGE_GAP_Y_PX = 8
const MIN_COMPONENT_PX = 12
const MAX_BOXES_BEFORE_MERGE = 200
// Ink below this fraction of the page height is body text. A running footer
// below it does not stop a reflow from reaching the bottom.
const FOOTER_FROM = 0.9
// Pages paired by text when the counts differ need this word overlap.
const MIN_PAGE_SIMILARITY = 0.3
const TILE_TARGET_PIXELS = 1_150_000
const REMEMBER_MAX_BYTES = 96 * 1024 * 1024
const REMEMBER_TEXT_CHARS = 4000
const COMMAND_TIMEOUT_MS = 60_000
const BUILD_ID = /^[0-9a-f]+-[0-9a-f]+$/
// Limits that keep a diff in bounded memory: every page compared is held as a
// grey raster for the whole call (both builds), so the pages, the pixels of a
// page and the pixels of all of them are capped. Text pairing builds a table of
// the two page counts, so it is capped too.
const MAX_PAGE_PIXELS = 16_000_000
const MAX_DIFF_PIXELS = 64_000_000
const MAX_DIFF_PAGES = 40
const MAX_PAIRING_PAGES = 400
const PAIRING_TEXT_BYTES = 64 * 1024 * 1024

export const VISUAL_DIFF_ERRORS = {
  PREVIOUS_BUILD_GONE: 'previous_build_gone',
  BUILD_GONE: 'build_gone',
  BUILD_UNAVAILABLE: 'build_unavailable',
  RENDERER_UNAVAILABLE: 'renderer_unavailable',
  RENDER_FAILED: 'render_failed',
  TOO_LARGE: 'too_large',
  TOO_MANY_PAGES: 'too_many_pages',
}

const REGION_COLORS = {
  changed: [220, 30, 30],
  moved: [230, 140, 0],
  added: [30, 90, 220],
}

class VisualDiffError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'VisualDiffError'
    this.code = code
  }
}

function round(value, places = 4) {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

function assertRaster(raster, caller) {
  const { width, height, channels, data } = raster ?? {}
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    (channels !== 1 && channels !== 3) ||
    !data ||
    data.length !== width * height * channels
  ) {
    throw new TypeError(`${caller}: expected an 8-bit raster`)
  }
}

/** Gray levels, one byte per pixel. Colour rasters are reduced to luma. */
function grayOf(raster) {
  const { width, height, channels, data } = raster
  if (channels === 1) return data
  const out = Buffer.alloc(width * height)
  for (let i = 0, p = 0; i < out.length; i++, p += 3) {
    out[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8
  }
  return out
}

/**
 * One row at a time: the mean level of each horizontal bucket, and whether the
 * row is blank (paper).
 */
function rowSignatures(gray, width, height) {
  const buckets = Math.min(ROW_BUCKETS, width)
  const sig = new Uint8Array(height * buckets)
  const blank = new Uint8Array(height)
  // Textured: some buckets are in between paper and ink, as anti-aliased text
  // is. A flat rule or fill has buckets at paper or ink only.
  const textured = new Uint8Array(height)
  for (let y = 0; y < height; y++) {
    let min = 255
    let intermediate = 0
    for (let b = 0; b < buckets; b++) {
      const x0 = Math.floor((b * width) / buckets)
      const x1 = Math.floor(((b + 1) * width) / buckets)
      let sum = 0
      for (let x = x0; x < x1; x++) {
        const v = gray[y * width + x]
        sum += v
        if (v < min) min = v
      }
      const mean = Math.round(sum / Math.max(1, x1 - x0))
      sig[y * buckets + b] = mean
      if (mean >= TEXTURE_LOW && mean <= TEXTURE_HIGH) intermediate++
    }
    blank[y] = min >= BLANK_LEVEL ? 1 : 0
    textured[y] = intermediate >= TEXTURE_MIN_BUCKETS ? 1 : 0
  }
  return { sig, blank, buckets, textured }
}

function sameRow(a, i, b, j, buckets, tolerance) {
  const limit = tolerance * buckets
  let total = 0
  const ai = i * buckets
  const bj = j * buckets
  for (let k = 0; k < buckets; k++) {
    total += Math.abs(a.sig[ai + k] - b.sig[bj + k])
    if (total > limit) return false
  }
  return true
}

/**
 * Aligns the ink rows of the two pages. Blank rows are left out: they are
 * neutral, and so many of them that an LCS would pair them up across the page
 * instead of pairing the text. The common prefix and suffix match in place and
 * the middle is an LCS over row content. An old ink row with no counterpart
 * was removed; a new ink row with none was inserted.
 *
 * @returns {{ matchOf: Int32Array, removedAt: Array<{ y: number, rows: number }> }}
 *   matchOf[j] is the old row that new row j came from, or -1.
 */
function alignRows(before, after, tolerance) {
  const n = before.blank.length
  const m = after.blank.length
  const buckets = before.buckets
  const matchOf = new Int32Array(m).fill(-1)
  const matchedBefore = new Uint8Array(n)
  const inkBefore = []
  for (let i = 0; i < n; i++) if (!before.blank[i]) inkBefore.push(i)
  const inkAfter = []
  for (let j = 0; j < m; j++) if (!after.blank[j]) inkAfter.push(j)
  const same = (p, q) =>
    sameRow(before, inkBefore[p], after, inkAfter[q], buckets, tolerance)
  const record = (p, q) => {
    matchOf[inkAfter[q]] = inkBefore[p]
    matchedBefore[inkBefore[p]] = 1
  }

  const na = inkBefore.length
  const nb = inkAfter.length
  let pre = 0
  while (pre < na && pre < nb && same(pre, pre)) {
    record(pre, pre)
    pre++
  }
  let suf = 0
  while (suf < na - pre && suf < nb - pre && same(na - 1 - suf, nb - 1 - suf)) {
    suf++
  }
  for (let k = 0; k < suf; k++) record(na - suf + k, nb - suf + k)

  // Weighted LCS. A row that stays where it was is worth most; a moved text
  // row is worth four times a moved solid row. So an unmoved paragraph beats a
  // moved rule of the same height, and text that moved up past a moved figure
  // is still text that moved.
  const midA = na - pre - suf
  const midB = nb - pre - suf
  if (midA > 0 && midB > 0 && midA * midB <= MAX_ALIGN_CELLS) {
    const w = midB + 1
    const score = new Uint16Array((midA + 1) * w)
    const weight = (p, q) => {
      if (inkBefore[p] === inkAfter[q]) return 8
      return after.textured[inkAfter[q]] ? 4 : 1
    }
    for (let i = midA - 1; i >= 0; i--) {
      for (let j = midB - 1; j >= 0; j--) {
        let best = Math.max(score[(i + 1) * w + j], score[i * w + j + 1])
        if (same(pre + i, pre + j)) {
          best = Math.max(
            best,
            score[(i + 1) * w + j + 1] + weight(pre + i, pre + j)
          )
        }
        score[i * w + j] = best
      }
    }
    let i = 0
    let j = 0
    while (i < midA && j < midB) {
      const here = score[i * w + j]
      if (
        same(pre + i, pre + j) &&
        here === score[(i + 1) * w + j + 1] + weight(pre + i, pre + j)
      ) {
        record(pre + i, pre + j)
        i++
        j++
      } else if (here === score[(i + 1) * w + j]) {
        i++
      } else {
        j++
      }
    }
  }

  // Old ink rows with no counterpart, placed at the new-page row that follows
  // them.
  const removedAt = []
  let j = 0
  for (let i = 0; i < n; i++) {
    if (matchedBefore[i] || before.blank[i]) continue
    while (j < m && (matchOf[j] === -1 || matchOf[j] < i)) j++
    const y = Math.min(j, m - 1)
    const last = removedAt.at(-1)
    if (last && last.y === y) last.rows++
    else removedAt.push({ y, rows: 1 })
  }
  return { matchOf, removedAt }
}

/** Mask dilated by `radius` pixels, as a horizontal then vertical sliding max. */
function dilate(mask, width, height, radius) {
  const horizontal = new Uint8Array(width * height)
  const prefix = new Uint32Array(width + 1)
  for (let y = 0; y < height; y++) {
    const base = y * width
    for (let x = 0; x < width; x++) {
      prefix[x + 1] = prefix[x] + mask[base + x]
    }
    for (let x = 0; x < width; x++) {
      const lo = Math.max(0, x - radius)
      const hi = Math.min(width - 1, x + radius)
      horizontal[base + x] = prefix[hi + 1] - prefix[lo] > 0 ? 1 : 0
    }
  }
  const out = new Uint8Array(width * height)
  const colPrefix = new Uint32Array(height + 1)
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      colPrefix[y + 1] = colPrefix[y] + horizontal[y * width + x]
    }
    for (let y = 0; y < height; y++) {
      const lo = Math.max(0, y - radius)
      const hi = Math.min(height - 1, y + radius)
      out[y * width + x] = colPrefix[hi + 1] - colPrefix[lo] > 0 ? 1 : 0
    }
  }
  return out
}

/**
 * Connected components of the dilated mask. A component's box is the extent
 * of its own changed pixels, and components with too few of them are noise.
 */
function components(mask, width, height, radius, minPixels) {
  const dilated = dilate(mask, width, height, radius)
  const seen = new Uint8Array(width * height)
  const boxes = []
  const stack = []
  for (let start = 0; start < dilated.length; start++) {
    if (!dilated[start] || seen[start]) continue
    seen[start] = 1
    stack.push(start)
    let count = 0
    let left = width
    let right = -1
    let top = height
    let bottom = -1
    while (stack.length) {
      const p = stack.pop()
      const x = p % width
      const y = (p - x) / width
      if (mask[p]) {
        count++
        if (x < left) left = x
        if (x > right) right = x
        if (y < top) top = y
        if (y > bottom) bottom = y
      }
      const neighbours = [
        x > 0 ? p - 1 : -1,
        x < width - 1 ? p + 1 : -1,
        y > 0 ? p - width : -1,
        y < height - 1 ? p + width : -1,
      ]
      for (const q of neighbours) {
        if (q >= 0 && dilated[q] && !seen[q]) {
          seen[q] = 1
          stack.push(q)
        }
      }
    }
    if (count >= minPixels) boxes.push({ left, top, right, bottom })
  }
  return boxes
}

function gapOf(a, b) {
  return {
    x: Math.max(0, Math.max(a.left, b.left) - Math.min(a.right, b.right)),
    y: Math.max(0, Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom)),
  }
}

function union(a, b) {
  return {
    kind: a.kind === 'changed' || b.kind === 'changed' ? 'changed' : a.kind,
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  }
}

/**
 * Merges boxes that are within `gapX` across or `gapY` down of each other.
 * A line is wider than it is tall, so its words join across a wider gap.
 */
function mergeBoxes(boxes, gapX, gapY) {
  const list = boxes.map(box => ({ ...box, kind: box.kind ?? 'changed' }))
  let merged = true
  while (merged) {
    merged = false
    outer: for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const d = gapOf(list[i], list[j])
        if (d.x <= gapX && d.y <= gapY) {
          list[i] = union(list[i], list[j])
          list.splice(j, 1)
          merged = true
          break outer
        }
      }
    }
  }
  return list
}

/**
 * Runs of rows that matched at another position: content that moved. A run
 * ends at a row that stayed put or changed, and blank rows do not break it.
 */
function shiftedRuns(kind, shift, blank, height) {
  const runs = []
  let run = null
  for (let y = 0; y <= height; y++) {
    const isShifted = y < height && kind[y] === 2
    if (isShifted) {
      if (run && shift[y] !== run.shift) {
        runs.push(run)
        run = null
      }
      if (!run) run = { top: y, bottom: y, shift: shift[y] }
      run.bottom = y
    } else if (y < height && blank[y] && run) {
      // blank rows inside a run are part of it
    } else if (run) {
      runs.push(run)
      run = null
    }
  }
  return runs
}

function inkExtent(gray, width, top, bottom) {
  let left = width
  let right = -1
  for (let y = top; y <= bottom; y++) {
    for (let x = 0; x < width; x++) {
      if (gray[y * width + x] < INK_LEVEL) {
        if (x < left) left = x
        if (x > right) right = x
      }
    }
  }
  return right < 0 ? null : { left, right }
}

/**
 * Compares two grayscale pages of the same size, at the same DPI.
 *
 * @param {{ width: number, height: number, channels: 1|3, data: Buffer }} before
 * @param {{ width: number, height: number, channels: 1|3, data: Buffer }} after
 * @param {{ dpi?: number, pixelThreshold?: number, rowTolerance?: number,
 *   dilate?: number, mergeGapX?: number, mergeGapY?: number,
 *   minComponentPixels?: number }} [options]
 * @returns {{
 *   changed: boolean,
 *   reason?: 'size_changed',
 *   changedFraction: number,
 *   regions: Array<{x: number, y: number, w: number, h: number, kind: 'changed'|'moved'|'added'}>,
 *   shiftedBelow: {y: number, shiftPx: number, shiftPt: number} | null,
 *   removed: Array<{y: number, rows: number}>
 * }} Fractions of the page, from the top left. `shiftedBelow.shiftPt` is
 *   positive when the content moved down.
 */
export function diffRasters(before, after, options = {}) {
  assertRaster(before, 'diffRasters')
  assertRaster(after, 'diffRasters')
  const {
    dpi = DIFF_DPI,
    pixelThreshold = PIXEL_THRESHOLD,
    rowTolerance = ROW_TOLERANCE,
    dilate: radius = DILATE_PX,
    mergeGapX = MERGE_GAP_X_PX,
    mergeGapY = MERGE_GAP_Y_PX,
    minComponentPixels = MIN_COMPONENT_PX,
  } = options

  if (before.width !== after.width || before.height !== after.height) {
    return {
      changed: true,
      reason: 'size_changed',
      changedFraction: 1,
      regions: [{ x: 0, y: 0, w: 1, h: 1, kind: 'changed' }],
      shiftedBelow: null,
      removed: [],
    }
  }

  const { width, height } = after
  const a = grayOf(after)
  const b = grayOf(before)
  let differs = false
  for (let p = 0; p < a.length && !differs; p++) {
    if (Math.abs(a[p] - b[p]) > pixelThreshold) differs = true
  }
  if (!differs) {
    return {
      changed: false,
      changedFraction: 0,
      regions: [],
      shiftedBelow: null,
      removed: [],
    }
  }

  const sigBefore = rowSignatures(b, width, height)
  const sigAfter = rowSignatures(a, width, height)
  const { matchOf, removedAt } = alignRows(sigBefore, sigAfter, rowTolerance)

  // Per new row: 0 blank or unmatched blank, 1 same place, 2 moved, 3 new ink.
  const kind = new Uint8Array(height)
  const shift = new Int32Array(height)
  const mask = new Uint8Array(width * height)
  let changedPixels = 0
  for (let y = 0; y < height; y++) {
    const base = y * width
    const i = matchOf[y]
    if (i >= 0 && i !== y) {
      if (!sigAfter.blank[y] || !sigBefore.blank[i]) {
        kind[y] = 2
        shift[y] = y - i
      }
      continue
    }
    if (i === y) {
      kind[y] = 1
      for (let x = 0; x < width; x++) {
        if (Math.abs(a[base + x] - b[base + x]) > pixelThreshold) {
          mask[base + x] = 1
          changedPixels++
        }
      }
      continue
    }
    if (sigAfter.blank[y]) continue
    kind[y] = 3
    for (let x = 0; x < width; x++) {
      if (a[base + x] < INK_LEVEL) {
        mask[base + x] = 1
        changedPixels++
      }
    }
  }

  const bodyLimit = Math.floor(height * FOOTER_FROM)
  // Whether same-place ink lies below row `y` in the body, which means the
  // content there did not move with the rest.
  const stayedBelow = y => {
    for (let k = y + 1; k < bodyLimit; k++) {
      if (kind[k] === 1 && !sigAfter.blank[k]) return true
    }
    return false
  }
  const boxes = []
  let shiftedBelow = null
  for (const run of shiftedRuns(kind, shift, sigAfter.blank, height)) {
    // Text that moved with nothing staying put below it is a reflow; a block
    // that moved past text that stayed is a move.
    let textRows = 0
    let inkRows = 0
    for (let y = run.top; y <= run.bottom; y++) {
      if (sigAfter.blank[y]) continue
      inkRows++
      textRows += sigAfter.textured[y]
    }
    const reflow = !stayedBelow(run.bottom) && textRows * 2 >= inkRows
    if (reflow) {
      if (!shiftedBelow) {
        shiftedBelow = {
          y: round(run.top / height),
          shiftPx: run.shift,
          shiftPt: round((run.shift * 72) / dpi, 2),
        }
      }
      continue
    }
    const extent = inkExtent(a, width, run.top, run.bottom)
    if (!extent) continue
    boxes.push({
      kind: 'moved',
      left: extent.left,
      right: extent.right,
      top: run.top,
      bottom: run.bottom,
    })
  }

  for (const box of components(
    mask,
    width,
    height,
    radius,
    minComponentPixels
  )) {
    boxes.push({ ...box, kind: 'changed' })
  }

  // mergeBoxes is cubic in the number of boxes, and a dithered or speckled page
  // can yield thousands. Keep the largest; the small ones are the noise.
  const area = box => (box.right - box.left + 1) * (box.bottom - box.top + 1)
  boxes.sort((p, q) => area(q) - area(p))
  if (boxes.length > MAX_BOXES_BEFORE_MERGE) boxes.length = MAX_BOXES_BEFORE_MERGE
  const merged = mergeBoxes(boxes, mergeGapX, mergeGapY)
  const regions = merged
    .map(box => ({
      x: round(box.left / width),
      y: round(box.top / height),
      w: round((box.right - box.left + 1) / width),
      h: round((box.bottom - box.top + 1) / height),
      kind: box.kind,
      left: box.left,
      top: box.top,
      right: box.right,
      bottom: box.bottom,
    }))
    .sort((p, q) => p.y - q.y || p.x - q.x)
    .map(({ left, top, right, bottom, ...region }) => region)

  const removed = removedAt.map(({ y, rows }) => ({
    y: round(y / height),
    rows,
  }))

  return {
    changed: regions.length > 0 || shiftedBelow !== null || removed.length > 0,
    changedFraction: round(changedPixels / (width * height), 6),
    regions,
    shiftedBelow,
    removed,
  }
}

/** Box-average downscale of a gray raster by `scale` (0 < scale <= 1). */
function shrink(gray, width, height, scale) {
  if (scale >= 1) return { width, height, channels: 1, data: gray }
  const w = Math.max(1, Math.round(width * scale))
  const h = Math.max(1, Math.round(height * scale))
  const out = Buffer.alloc(w * h)
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * height) / h)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / h))
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * width) / w)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / w))
      let sum = 0
      let count = 0
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          sum += gray[yy * width + xx]
          count++
        }
      }
      out[y * w + x] = Math.round(sum / count)
    }
  }
  return { width: w, height: h, channels: 1, data: out }
}

/** RGB copy of a page, with each region outlined in its colour. */
function annotate(gray, width, height, regions, scale) {
  const page = shrink(gray, width, height, scale)
  const { width: w, height: h } = page
  const data = Buffer.alloc(w * h * 3)
  for (let p = 0; p < w * h; p++) {
    data.fill(page.data[p], p * 3, p * 3 + 3)
  }
  const thickness = Math.max(2, Math.round(w / 300))
  for (const region of regions) {
    const [r, g, bl] = REGION_COLORS[region.kind] ?? REGION_COLORS.changed
    const left = Math.max(0, Math.round(region.x * w))
    const top = Math.max(0, Math.round(region.y * h))
    const right = Math.min(w - 1, Math.round((region.x + region.w) * w) - 1)
    const bottom = Math.min(h - 1, Math.round((region.y + region.h) * h) - 1)
    for (let t = 0; t < thickness; t++) {
      for (let x = left; x <= right; x++) {
        for (const y of [top + t, bottom - t]) {
          if (y < 0 || y >= h) continue
          const p = (y * w + x) * 3
          data[p] = r
          data[p + 1] = g
          data[p + 2] = bl
        }
      }
      for (let y = top; y <= bottom; y++) {
        for (const x of [left + t, right - t]) {
          if (x < 0 || x >= w) continue
          const p = (y * w + x) * 3
          data[p] = r
          data[p + 1] = g
          data[p + 2] = bl
        }
      }
    }
  }
  return { width: w, height: h, channels: 3, data }
}

/** Set of words of three or more letters or digits, lower case. */
function wordSet(text) {
  return new Set((text ?? '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const word of a) if (b.has(word)) shared++
  return shared / (a.size + b.size - shared)
}

/**
 * Pairs pages of two builds with different page counts by their words, in
 * order: a weighted LCS over the similarity of each pair of pages.
 *
 * @returns {Array<{before: number|null, after: number|null}>} 0-based indexes
 */
export function pairPagesByText(beforeTexts, afterTexts) {
  const bs = beforeTexts.map(wordSet)
  const as = afterTexts.map(wordSet)
  const n = bs.length
  const m = as.length
  const w = m + 1
  const best = new Float64Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const sim = jaccard(bs[i], as[j])
      let value = Math.max(best[(i + 1) * w + j], best[i * w + j + 1])
      if (sim >= MIN_PAGE_SIMILARITY) {
        value = Math.max(value, best[(i + 1) * w + j + 1] + sim)
      }
      best[i * w + j] = value
    }
  }
  const pairs = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m) {
      const sim = jaccard(bs[i], as[j])
      if (
        sim >= MIN_PAGE_SIMILARITY &&
        best[i * w + j] === best[(i + 1) * w + j + 1] + sim
      ) {
        pairs.push({ before: i++, after: j++ })
        continue
      }
      if (best[(i + 1) * w + j] >= best[i * w + j + 1]) {
        pairs.push({ before: i++, after: null })
      } else {
        pairs.push({ before: null, after: j++ })
      }
    } else if (i < n) {
      pairs.push({ before: i++, after: null })
    } else {
      pairs.push({ before: null, after: j++ })
    }
  }
  return pairs
}

function toPt(px, dpi) {
  return round((px * 72) / dpi, 2)
}

/**
 * @param {object} [deps] tests pass fakes; the defaults use the real CLSI
 *   client and poppler-utils.
 */
export function createPdfVisualDiff({
  getOutputFileStream = (...args) =>
    ClsiManager.promises.getOutputFileStream(...args),
  execFile = promisify(execFileCallback),
  tmpDir = os.tmpdir(),
  maxRememberedBytes = REMEMBER_MAX_BYTES,
} = {}) {
  // Insertion order is recency: a hit moves the build to the end.
  const remembered = new Map()
  let rememberedBytes = 0
  let renderSeq = 0

  async function run(command, args, { maxBuffer = 1024 * 1024 } = {}) {
    try {
      const { stdout } = await execFile(command, args, {
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer,
        encoding: 'utf8',
      })
      return stdout
    } catch (err) {
      if (err?.code === 'ENOENT') {
        throw new VisualDiffError(
          VISUAL_DIFF_ERRORS.RENDERER_UNAVAILABLE,
          `${command} (poppler-utils) is not installed, so PDF pages cannot be compared.`
        )
      }
      throw new VisualDiffError(
        VISUAL_DIFF_ERRORS.RENDER_FAILED,
        `${command} could not read the PDF${err?.killed ? ' in time' : ''}.`
      )
    }
  }

  /** Whether the compile server no longer has the build's output. */
  function isGone(err) {
    if (err instanceof Errors.NotFoundError) return true
    if (err instanceof Errors.OutputFileFetchFailedError) {
      return [404, 410].includes(err.info?.status)
    }
    return false
  }

  async function download(build, side, target) {
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
      if (isGone(err)) {
        throw new VisualDiffError(
          side === 'before'
            ? VISUAL_DIFF_ERRORS.PREVIOUS_BUILD_GONE
            : VISUAL_DIFF_ERRORS.BUILD_GONE,
          side === 'before'
            ? 'The earlier build is no longer kept by the compile server: it keeps only the newest builds of a project, for about 90 minutes. Call rememberBuildPages when that build is compiled to compare against it later.'
            : 'The newer build is no longer kept by the compile server.'
        )
      }
      throw new VisualDiffError(
        VISUAL_DIFF_ERRORS.BUILD_UNAVAILABLE,
        'The PDF of this build could not be fetched from the compile server.'
      )
    }
    try {
      await pipeBounded(stream, target, MAX_OUTPUT_PDF_BYTES)
    } catch (err) {
      if (err instanceof OutputTooLargeError) {
        throw new VisualDiffError(
          VISUAL_DIFF_ERRORS.TOO_LARGE,
          'The PDF of this build is too large to compare.'
        )
      }
      throw new VisualDiffError(
        VISUAL_DIFF_ERRORS.BUILD_UNAVAILABLE,
        'The PDF of this build could not be downloaded.'
      )
    }
  }

  async function pageCountOf(path) {
    const info = await run('pdfinfo', [path])
    const match = /^Pages:\s+(\d+)/m.exec(info)
    if (!match) {
      throw new VisualDiffError(
        VISUAL_DIFF_ERRORS.RENDER_FAILED,
        'The PDF of this build could not be read.'
      )
    }
    return parseInt(match[1], 10)
  }

  /** Text of every page, from a one-off pdftotext run. */
  async function pageTextsOf(path, pageCount) {
    const text = await run(
      'pdftotext',
      ['-layout', '-enc', 'UTF-8', path, '-'],
      { maxBuffer: PAIRING_TEXT_BYTES }
    )
    const pages = text.split('\f')
    return Array.from({ length: pageCount }, (_, k) =>
      (pages[k] ?? '').slice(0, REMEMBER_TEXT_CHARS)
    )
  }

  /**
   * Grayscale rasters of the given 1-based pages, one pdftoppm run per
   * contiguous run of pages. `budget.pixels` is the pixels still allowed for the
   * whole diff, shared by both builds: each page taken from it, and a page too
   * large for MAX_PAGE_PIXELS, is refused before pdftoppm allocates it.
   */
  async function renderPages(path, numbers, dir, budget) {
    const sorted = [...new Set(numbers)].sort((x, y) => x - y)
    const out = new Map()
    if (sorted.length === 0) return out
    // The page sizes come from the PDF itself.
    const info = await run('pdfinfo', [
      '-f',
      String(sorted[0]),
      '-l',
      String(sorted.at(-1)),
      path,
    ])
    const sizes = new Map()
    for (const match of info.matchAll(
      /^Page\s+(\d+)\s+size:\s+([\d.]+) x ([\d.]+)/gm
    )) {
      sizes.set(parseInt(match[1], 10), {
        width: parseFloat(match[2]),
        height: parseFloat(match[3]),
      })
    }
    for (const page of sorted) {
      const size = sizes.get(page)
      if (!size) {
        throw new VisualDiffError(
          VISUAL_DIFF_ERRORS.RENDER_FAILED,
          `The size of page ${page} could not be read.`
        )
      }
      const pixels =
        ((size.width * DIFF_DPI) / 72) * ((size.height * DIFF_DPI) / 72)
      if (pixels > MAX_PAGE_PIXELS) {
        throw new VisualDiffError(
          VISUAL_DIFF_ERRORS.TOO_LARGE,
          `Page ${page} is too large to compare.`
        )
      }
      budget.pixels -= pixels
      if (budget.pixels < 0) {
        throw new VisualDiffError(
          VISUAL_DIFF_ERRORS.TOO_LARGE,
          'These pages are too large to compare together. Pass pages to compare fewer of them.'
        )
      }
    }
    // Each run of consecutive pages is one pdftoppm call, so a diff of pages 1
    // and 300 does not render the 298 between them.
    const stems = []
    for (let i = 0; i < sorted.length; ) {
      let last = i
      while (last + 1 < sorted.length && sorted[last + 1] === sorted[last] + 1) {
        last++
      }
      renderSeq++
      const stem = `r${renderSeq}`
      stems.push(stem)
      await run('pdftoppm', [
        '-gray',
        '-r',
        String(DIFF_DPI),
        '-f',
        String(sorted[i]),
        '-l',
        String(sorted[last]),
        path,
        Path.join(dir, stem),
      ])
      i = last + 1
    }
    const names = await fsPromises.readdir(dir)
    for (const name of names) {
      const stem = stems.find(s => name.startsWith(`${s}-`))
      if (!stem) continue
      const match = /-(\d+)\.pgm$/.exec(name)
      if (!match) continue
      out.set(
        parseInt(match[1], 10),
        parsePnm(await fsPromises.readFile(Path.join(dir, name)))
      )
    }
    return out
  }

  /**
   * A build's pages, read from the remembered PDF when there is one, otherwise
   * from the compile server.
   */
  async function openBuild(build, side, dir) {
    const path = Path.join(dir, `${side}.pdf`)
    const entry = remembered.get(build.key)
    if (entry) {
      remembered.delete(build.key)
      remembered.set(build.key, entry)
      await fsPromises.writeFile(path, entry.pdf)
    } else {
      await download(build, side, path)
    }
    const pageCount = await pageCountOf(path)
    // Memoise the promise, not the result: the callers ask for every page at
    // once with Promise.all, and each would otherwise start its own pdftotext.
    let textsPromise = null
    return {
      pageCount,
      text: async page => {
        textsPromise ??= pageTextsOf(path, pageCount)
        const texts = await textsPromise
        return texts[page - 1] ?? ''
      },
      rasters: (numbers, budget) => renderPages(path, numbers, dir, budget),
    }
  }

  function buildOf({ projectId, userId, buildId, clsiServerId }) {
    return {
      projectId: String(projectId),
      userId: String(userId),
      buildId,
      clsiServerId: clsiServerId || undefined,
      key: [projectId, userId, buildId].join(':'),
    }
  }

  function checkBuildId(buildId, name) {
    if (typeof buildId !== 'string' || !BUILD_ID.test(buildId)) {
      throw new TypeError(`${name} is not a build id`)
    }
  }

  function forget(key) {
    const entry = remembered.get(key)
    if (!entry) return
    remembered.delete(key)
    rememberedBytes -= entry.bytes
  }

  function evict() {
    while (rememberedBytes > maxRememberedBytes && remembered.size > 0) {
      forget(remembered.keys().next().value)
    }
  }

  /**
   * Keeps a build's PDF for a later diffBuilds, so the comparison works after
   * the compile server has dropped the build. Only the file is kept; pages are
   * rendered when a diff asks for them, so this is cheap enough to run after
   * every compile, in the background.
   *
   * @returns {Promise<{ok: true, bytes: number} |
   *   {ok: false, reason: string, message: string}>}
   */
  async function rememberBuildPages({ projectId, userId, buildId, clsiServerId }) {
    checkBuildId(buildId, 'buildId')
    const build = buildOf({ projectId, userId, buildId, clsiServerId })
    const dir = await fsPromises.mkdtemp(Path.join(tmpDir, 'pdf-visual-diff-'))
    try {
      const path = Path.join(dir, 'build.pdf')
      await download(build, 'after', path)
      // Check the size before reading it, so an oversized PDF is never held.
      const { size } = await fsPromises.stat(path)
      if (size > maxRememberedBytes) {
        return {
          ok: false,
          reason: 'too_large',
          message: 'The build is too large to keep for later comparison.',
        }
      }
      const pdf = await fsPromises.readFile(path)
      forget(build.key)
      remembered.set(build.key, { pdf, bytes: pdf.length })
      rememberedBytes += pdf.length
      evict()
      return { ok: true, bytes: pdf.length }
    } catch (err) {
      if (err instanceof VisualDiffError) {
        return { ok: false, reason: err.code, message: err.message }
      }
      throw err
    } finally {
      await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  /**
   * Compares two builds of the same project, page by page.
   *
   * Pages are paired by index when the counts match, otherwise by their words.
   * `pages` (1-based, of the newer build) limits which pages are compared.
   *
   * @returns {Promise<
   *   {ok: true, changed: boolean, beforeBuildId: string, afterBuildId: string,
   *    dpi: number, pageCount: {before: number, after: number},
   *    pairing: 'index'|'text', pages: Array<object>, unchangedPages: number[],
   *    highlights: Array<{page: number, h: number, v: number, width: number,
   *    height: number, kind: string}>, summary: string[],
   *    image: {mimeType: string, data: string, width: number, height: number,
   *    pages: number[]} | null} |
   *   {ok: false, reason: string, message: string}
   * >}
   */
  async function diffBuilds({
    projectId,
    userId,
    beforeBuildId,
    afterBuildId,
    clsiServerId,
    beforeClsiServerId,
    pages,
  }) {
    checkBuildId(beforeBuildId, 'beforeBuildId')
    checkBuildId(afterBuildId, 'afterBuildId')
    const beforeBuild = buildOf({
      projectId,
      userId,
      buildId: beforeBuildId,
      clsiServerId: beforeClsiServerId ?? clsiServerId,
    })
    const afterBuild = buildOf({
      projectId,
      userId,
      buildId: afterBuildId,
      clsiServerId,
    })
    const dir = await fsPromises.mkdtemp(Path.join(tmpDir, 'pdf-visual-diff-'))
    try {
      const beforeSource = await openBuild(beforeBuild, 'before', dir)
      const afterSource = await openBuild(afterBuild, 'after', dir)
      const sameCount = beforeSource.pageCount === afterSource.pageCount
      let pairs
      let pairing
      if (sameCount) {
        pairing = 'index'
        pairs = Array.from({ length: afterSource.pageCount }, (_, k) => ({
          before: k,
          after: k,
        }))
      } else {
        if (
          beforeSource.pageCount > MAX_PAIRING_PAGES ||
          afterSource.pageCount > MAX_PAIRING_PAGES
        ) {
          return {
            ok: false,
            reason: VISUAL_DIFF_ERRORS.TOO_MANY_PAGES,
            message: `The builds have different page counts, so their pages are paired by text, which takes at most ${MAX_PAIRING_PAGES} pages.`,
          }
        }
        pairing = 'text'
        const beforeTexts = await Promise.all(
          Array.from({ length: beforeSource.pageCount }, (_, k) =>
            beforeSource.text(k + 1)
          )
        )
        const afterTexts = await Promise.all(
          Array.from({ length: afterSource.pageCount }, (_, k) =>
            afterSource.text(k + 1)
          )
        )
        pairs = pairPagesByText(beforeTexts, afterTexts)
      }

      // Removed pages are always reported; `pages` applies to the pages of the
      // newer build.
      const wantAfter = pages ? new Set(pages) : null
      const work = pairs.filter(
        pair =>
          pair.after === null || !wantAfter || wantAfter.has(pair.after + 1)
      )

      if (work.length > MAX_DIFF_PAGES) {
        return {
          ok: false,
          reason: VISUAL_DIFF_ERRORS.TOO_MANY_PAGES,
          message: `A diff compares at most ${MAX_DIFF_PAGES} pages at once. Pass pages to choose the ones to compare.`,
        }
      }

      const beforeNeeded = work
        .filter(pair => pair.before !== null && pair.after !== null)
        .map(pair => pair.before + 1)
      const afterNeeded = work
        .filter(pair => pair.after !== null)
        .map(pair => pair.after + 1)
      const budget = { pixels: MAX_DIFF_PIXELS }
      const beforeRasters = await beforeSource.rasters(beforeNeeded, budget)
      const afterRasters = await afterSource.rasters(afterNeeded, budget)

      const results = []
      const unchangedPages = []
      for (const pair of work) {
        const afterPage = pair.after === null ? null : pair.after + 1
        const beforePage = pair.before === null ? null : pair.before + 1
        if (afterPage === null) {
          results.push({
            page: null,
            beforePage,
            status: 'removed',
            changedFraction: 1,
            regions: [],
            shiftedBelow: null,
            removed: [],
            highlights: [],
          })
          continue
        }
        const afterRaster = afterRasters.get(afterPage)
        if (!afterRaster) continue
        const pageWidthPt = toPt(afterRaster.width, DIFF_DPI)
        const pageHeightPt = toPt(afterRaster.height, DIFF_DPI)
        if (beforePage === null) {
          results.push({
            page: afterPage,
            beforePage: null,
            status: 'added',
            changedFraction: 1,
            regions: [{ x: 0, y: 0, w: 1, h: 1, kind: 'added' }],
            shiftedBelow: null,
            removed: [],
            highlights: [
              {
                page: afterPage,
                h: 0,
                v: 0,
                width: pageWidthPt,
                height: pageHeightPt,
                kind: 'added',
              },
            ],
          })
          continue
        }
        const diff = diffRasters(beforeRasters.get(beforePage), afterRaster, {
          dpi: DIFF_DPI,
        })
        if (!diff.changed) {
          unchangedPages.push(afterPage)
          continue
        }
        results.push({
          page: afterPage,
          beforePage,
          status: 'changed',
          changedFraction: diff.changedFraction,
          regions: diff.regions,
          shiftedBelow: diff.shiftedBelow,
          removed: diff.removed,
          highlights: diff.regions.map(region => ({
            page: afterPage,
            h: round(region.x * pageWidthPt, 2),
            v: round(region.y * pageHeightPt, 2),
            width: round(region.w * pageWidthPt, 2),
            height: round(region.h * pageHeightPt, 2),
            kind: region.kind,
          })),
        })
      }

      const highlights = results.flatMap(result => result.highlights)
      const summary = results.map(describeResult)
      if (unchangedPages.length) {
        summary.push(`Pages unchanged: ${unchangedPages.join(', ')}.`)
      }

      const imagePages = results.filter(
        result => result.page !== null && result.status !== 'removed'
      )
      let image = null
      if (imagePages.length) {
        image = await annotatedGrid(
          imagePages,
          afterRasters
        )
      }

      return {
        ok: true,
        changed: results.length > 0,
        beforeBuildId,
        afterBuildId,
        dpi: DIFF_DPI,
        pageCount: {
          before: beforeSource.pageCount,
          after: afterSource.pageCount,
        },
        pairing,
        pages: results.map(({ highlights: _highlights, ...rest }) => rest),
        unchangedPages,
        highlights,
        summary,
        image,
      }
    } catch (err) {
      if (err instanceof VisualDiffError) {
        return { ok: false, reason: err.code, message: err.message }
      }
      throw err
    } finally {
      await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  async function annotatedGrid(results, afterRasters) {
    const tiles = results.map(result => {
      const raster = afterRasters.get(result.page)
      return { raster, regions: result.regions, label: `p${result.page}` }
    })
    const cols = Math.min(tiles.length, 3)
    const rows = Math.ceil(tiles.length / cols)
    const first = tiles[0].raster
    const sized = Math.max(
      1,
      Math.sqrt(TILE_TARGET_PIXELS / (cols * rows * first.width * first.height))
    )
    const scale = Math.min(1, sized)
    const rendered = tiles.map(tile => ({
      raster: annotate(
        grayOf(tile.raster),
        tile.raster.width,
        tile.raster.height,
        tile.regions,
        scale
      ),
      label: tile.label,
    }))
    const canvas = composeGrid(rendered, { columns: cols })
    const data = encodePng(canvas)
    return {
      mimeType: 'image/png',
      data: data.toString('base64'),
      width: canvas.width,
      height: canvas.height,
      pages: results.map(result => result.page),
    }
  }

  return {
    diffBuilds,
    rememberBuildPages,
    rememberedBuildCount: () => remembered.size,
  }
}

function describeResult(result) {
  if (result.status === 'removed') {
    return `Page ${result.beforePage} of the earlier build has no counterpart now (removed).`
  }
  if (result.status === 'added') {
    return `Page ${result.page} is new.`
  }
  const parts = result.regions.map(region => {
    const top = Math.round(region.y * 100)
    const bottom = Math.round((region.y + region.h) * 100)
    return `${region.kind} ${top}%-${bottom}% of page height`
  })
  if (result.shiftedBelow) {
    const dir = result.shiftedBelow.shiftPt >= 0 ? 'down' : 'up'
    parts.push(
      `content below ${Math.round(result.shiftedBelow.y * 100)}% shifted ${dir} by ${Math.abs(result.shiftedBelow.shiftPt)} pt`
    )
  }
  return `Page ${result.page} changed: ${parts.join('; ') || 'content shifted'}.`
}

const defaultVisualDiff = createPdfVisualDiff()

export function diffBuilds(options) {
  return defaultVisualDiff.diffBuilds(options)
}

export function rememberBuildPages(options) {
  return defaultVisualDiff.rememberBuildPages(options)
}

export default {
  diffBuilds,
  diffRasters,
  rememberBuildPages,
  createPdfVisualDiff,
  pairPagesByText,
  VISUAL_DIFF_ERRORS,
}
