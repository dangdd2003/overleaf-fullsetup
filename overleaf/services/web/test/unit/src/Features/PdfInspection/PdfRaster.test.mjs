import { describe, it, expect } from 'vitest'
import { inflateSync } from 'node:zlib'

const { addMargin, analyzeInk, composeGrid, encodePng, parsePnm, tagSize } =
  await import('../../../../../app/src/Features/PdfInspection/PdfRaster.mjs')

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
])

// CRC-32 as PNG defines it, written out here so the encoder's CRCs are checked
// against an independent implementation rather than against zlib itself.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return c >>> 0
})

function crc32Reference(bytes) {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Deterministic bytes, so a failing case reproduces exactly. */
function noise(length, seed = 1) {
  const out = Buffer.alloc(length)
  let s = seed
  for (let i = 0; i < length; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0
    out[i] = s >>> 16
  }
  return out
}

function raster(width, height, channels, fill = 255) {
  return {
    width,
    height,
    channels,
    data: Buffer.alloc(width * height * channels, fill),
  }
}

/** A page of dark strokes on white with word-like gaps, not real glyphs. */
function textPage(width, height, channels = 3) {
  const page = raster(width, height, channels)
  for (let y = 40; y < height - 40; y += 14) {
    for (let row = 0; row < 7; row++) {
      for (let x = 30; x < width - 30; x++) {
        const ink = (x >> 2) % 7 !== 3 && (x * 3 + row) % 4 !== 0
        if (!ink) continue
        const p = ((y + row) * width + x) * channels
        page.data.fill(0, p, p + channels)
      }
    }
  }
  return page
}

function pnm(header, body) {
  return Buffer.concat([Buffer.from(header, 'latin1'), Buffer.from(body)])
}

/** Splits a PNG into chunks, checking each CRC on the way. */
function readChunks(png) {
  expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
  const chunks = []
  let at = 8
  while (at < png.length) {
    const length = png.readUInt32BE(at)
    const type = png.toString('latin1', at + 4, at + 8)
    const body = png.subarray(at + 8, at + 8 + length)
    const crc = png.readUInt32BE(at + 8 + length)
    expect(crc, `${type} CRC`).toBe(
      crc32Reference(png.subarray(at + 4, at + 8 + length))
    )
    chunks.push({ type, body })
    at += 12 + length
  }
  expect(at).toBe(png.length)
  return chunks
}

/** The PNG filter predictors, written as the specification gives them. */
function predictorReference(type, a, b, c) {
  if (type === 1) return a
  if (type === 2) return b
  if (type === 3) return Math.floor((a + b) / 2)
  if (type === 4) {
    const p = a + b - c
    const pa = Math.abs(p - a)
    const pb = Math.abs(p - b)
    const pc = Math.abs(p - c)
    if (pa <= pb && pa <= pc) return a
    if (pb <= pc) return b
    return c
  }
  return 0
}

/** Decodes a PNG the way a reader would: inflate the IDATs, undo each filter. */
function decodePng(png) {
  const chunks = readChunks(png)
  expect(chunks[0].type).toBe('IHDR')
  expect(chunks.at(-1).type).toBe('IEND')
  const idat = chunks.slice(1, -1)
  expect(idat.length).toBeGreaterThanOrEqual(1)
  expect(idat.every(chunk => chunk.type === 'IDAT')).toBe(true)

  const ihdr = chunks[0].body
  const info = {
    width: ihdr.readUInt32BE(0),
    height: ihdr.readUInt32BE(4),
    bitDepth: ihdr[8],
    colorType: ihdr[9],
    compression: ihdr[10],
    filter: ihdr[11],
    interlace: ihdr[12],
  }
  const bpp = info.colorType === 0 ? 1 : 3
  const stride = info.width * bpp
  const filtered = inflateSync(Buffer.concat(idat.map(chunk => chunk.body)))
  expect(filtered.length).toBe(info.height * (stride + 1))

  const pixels = Buffer.alloc(info.height * stride)
  const filters = []
  for (let y = 0; y < info.height; y++) {
    const type = filtered[y * (stride + 1)]
    filters.push(type)
    expect(type).toBeLessThanOrEqual(4)
    for (let i = 0; i < stride; i++) {
      const at = y * stride + i
      const a = i >= bpp ? pixels[at - bpp] : 0
      const b = y > 0 ? pixels[at - stride] : 0
      const c = y > 0 && i >= bpp ? pixels[at - stride - bpp] : 0
      const residual = filtered[y * (stride + 1) + 1 + i]
      pixels[at] = (residual + predictorReference(type, a, b, c)) & 0xff
    }
  }
  return { info, pixels, filters, chunks }
}

describe('parsePnm', () => {
  it('reads a binary grey image', () => {
    const image = parsePnm(pnm('P5\n3 2\n255\n', [0, 10, 20, 30, 40, 50]))
    expect(image).toMatchObject({ width: 3, height: 2, channels: 1 })
    expect([...image.data]).toEqual([0, 10, 20, 30, 40, 50])
  })

  it('reads a binary RGB image', () => {
    const image = parsePnm(pnm('P6\n2 1\n255\n', [255, 0, 0, 0, 0, 255]))
    expect(image).toMatchObject({ width: 2, height: 1, channels: 3 })
    expect([...image.data]).toEqual([255, 0, 0, 0, 0, 255])
  })

  it('skips comments and any whitespace in the header', () => {
    const image = parsePnm(
      pnm(
        'P6\n# made by pdftoppm\n#  two lines\n2\t# width\r\n1\n255\n',
        [1, 2, 3, 4, 5, 6]
      )
    )
    expect(image).toMatchObject({ width: 2, height: 1, channels: 3 })
    expect([...image.data]).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('rejects anything but a binary P5 or P6', () => {
    expect(() => parsePnm(pnm('P3\n1 1\n255\n', [1, 2, 3]))).toThrow(/P5 or P6/)
    expect(() => parsePnm(pnm('P4\n8 1\n', [0]))).toThrow(/P5 or P6/)
    expect(() => parsePnm(Buffer.from('%PDF-1.5 not a pnm'))).toThrow(
      /P5 or P6/
    )
  })

  it('rejects a maxval other than 255', () => {
    expect(() => parsePnm(pnm('P5\n1 1\n65535\n', [0, 0]))).toThrow(
      /maxval 255/
    )
  })

  it('rejects truncated pixel data', () => {
    expect(() => parsePnm(pnm('P6\n2 2\n255\n', [0, 0, 0, 0, 0]))).toThrow(
      /truncated/
    )
  })

  it('rejects a header with a missing or non-numeric field', () => {
    expect(() => parsePnm(pnm('P5\n3\n', []))).toThrow(/height/)
    expect(() => parsePnm(pnm('P5\nthree 2\n255\n', [0]))).toThrow(/width/)
    // a comment is not the one whitespace byte that must follow maxval
    expect(() => parsePnm(pnm('P5\n3 2 255#', [0]))).toThrow(/header/)
  })

  it('rejects zero dimensions', () => {
    expect(() => parsePnm(pnm('P5\n0 2\n255\n', []))).toThrow(/positive/)
  })

  it('rejects input that is not a Buffer', () => {
    expect(() => parsePnm('P5\n1 1\n255\n\u0000')).toThrow(TypeError)
  })
})

describe('encodePng', () => {
  it('writes the signature, an 8-bit greyscale IHDR, one IDAT and IEND', () => {
    const { info, chunks } = decodePng(encodePng(raster(5, 3, 1, 128)))
    expect(info).toEqual({
      width: 5,
      height: 3,
      bitDepth: 8,
      colorType: 0,
      compression: 0,
      filter: 0,
      interlace: 0,
    })
    expect(chunks.map(chunk => chunk.type)).toEqual(['IHDR', 'IDAT', 'IEND'])
    expect(chunks.at(-1).body.length).toBe(0)
  })

  it('marks RGB rasters as colour type 2', () => {
    const { info } = decodePng(encodePng(raster(4, 2, 3)))
    expect(info).toMatchObject({ colorType: 2, bitDepth: 8 })
  })

  it('round-trips grey and RGB pages, noise and text alike', () => {
    for (const channels of [1, 3]) {
      const noisy = {
        width: 37,
        height: 23,
        channels,
        data: noise(37 * 23 * channels, 9),
      }
      expect(decodePng(encodePng(noisy)).pixels.equals(noisy.data)).toBe(true)
      const page = textPage(120, 90, channels)
      expect(decodePng(encodePng(page)).pixels.equals(page.data)).toBe(true)
    }
  })

  it('filters a gradient rather than storing it raw', () => {
    const gradient = {
      width: 256,
      height: 1,
      channels: 1,
      data: Buffer.from(Array.from({ length: 256 }, (_, x) => x)),
    }
    expect(decodePng(encodePng(gradient)).filters[0]).not.toBe(0)
  })

  it('compresses a page of text well below its raw size', () => {
    const page = textPage(612, 792)
    const png = encodePng(page)
    expect(png.length).toBeLessThan(page.data.length / 10)
  })

  it('honours the zlib level', () => {
    const page = textPage(200, 200)
    const stored = encodePng(page, { level: 0 })
    expect(decodePng(stored).pixels.equals(page.data)).toBe(true)
    expect(stored.length).toBeGreaterThan(encodePng(page).length)
  })

  it('rejects a raster with short data or an unknown channel count', () => {
    expect(() =>
      encodePng({ width: 4, height: 4, channels: 3, data: Buffer.alloc(10) })
    ).toThrow(/data/)
    expect(() =>
      encodePng({ width: 4, height: 4, channels: 2, data: Buffer.alloc(32) })
    ).toThrow(/channels/)
  })
})

describe('analyzeInk', () => {
  // Fills [left, right) x [top, bottom) with a grey level or an RGB triple.
  function paint(image, left, top, right, bottom, value) {
    const rgb = Array.isArray(value) ? value : [value, value, value]
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const p = (y * image.width + x) * image.channels
        if (image.channels === 1) {
          image.data[p] = rgb[0]
        } else {
          image.data.set(rgb, p)
        }
      }
    }
    return image
  }

  it('reports a blank page', () => {
    expect(analyzeInk(raster(100, 100, 1))).toEqual({
      blank: true,
      coverage: 0,
      box: null,
      bands: [],
    })
  })

  it('measures one block of text rows', () => {
    const ink = analyzeInk(paint(raster(100, 100, 1), 10, 20, 81, 40, 0))
    expect(ink.blank).toBe(false)
    // 20 rows of 71 inked columns
    expect(ink.coverage).toBeCloseTo(0.142)
    expect(ink.box).toEqual({ left: 0.1, top: 0.2, right: 0.81, bottom: 0.4 })
    expect(ink.bands).toEqual([
      { top: 0.2, bottom: 0.4, left: 0.1, right: 0.81 },
    ])
  })

  it('keeps two bands apart across a large white gap', () => {
    const image = paint(
      paint(raster(100, 100, 1), 10, 10, 50, 20, 0),
      10,
      60,
      50,
      70,
      0
    )
    expect(analyzeInk(image).bands).toEqual([
      { top: 0.1, bottom: 0.2, left: 0.1, right: 0.5 },
      { top: 0.6, bottom: 0.7, left: 0.1, right: 0.5 },
    ])
  })

  // Two 100-row blocks on a 1000-row page, separated by `gap` white rows.
  function twoBlocks(gap, options) {
    const image = raster(40, 1000, 1)
    paint(image, 5, 100, 30, 200, 0)
    paint(image, 5, 200 + gap, 30, 300 + gap, 0)
    return analyzeInk(image, options).bands
  }

  it('merges bands across a gap shorter than mergeGap of the page height', () => {
    // mergeGap 0.006 of 1000 rows is 6 rows: a 5-row gap joins, a 7-row gap does not
    const joined = twoBlocks(5)
    expect(joined).toHaveLength(1)
    expect(joined[0]).toEqual({
      top: 0.1,
      bottom: 0.305,
      left: 0.125,
      right: 0.75,
    })
    expect(twoBlocks(7)).toHaveLength(2)
  })

  it('does not merge across any gap when mergeGap is zero', () => {
    expect(twoBlocks(5, { mergeGap: 0 })).toHaveLength(2)
  })

  it('reports ink sticking out past the text block', () => {
    const image = raster(100, 100, 1)
    paint(image, 10, 10, 50, 60, 0)
    // a table row running past the margin, on its own band
    paint(image, 10, 70, 95, 72, 0)
    const { bands, box } = analyzeInk(image)
    expect(bands.map(band => band.right)).toEqual([0.5, 0.95])
    expect(box.right).toBe(0.95)
  })

  it('ignores a speck with fewer ink pixels than minInkPixels', () => {
    const image = paint(raster(100, 100, 1), 50, 50, 51, 51, 0)
    expect(analyzeInk(image)).toMatchObject({
      blank: true,
      box: null,
      bands: [],
    })
    // the speck still shows in the coverage, which counts every ink pixel
    expect(analyzeInk(image).coverage).toBeCloseTo(0.0001)
    expect(analyzeInk(image, { minInkPixels: 1 }).blank).toBe(false)
  })

  it('does not let an isolated speck stretch the box of a block above it', () => {
    const image = raster(100, 100, 1)
    paint(image, 10, 10, 50, 20, 0)
    paint(image, 95, 50, 96, 51, 0)
    const { box, bands } = analyzeInk(image)
    expect(bands).toHaveLength(1)
    expect(box).toEqual({ left: 0.1, top: 0.1, right: 0.5, bottom: 0.2 })
  })

  it('counts any channel below the threshold as ink', () => {
    const image = raster(100, 100, 3)
    // light grey is not ink; pale blue (min channel 220) is; so is pure red
    // (min channel 0) and an anti-aliased grey of 200
    paint(image, 0, 0, 100, 10, [240, 240, 240])
    paint(image, 0, 20, 100, 30, [220, 236, 250])
    paint(image, 0, 40, 100, 50, [255, 0, 0])
    paint(image, 0, 60, 100, 70, [200, 200, 200])
    const bands = analyzeInk(image).bands
    expect(bands.map(band => [band.top, band.bottom])).toEqual([
      [0.2, 0.3],
      [0.4, 0.5],
      [0.6, 0.7],
    ])
    // a higher threshold also counts the light grey band
    expect(analyzeInk(image, { threshold: 250 }).bands).toHaveLength(4)
  })
})

describe('composeGrid', () => {
  const BORDER = [60, 60, 60]
  const BACKGROUND = [136, 136, 136]
  const LABEL_BOX = [25, 25, 25]
  const WHITE = [255, 255, 255]

  function at(canvas, x, y) {
    const p = (y * canvas.width + x) * 3
    return [...canvas.data.subarray(p, p + 3)]
  }

  const isBox = (canvas, x, y) => at(canvas, x, y).join() === LABEL_BOX.join()

  // The size of the dark label box whose top-left corner is (x, y).
  function boxSize(canvas, x, y) {
    let width = 0
    while (isBox(canvas, x + width, y)) width++
    let height = 0
    while (isBox(canvas, x, y + height)) height++
    return { width, height }
  }

  // Offsets, within the box at (x, y), of its white pixels.
  function whiteInBox(canvas, x, y) {
    const { width, height } = boxSize(canvas, x, y)
    const hits = []
    for (let dy = 0; dy < height; dy++) {
      for (let dx = 0; dx < width; dx++) {
        if (at(canvas, x + dx, y + dy).join() === WHITE.join()) {
          hits.push([dx, dy])
        }
      }
    }
    return hits
  }

  it('sizes the canvas as padding, cells, gaps and padding', () => {
    const grid = composeGrid(
      [
        { raster: raster(20, 10, 1, 77) },
        { raster: raster(40, 30, 3, 10) },
        { raster: raster(40, 30, 3, 10) },
      ],
      { columns: 2 }
    )
    // two columns of 40px cells and two rows of 30px cells, 12px apart
    expect(grid).toMatchObject({
      width: 12 + 40 + 12 + 40 + 12,
      height: 12 + 30 + 12 + 30 + 12,
      channels: 3,
    })
    expect(grid.data.length).toBe(grid.width * grid.height * 3)
  })

  it('lays out up to four columns by default', () => {
    const six = Array.from({ length: 6 }, () => ({ raster: raster(10, 10, 3) }))
    const grid = composeGrid(six)
    expect(grid.width).toBe(12 * 2 + 10 * 4 + 12 * 3)
    expect(grid.height).toBe(12 * 2 + 10 * 2 + 12)
    expect(composeGrid(six.slice(0, 2)).width).toBe(12 * 2 + 10 * 2 + 12)
  })

  it('fills the canvas and the gaps with the background', () => {
    const grid = composeGrid([
      { raster: raster(10, 10, 3, 0) },
      { raster: raster(10, 10, 3, 0) },
    ])
    expect(at(grid, 0, 0)).toEqual(BACKGROUND)
    // tile 0 spans x 12..21 and tile 1 starts at x 34, so x 27 is the gap
    expect(at(grid, 27, 17)).toEqual(BACKGROUND)
    const custom = composeGrid([{ raster: raster(10, 10, 3, 0) }], {
      background: [1, 2, 3],
    })
    expect(at(custom, 0, 0)).toEqual([1, 2, 3])
  })

  it('centres a smaller tile in its cell and frames each tile with a border', () => {
    // a 20x10 grey tile in a 40x30 cell: it starts at (22, 22)
    const grid = composeGrid(
      [{ raster: raster(20, 10, 1, 77) }, { raster: raster(40, 30, 3, 10) }],
      { columns: 2 }
    )
    expect(at(grid, 22, 22)).toEqual([77, 77, 77])
    expect(at(grid, 41, 31)).toEqual([77, 77, 77])
    expect(at(grid, 21, 25)).toEqual(BORDER)
    expect(at(grid, 42, 25)).toEqual(BORDER)
    expect(at(grid, 30, 21)).toEqual(BORDER)
    expect(at(grid, 30, 32)).toEqual(BORDER)
    expect(at(grid, 20, 25)).toEqual(BACKGROUND)
    expect(at(grid, 43, 25)).toEqual(BACKGROUND)
    // the RGB tile in the second cell, which starts at x 64
    expect(at(grid, 80, 30)).toEqual([10, 10, 10])
  })

  it('draws a label box in the top-left corner of its tile', () => {
    const grid = composeGrid(
      [{ raster: raster(300, 400, 3, 200), label: '3' }],
      { columns: 1 }
    )
    // the tile starts at (12, 12) and the box is inset 3px
    expect(at(grid, 15, 15)).toEqual(LABEL_BOX)
    expect(at(grid, 14, 15)).toEqual([200, 200, 200])
    const { width, height } = boxSize(grid, 15, 15)
    expect(height).toBeGreaterThanOrEqual(14)
    expect(width).toBeGreaterThanOrEqual(15)
    // the glyph keeps a margin inside the box
    const hits = whiteInBox(grid, 15, 15)
    expect(hits.length).toBeGreaterThan(0)
    expect(Math.min(...hits.map(([dx]) => dx))).toBeGreaterThanOrEqual(2)
    expect(Math.min(...hits.map(([, dy]) => dy))).toBeGreaterThanOrEqual(2)
    expect(Math.max(...hits.map(([dx]) => dx))).toBeLessThan(width - 2)
    expect(Math.max(...hits.map(([, dy]) => dy))).toBeLessThan(height - 2)
  })

  it('scales the glyphs with the cell width, 14px on small cells and 21px on large', () => {
    const glyphRows = cellWidth => {
      const grid = composeGrid(
        [{ raster: raster(cellWidth, cellWidth, 3, 200), label: '3' }],
        { columns: 1 }
      )
      const rows = whiteInBox(grid, 15, 15).map(([, dy]) => dy)
      return Math.max(...rows) - Math.min(...rows) + 1
    }
    expect(glyphRows(40)).toBe(14)
    expect(glyphRows(300)).toBe(21)
  })

  it('labels each tile, and leaves a tile without a label alone', () => {
    const grid = composeGrid(
      [
        { raster: raster(40, 40, 3, 200), label: '1' },
        { raster: raster(40, 40, 3, 200), label: '2' },
        { raster: raster(40, 40, 3, 200) },
      ],
      { columns: 2 }
    )
    // cells of 40px with 12px gaps: the second tile starts at x 64
    expect(at(grid, 15, 15)).toEqual(LABEL_BOX)
    expect(at(grid, 67, 15)).toEqual(LABEL_BOX)
    expect(at(grid, 15, 67)).toEqual([200, 200, 200])
  })

  it('draws a distinct glyph for each digit, p and dash', () => {
    const shapes = [...'0123456789p-'].map(ch => {
      const grid = composeGrid(
        [{ raster: raster(300, 400, 3, 200), label: ch }],
        { columns: 1 }
      )
      const { width, height } = boxSize(grid, 15, 15)
      let shape = ''
      for (let dy = 0; dy < height; dy++) {
        for (let dx = 0; dx < width; dx++) {
          shape +=
            at(grid, 15 + dx, 15 + dy).join() === WHITE.join() ? '1' : '0'
        }
      }
      return shape
    })
    expect(new Set(shapes).size).toBe(12)
    for (const shape of shapes) expect(shape).toContain('1')
  })

  it('skips characters the font does not know', () => {
    const labelled = label =>
      composeGrid([{ raster: raster(300, 400, 3, 200), label }], { columns: 1 })
    expect(labelled('x3').data.equals(labelled('3').data)).toBe(true)
    expect(at(labelled('xyz'), 15, 15)).toEqual([200, 200, 200])
  })

  it('widens a grey tile to RGB and rejects bad input', () => {
    const grid = composeGrid([{ raster: raster(4, 4, 1, 99) }])
    expect(grid.channels).toBe(3)
    expect(at(grid, 12, 12)).toEqual([99, 99, 99])
    expect(() => composeGrid([])).toThrow(/at least one tile/)
    expect(() =>
      composeGrid([{ raster: raster(4, 4, 1) }], { columns: 0 })
    ).toThrow(/columns/)
  })

  it('composes and encodes twelve 300x400 thumbnails well under a second', () => {
    const page = textPage(300, 400)
    const tiles = Array.from({ length: 12 }, (_, i) => ({
      raster: page,
      label: String(i + 1),
    }))
    const started = performance.now()
    const png = encodePng(composeGrid(tiles))
    const elapsed = performance.now() - started
    expect(elapsed).toBeLessThan(1000)
    expect(decodePng(png).info).toMatchObject({ width: 1260, height: 1248 })
  })
})

describe('tagSize', () => {
  it('sizes a tag from its glyphs: padding, a column between glyphs', () => {
    // four glyphs at scale 2: 2 pads of 4px each side, 4 glyphs of 10px, 3 gaps of 2px
    expect(tagSize('[B3]', 2)).toEqual({ width: 54, height: 22 })
    expect(tagSize('', 2)).toEqual({ width: 0, height: 0 })
    // unknown characters have no glyph and take no room
    expect(tagSize('?', 2)).toEqual({ width: 0, height: 0 })
  })
})

describe('addMargin', () => {
  // A 20x30 grey page, all 200, so that page pixels and the margin are told apart
  const page = {
    width: 20,
    height: 30,
    channels: 1,
    data: Buffer.alloc(600, 200),
  }

  it('adds a white strip on the left and keeps the page to its right', () => {
    const out = addMargin(page, [{ tag: 'B1', top: 4, bottom: 20 }], {
      scale: 2,
    })
    const strip = out.width - page.width
    expect(strip).toBeGreaterThan(tagSize('B1', 2).width)
    expect(out.height).toBe(30)
    expect(out.channels).toBe(1)
    // the top left corner of the margin is white, and the page is unchanged
    expect(out.data[0]).toBe(255)
    for (let y = 0; y < page.height; y++) {
      for (let x = 0; x < page.width; x++) {
        expect(out.data[y * out.width + strip + x]).toBe(200)
      }
    }
  })

  it('draws the tag as a dark box, with a bracket beside it over the mark', () => {
    const out = addMargin(page, [{ tag: 'B1', top: 4, bottom: 20 }], {
      scale: 2,
    })
    const at = (x, y) => out.data[y * out.width + x]
    // the tag sits at the inset, at the mark's top
    expect(at(3, 5)).toBe(25)
    // the bracket runs down the margin beside the mark, not above it
    // the inset, the tag, then a gap of one scale: the bracket is at 2 + tag + 2
    const bracketX = 2 + tagSize('B1', 2).width + 2
    const bracket = Array.from({ length: 30 }, (_, y) => at(bracketX, y))
    expect(bracket.slice(4, 20).some(value => value === 25)).toBe(true)
    // and the page is not marked by the foot of the bracket
    expect(at(out.width - page.width, 10)).toBe(200)
  })

  it('moves a tag down rather than let it overlap the one above', () => {
    // tall enough for two tags of 22px and a gap
    const tall = {
      width: 20,
      height: 60,
      channels: 1,
      data: Buffer.alloc(1200, 200),
    }
    const out = addMargin(
      tall,
      [
        { tag: 'B1', top: 2, bottom: 10 },
        { tag: 'B2', top: 2, bottom: 25 },
      ],
      { scale: 2 }
    )
    const height = tagSize('B1', 2).height
    const second = 2 + height + 2
    // a dark pixel where the second tag starts, and white in the gap between
    expect(out.data[(second + 1) * out.width + 3]).toBe(25)
    expect(out.data[(2 + height) * out.width + 3]).toBe(255)
  })

  it('keeps colour pages in three channels', () => {
    const colour = {
      width: 4,
      height: 4,
      channels: 3,
      data: Buffer.alloc(48, 128),
    }
    const out = addMargin(colour, [{ tag: 'B9', top: 0, bottom: 4 }], {
      scale: 2,
    })
    expect(out.channels).toBe(3)
    expect(out.data.length).toBe(out.width * out.height * 3)
    expect(out.data[0]).toBe(255)
  })

  it('rejects a raster with short data', () => {
    expect(() =>
      addMargin({ width: 2, height: 2, channels: 1, data: Buffer.alloc(1) }, [])
    ).toThrow(/addMargin/)
  })
})
