// Raster helpers for the PDF page overview. A vision model reads a page far
// better from a labelled picture than from a list of numbers, and it miscounts
// grid positions when nothing is labelled, so up to twelve pages go into one
// image with their page numbers drawn on. Facts measured from the same pixels
// (blank gaps between blocks, where the ink ends, text running past the
// margins) go to the model as text, because a thumbnail is too coarse to show
// a two-point overhang.
//
// Everything here is pure: bytes in, bytes out. The caller runs pdftoppm to
// make the PNM pages; this module decodes them, measures the ink, lays out the
// grid and encodes the PNG, without touching disk or a child process.

import { crc32, deflateSync } from 'node:zlib'

/**
 * @typedef {{ width: number, height: number, channels: 1|3, data: Buffer }} Raster
 *
 * Row-major, 8-bit, no padding: `data` holds width * height * channels bytes.
 */

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
])
const PNM_CHANNELS = new Map([
  ['P5', 1],
  ['P6', 3],
])
const HASH = 0x23
const DEFAULT_GRID_COLUMNS = 4
const BORDER_RGB = [60, 60, 60]
const LABEL_BOX_RGB = [25, 25, 25]
const LABEL_TEXT_RGB = [255, 255, 255]
// Distance from a tile's top-left corner to its label box.
const LABEL_INSET = 3
const GLYPH_WIDTH = 5
const GLYPH_HEIGHT = 7

// 5x7 bitmap font: the digits, 'p' for a page prefix, '-' for a range, and the
// letter and brackets of a block tag such as [B3]. A label needs no more than
// that, and anything else is skipped.
const GLYPHS = new Map([
  ['B', ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.']],
  ['[', ['.###.', '.#...', '.#...', '.#...', '.#...', '.#...', '.###.']],
  [']', ['.###.', '...#.', '...#.', '...#.', '...#.', '...#.', '.###.']],
  ['0', ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.']],
  ['1', ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.']],
  ['2', ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####']],
  ['3', ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.']],
  ['4', ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.']],
  ['5', ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.']],
  ['6', ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.']],
  ['7', ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...']],
  ['8', ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.']],
  ['9', ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..']],
  ['p', ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....']],
  ['-', ['.....', '.....', '.....', '#####', '.....', '.....', '.....']],
])

function isSpace(byte) {
  return byte === 0x20 || (byte >= 0x09 && byte <= 0x0d)
}

function isLineEnd(byte) {
  return byte === 0x0a || byte === 0x0d
}

function headerInteger(token, name) {
  if (!/^\d+$/.test(token)) {
    const found = token ? JSON.stringify(token) : 'the end of the data'
    throw new Error(`PNM: ${name} must be a whole number, found ${found}`)
  }
  return Number(token)
}

/**
 * Decodes a binary PNM as pdftoppm writes it: P5 (grey) or P6 (RGB) with a
 * maxval of 255. The returned `data` is a view onto `buffer`, not a copy.
 *
 * @param {Buffer} buffer
 * @returns {Raster}
 */
export function parsePnm(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('parsePnm expects a Buffer')
  }
  const magic = buffer.toString('latin1', 0, 2)
  const channels = PNM_CHANNELS.get(magic)
  if (!channels) {
    throw new Error(
      `PNM: expected a binary P5 or P6 image, found ${JSON.stringify(magic)}`
    )
  }

  let offset = 2
  // Comments run from '#' to the end of the line; whitespace separates tokens.
  function nextToken() {
    while (offset < buffer.length) {
      if (isSpace(buffer[offset])) {
        offset++
      } else if (buffer[offset] === HASH) {
        while (offset < buffer.length && !isLineEnd(buffer[offset])) offset++
      } else {
        break
      }
    }
    const start = offset
    while (
      offset < buffer.length &&
      !isSpace(buffer[offset]) &&
      buffer[offset] !== HASH
    ) {
      offset++
    }
    return buffer.toString('latin1', start, offset)
  }

  const width = headerInteger(nextToken(), 'width')
  const height = headerInteger(nextToken(), 'height')
  const maxval = headerInteger(nextToken(), 'maxval')
  if (width < 1 || height < 1) {
    throw new Error(
      `PNM: width and height must be positive, found ${width}x${height}`
    )
  }
  if (maxval !== 255) {
    throw new Error(`PNM: only maxval 255 is supported, found ${maxval}`)
  }
  // The one whitespace byte after maxval ends the header; it is not a pixel.
  if (offset >= buffer.length || !isSpace(buffer[offset])) {
    throw new Error('PNM: header is not followed by whitespace and pixel data')
  }
  const start = offset + 1
  const size = width * height * channels
  if (buffer.length - start < size) {
    const found = Math.max(0, buffer.length - start)
    throw new Error(
      `PNM: pixel data is truncated: ${width}x${height} needs ${size} bytes, found ${found}`
    )
  }
  return { width, height, channels, data: buffer.subarray(start, start + size) }
}

function assertRaster(raster, caller) {
  const { width, height, channels, data } = raster ?? {}
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new Error(
      `${caller}: a raster needs a positive integer width and height`
    )
  }
  if (channels !== 1 && channels !== 3) {
    throw new Error(
      `${caller}: channels must be 1 (grey) or 3 (RGB), found ${channels}`
    )
  }
  const needed = width * height * channels
  if (!data || data.length < needed) {
    throw new Error(
      `${caller}: data must hold ${needed} bytes for a ${width}x${height} raster`
    )
  }
}

// The size of a residual byte read as signed: the number the filter choice
// minimises. A table is cheaper than the branch, and this runs on every byte.
const SIGNED_MAGNITUDE = Uint8Array.from({ length: 256 }, (_, v) =>
  v < 128 ? v : 256 - v
)

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

// The five PNG filters, one loop each so that no byte pays for a branch on the
// filter type. Each writes the residuals of one scanline into `out` and returns
// the sum of their signed magnitudes. `row` is the unfiltered scanline, `above`
// the one before it (zeros for the first row), and `bpp` the bytes per pixel,
// so the byte `bpp` back is the same channel of the pixel to the left.
function filterNone(row, above, bpp, out) {
  let sum = 0
  for (let i = 0; i < row.length; i++) {
    out[i] = row[i]
    sum += SIGNED_MAGNITUDE[row[i]]
  }
  return sum
}

function filterSub(row, above, bpp, out) {
  let sum = 0
  for (let i = 0; i < row.length; i++) {
    const residual = (row[i] - (i >= bpp ? row[i - bpp] : 0)) & 0xff
    out[i] = residual
    sum += SIGNED_MAGNITUDE[residual]
  }
  return sum
}

function filterUp(row, above, bpp, out) {
  let sum = 0
  for (let i = 0; i < row.length; i++) {
    const residual = (row[i] - above[i]) & 0xff
    out[i] = residual
    sum += SIGNED_MAGNITUDE[residual]
  }
  return sum
}

function filterAverage(row, above, bpp, out) {
  let sum = 0
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? row[i - bpp] : 0
    const residual = (row[i] - ((a + above[i]) >> 1)) & 0xff
    out[i] = residual
    sum += SIGNED_MAGNITUDE[residual]
  }
  return sum
}

function filterPaeth(row, above, bpp, out) {
  let sum = 0
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? row[i - bpp] : 0
    const c = i >= bpp ? above[i - bpp] : 0
    const residual = (row[i] - paeth(a, above[i], c)) & 0xff
    out[i] = residual
    sum += SIGNED_MAGNITUDE[residual]
  }
  return sum
}

// Indexed by PNG filter type, so the index is the byte written to each row.
const SCANLINE_FILTERS = [
  filterNone,
  filterSub,
  filterUp,
  filterAverage,
  filterPaeth,
]

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeBytes = Buffer.from(type, 'latin1')
  const crc = Buffer.alloc(4)
  // The CRC covers the type and the data, not the length field.
  crc.writeUInt32BE(crc32(data, crc32(typeBytes)))
  return Buffer.concat([length, typeBytes, data, crc])
}

/**
 * Encodes a raster as an 8-bit PNG: grey for one channel, RGB for three. Each
 * row takes the filter that leaves the smallest sum of absolute residuals, the
 * standard heuristic. A white page filters to mostly zeros and deflates to a
 * few kilobytes.
 *
 * @param {Raster} raster
 * @param {{ level?: number }} [options] zlib level, 0 to 9
 * @returns {Buffer}
 */
export function encodePng(raster, { level = 9 } = {}) {
  assertRaster(raster, 'encodePng')
  const { width, height, channels, data } = raster
  const stride = width * channels
  const scanlines = Buffer.alloc(height * (stride + 1))
  const zeros = Buffer.alloc(stride)
  // Two scratch rows: the filter being tried, and the best one so far. They
  // trade places instead of copying whenever a filter wins.
  let trial = Buffer.alloc(stride)
  let best = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * stride, (y + 1) * stride)
    const above = y === 0 ? zeros : data.subarray((y - 1) * stride, y * stride)
    let bestSum = Infinity
    let bestType = 0
    for (let type = 0; type < SCANLINE_FILTERS.length; type++) {
      const sum = SCANLINE_FILTERS[type](row, above, channels, trial)
      if (sum < bestSum) {
        bestSum = sum
        bestType = type
        ;[best, trial] = [trial, best]
      }
    }
    const at = y * (stride + 1)
    scanlines[at] = bestType
    scanlines.set(best, at + 1)
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  // Colour type 0 is greyscale and 2 is RGB. Compression, filter and interlace
  // methods stay 0.
  header[9] = channels === 1 ? 0 : 2
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines, { level })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Where the ink on a page is, measured in one pass over the pixels.
 *
 * A pixel is ink when its darkest channel is below `threshold`, so light fills
 * and anti-aliased grey both count. A row has ink when it holds at least
 * `minInkPixels` ink pixels, which keeps a stray speck from stretching a band or
 * the box. Bands are the vertical runs of inked rows, joined across white gaps
 * shorter than `mergeGap` of the page height.
 *
 * Positions are fractions of width and height. `right` and `bottom` are
 * exclusive edges, so a block ending at the last column reads 1. `coverage`
 * counts every ink pixel, specks included.
 *
 * @param {Raster} raster
 * @param {{ threshold?: number, minInkPixels?: number, mergeGap?: number }} [options]
 * @returns {{
 *   blank: boolean,
 *   coverage: number,
 *   box: {left: number, top: number, right: number, bottom: number} | null,
 *   bands: Array<{top: number, bottom: number, left: number, right: number}>,
 * }}
 */
export function analyzeInk(
  raster,
  { threshold = 235, minInkPixels = 2, mergeGap = 0.006 } = {}
) {
  assertRaster(raster, 'analyzeInk')
  const { width, height, channels, data } = raster
  const stride = width * channels
  const runs = []
  let run = null
  let inkPixels = 0
  for (let y = 0; y < height; y++) {
    let count = 0
    let first = -1
    let last = -1
    const rowStart = y * stride
    for (let x = 0; x < width; x++) {
      const p = rowStart + x * channels
      let v = data[p]
      if (channels === 3) {
        v = Math.min(v, data[p + 1], data[p + 2])
      }
      if (v < threshold) {
        count++
        if (first < 0) first = x
        last = x
      }
    }
    inkPixels += count
    if (count === 0 || count < minInkPixels) {
      if (run) {
        runs.push(run)
        run = null
      }
      continue
    }
    if (run) {
      run.bottom = y + 1
      run.left = Math.min(run.left, first)
      run.right = Math.max(run.right, last + 1)
    } else {
      run = { top: y, bottom: y + 1, left: first, right: last + 1 }
    }
  }
  if (run) runs.push(run)

  // Two runs with fewer than mergeGap * height white rows between them are one
  // band, so a heading and its paragraph read as one block.
  const maxGap = mergeGap * height
  const merged = []
  for (const next of runs) {
    const prev = merged.at(-1)
    if (prev && next.top - prev.bottom < maxGap) {
      prev.bottom = next.bottom
      prev.left = Math.min(prev.left, next.left)
      prev.right = Math.max(prev.right, next.right)
    } else {
      merged.push(next)
    }
  }

  const bands = merged.map(band => ({
    top: band.top / height,
    bottom: band.bottom / height,
    left: band.left / width,
    right: band.right / width,
  }))
  let box = null
  if (bands.length > 0) {
    box = {
      left: Math.min(...bands.map(band => band.left)),
      top: bands[0].top,
      right: Math.max(...bands.map(band => band.right)),
      bottom: bands.at(-1).bottom,
    }
  }
  return {
    blank: bands.length === 0,
    coverage: inkPixels / (width * height),
    box,
    bands,
  }
}

// Fills [x0, x1) x [y0, y1) with an RGB colour, clipped to the canvas. A grey
// canvas takes the colour's luminance.
function fillRect(canvas, x0, y0, x1, y1, [r, g, b]) {
  const left = Math.max(0, x0)
  const top = Math.max(0, y0)
  const right = Math.min(canvas.width, x1)
  const bottom = Math.min(canvas.height, y1)
  if (canvas.channels === 1) {
    const grey = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
    for (let y = top; y < bottom; y++) {
      canvas.data.fill(grey, y * canvas.width + left, y * canvas.width + right)
    }
    return
  }
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const p = (y * canvas.width + x) * 3
      canvas.data[p] = r
      canvas.data[p + 1] = g
      canvas.data[p + 2] = b
    }
  }
}

// Copies a tile onto the canvas at (x0, y0), widening grey to RGB. Tiles are
// placed inside their cells, so they never need clipping.
function blit(canvas, raster, x0, y0) {
  const { width, height, channels, data } = raster
  for (let y = 0; y < height; y++) {
    const dst = ((y0 + y) * canvas.width + x0) * 3
    if (channels === 3) {
      canvas.data.set(data.subarray(y * width * 3, (y + 1) * width * 3), dst)
      continue
    }
    for (let x = 0; x < width; x++) {
      const v = data[y * width + x]
      const p = dst + x * 3
      canvas.data[p] = v
      canvas.data[p + 1] = v
      canvas.data[p + 2] = v
    }
  }
}

/** The glyphs of `text` the font knows, in order: unknown characters are dropped. */
function glyphsOf(text) {
  return [...String(text)].map(ch => GLYPHS.get(ch)).filter(Boolean)
}

/** The width and height in pixels of a tag drawn by drawTag at `scale`. */
export function tagSize(text, scale) {
  const count = glyphsOf(text).length
  if (count === 0) return { width: 0, height: 0 }
  const pad = 2 * scale
  return {
    // One glyph column of spacing between characters.
    width: 2 * pad + count * GLYPH_WIDTH * scale + (count - 1) * scale,
    height: 2 * pad + GLYPH_HEIGHT * scale,
  }
}

// A dark box with white glyphs, its top-left corner at (x, y). The glyphs are
// scaled by `scale`, so a tag stays legible at any tile size.
function drawTag(canvas, x, y, text, scale) {
  const glyphs = glyphsOf(text)
  if (glyphs.length === 0) return
  const pad = 2 * scale
  const { width, height } = tagSize(text, scale)
  fillRect(canvas, x, y, x + width, y + height, LABEL_BOX_RGB)
  glyphs.forEach((rows, i) => {
    const gx = x + pad + i * (GLYPH_WIDTH + 1) * scale
    const gy = y + pad
    rows.forEach((row, r) => {
      ;[...row].forEach((ch, c) => {
        if (ch !== '#') return
        fillRect(
          canvas,
          gx + c * scale,
          gy + r * scale,
          gx + (c + 1) * scale,
          gy + (r + 1) * scale,
          LABEL_TEXT_RGB
        )
      })
    })
  })
}

// The label box sits in the tile's top-left corner. The glyphs are scaled by
// the cell width, so the same label stays legible on small and large tiles.
function drawLabel(canvas, { x, y }, text, scale) {
  drawTag(canvas, x + LABEL_INSET, y + LABEL_INSET, text, scale)
}

// The margin beside a page: wide enough for a tag, a bracket and a gap.
const MARGIN_BRACKET = 1
const MARGIN_RGB = [255, 255, 255]
const BRACKET_RGB = [25, 25, 25]

/**
 * A copy of `raster` with a white margin on its left, where each mark's tag sits
 * beside a bracket that spans the mark's height. Tags move down when they would
 * overlap the one above, and stay on the image. A mark is `{ tag, top, bottom }`
 * in pixels of `raster`.
 *
 * `scale` sets the glyph size; the margin is as wide as the widest tag.
 * Returns the new raster, with the same channel count.
 *
 * @param {{width: number, height: number, channels: 1|3, data: Buffer}} raster
 * @param {Array<{tag: string, top: number, bottom: number}>} marks
 * @param {{scale?: number}} [options]
 */
export function addMargin(raster, marks, { scale = 2 } = {}) {
  assertRaster(raster, 'addMargin')
  const { width, height, channels, data } = raster
  // A loop, not a spread: a page can have many more marks than a call takes args.
  let tagWidth = 0
  for (const mark of marks) {
    tagWidth = Math.max(tagWidth, tagSize(mark.tag, scale).width)
  }
  const tagHeight = tagSize('B', scale).height
  const inset = scale
  const bracketX = inset + tagWidth + scale
  // the foot of the bracket is three glyph-widths of scale long
  const stripWidth = bracketX + Math.max(MARGIN_BRACKET, 3) * scale + inset
  const canvas = {
    width: width + stripWidth,
    height,
    channels,
    data: Buffer.alloc((width + stripWidth) * height * channels),
  }
  fillRect(canvas, 0, 0, canvas.width, canvas.height, MARGIN_RGB)
  // Copy the page to the right of the strip, row by row.
  const rowBytes = width * channels
  for (let y = 0; y < height; y++) {
    const from = y * rowBytes
    const to = (y * canvas.width + stripWidth) * channels
    data.copy(canvas.data, to, from, from + rowBytes)
  }

  const sorted = [...marks].sort((a, b) => a.top - b.top)
  let previousBottom = -Infinity
  for (const mark of sorted) {
    const top = clamp(
      Math.max(Math.round(mark.top), previousBottom + scale),
      0,
      Math.max(0, height - tagHeight)
    )
    const bottom = Math.min(
      height,
      Math.max(Math.round(mark.bottom), top + tagHeight)
    )
    const thickness = MARGIN_BRACKET * scale
    // The bracket: a vertical rule over the block, with a short foot at each end.
    fillRect(
      canvas,
      bracketX,
      Math.round(mark.top),
      bracketX + thickness,
      bottom,
      BRACKET_RGB
    )
    fillRect(
      canvas,
      bracketX,
      Math.round(mark.top),
      bracketX + 3 * scale,
      Math.round(mark.top) + thickness,
      BRACKET_RGB
    )
    fillRect(
      canvas,
      bracketX,
      bottom - thickness,
      bracketX + 3 * scale,
      bottom,
      BRACKET_RGB
    )
    drawTag(canvas, inset, top, mark.tag, scale)
    previousBottom = top + tagHeight
  }
  return canvas
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/**
 * Lays tiles out in a grid on a mid-grey canvas, one tile per cell, each cell
 * as large as the largest tile. Every tile gets a 1px dark border just outside
 * it, so white pages read as separate pages. A label is drawn in the tile's
 * top-left corner. Labels with no characters the font knows get no box.
 *
 * @param {Array<{ raster: Raster, label?: string }>} tiles
 * @param {{ columns?: number, gap?: number, padding?: number, background?: number[] }} [options]
 *   `columns` defaults to min(tiles.length, 4)
 * @returns {Raster} RGB canvas
 */
export function composeGrid(
  tiles,
  { columns, gap = 12, padding = 12, background = [136, 136, 136] } = {}
) {
  if (!Array.isArray(tiles) || tiles.length === 0) {
    throw new Error('composeGrid needs at least one tile')
  }
  tiles.forEach((tile, i) => assertRaster(tile.raster, `composeGrid tile ${i}`))
  const cols = columns ?? Math.min(tiles.length, DEFAULT_GRID_COLUMNS)
  if (!Number.isInteger(cols) || cols < 1) {
    throw new Error(
      `composeGrid columns must be a positive integer, found ${columns}`
    )
  }
  const rows = Math.ceil(tiles.length / cols)
  const cellWidth = Math.max(...tiles.map(tile => tile.raster.width))
  const cellHeight = Math.max(...tiles.map(tile => tile.raster.height))
  const width = 2 * padding + cols * cellWidth + (cols - 1) * gap
  const height = 2 * padding + rows * cellHeight + (rows - 1) * gap
  const canvas = {
    width,
    height,
    channels: 3,
    data: Buffer.alloc(width * height * 3),
  }
  canvas.data.fill(Buffer.from(background))

  // Each tile is centred in its cell. Borders are drawn before the tiles, so
  // a border that falls on a neighbour is covered by it and never the reverse.
  const placed = tiles.map(({ raster }, i) => {
    const cellX = padding + (i % cols) * (cellWidth + gap)
    const cellY = padding + Math.floor(i / cols) * (cellHeight + gap)
    return {
      raster,
      x: cellX + Math.floor((cellWidth - raster.width) / 2),
      y: cellY + Math.floor((cellHeight - raster.height) / 2),
    }
  })
  for (const { raster, x, y } of placed) {
    const right = x + raster.width
    const bottom = y + raster.height
    fillRect(canvas, x - 1, y - 1, right + 1, y, BORDER_RGB)
    fillRect(canvas, x - 1, bottom, right + 1, bottom + 1, BORDER_RGB)
    fillRect(canvas, x - 1, y, x, bottom, BORDER_RGB)
    fillRect(canvas, right, y, right + 1, bottom, BORDER_RGB)
  }
  for (const { raster, x, y } of placed) {
    blit(canvas, raster, x, y)
  }

  // Labels go last so that they sit on top of every tile.
  const scale = Math.min(3, Math.max(2, Math.round(cellWidth / 90)))
  tiles.forEach((tile, i) => {
    if (tile.label) drawLabel(canvas, placed[i], tile.label, scale)
  })
  return canvas
}
