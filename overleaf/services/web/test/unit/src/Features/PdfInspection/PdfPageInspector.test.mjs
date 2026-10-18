import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import { Readable } from 'node:stream'
import Errors from '../../../../../app/src/Features/Errors/Errors.js'

vi.mock('../../../../../app/src/Features/Compile/CompileManager.mjs', () => ({
  default: { promises: { syncTeX: vi.fn() } },
}))
vi.mock('../../../../../app/src/Features/Compile/ClsiManager.mjs', () => ({
  default: { promises: { getOutputFileStream: vi.fn() } },
}))

const {
  columnOverflowFindings,
  inkBetween,
  localColumnReferences,
  renderOptions,
  badBoxesByPage,
  badBoxesOnPage,
  bodyBands,
  createPdfPageInspector,
  focusSpan,
  imageSize,
  inkBeyond,
  layoutFindings,
  MAX_EDGE_PX_LIMIT,
  MAX_IMAGE_BYTES,
  overflowFindings,
  overviewLayout,
  paperName,
  parsePageSizes,
  parsePdfFonts,
  parsePdfInfo,
  PDF_PAGE_ERRORS,
  PdfPageError,
  renderPlan,
  resolveBlock,
  sampleLines,
  sourceRangesFrom,
  textBlocks,
} = await import('../../../../../app/src/Features/PdfInspection/PdfPageInspector.mjs')

const A4 = { width: 595.276, height: 841.89 }
// Mirrors the inspector's 1 mm overflow floor, for the test assertions
const MIN_OVERFLOW_MM_FOR_TEST = 1.5

/** The first 24 bytes of a PNG: signature, IHDR length and type, size. */
function pngHeader(width, height) {
  const buf = Buffer.alloc(24)
  buf.writeUInt32BE(0x89504e47, 0)
  buf.writeUInt32BE(0x0d0a1a0a, 4)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12)
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

/** A white RGB raster with black rectangles, given in fractions of the page. */
function raster(rects, width = 100, height = 141) {
  const data = Buffer.alloc(width * height * 3, 255)
  for (const [x0, y0, x1, y1] of rects) {
    for (let y = Math.floor(y0 * height); y < Math.ceil(y1 * height); y++) {
      for (let x = Math.floor(x0 * width); x < Math.ceil(x1 * width); x++) {
        data.fill(0, (y * width + x) * 3, (y * width + x) * 3 + 3)
      }
    }
  }
  return { width, height, channels: 3, data }
}

function ppm({ width, height, data }) {
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), data])
}

/** The red channel of a raster, as the grey PGM pdftoppm -gray writes. */
function pgm({ width, height, data }) {
  const grey = Buffer.alloc(width * height)
  for (let i = 0; i < grey.length; i++) grey[i] = data[i * 3]
  return Buffer.concat([Buffer.from(`P5\n${width} ${height}\n255\n`), grey])
}

const FOOTER = [0.48, 0.92, 0.52, 0.935]
const BODY = [0.15, 0.15, 0.85, 0.85]
// What pdftoppm draws for each page of the five-page test PDF
const PAGE_RASTERS = {
  1: raster([[0.3, 0.1, 0.7, 0.13], BODY, FOOTER]),
  2: raster([[0.15, 0.12, 0.85, 0.5], FOOTER]),
  3: raster([[0.15, 0.12, 0.85, 0.85], [0.15, 0.4, 0.97, 0.45], FOOTER]),
  4: raster([FOOTER]),
  5: raster([[0.15, 0.12, 0.85, 0.3], [0.15, 0.55, 0.85, 0.85], FOOTER]),
}

function word(x0, x1, y0, text) {
  return `<word xMin="${x0}" yMin="${y0}" xMax="${x1}" yMax="${y0 + 12}">${text}</word>`
}

function line(words) {
  const y0 = /yMin="([\d.]+)"/.exec(words[0])[1]
  return `<line xMin="0" yMin="${y0}" xMax="0" yMax="${Number(y0) + 12}">${words.join('')}</line>`
}

function block(lines) {
  return `<block xMin="0" yMin="0" xMax="0" yMax="0">${lines.join('')}</block>`
}

// What pdftotext reads off each page
const PAGE_TEXT = {
  1: [block([line([word(100, 180, 100, 'Introduction')])])],
  2: [
    block([
      line([
        word(100, 115, 300, 'As'),
        word(118, 150, 300, 'shown'),
        word(153, 160, 300, 'in'),
        word(163, 200, 300, 'Figure'),
        word(203, 215, 300, '??'),
        word(218, 235, 300, 'the'),
      ]),
    ]),
    block([
      line([
        word(100, 140, 500, 'results'),
        word(143, 155, 500, '[?]'),
        word(158, 180, 500, 'hold.'),
      ]),
    ]),
  ],
  3: [
    block([
      line([word(100, 115, 200, 'an'), word(118, 160, 200, 'experi-')]),
      line([word(100, 140, 214, 'ment'), word(143, 170, 214, 'works')]),
    ]),
  ],
}

function bboxLayout(from, to) {
  const pages = []
  for (let page = from; page <= to; page++) {
    pages.push(
      `<page width="595.276" height="841.89"><flow>${(PAGE_TEXT[page] ?? []).join('')}</flow></page>`
    )
  }
  return `<html><body><doc>${pages.join('\n')}</doc></body></html>`
}

function fontLine(name, type, emb) {
  return `${name.padEnd(36)} ${type.padEnd(17)} ${'Custom'.padEnd(16)} ${emb.padEnd(3)} no  no      4  0`
}

const PDF_FONTS = [
  `${'name'.padEnd(36)} ${'type'.padEnd(17)} ${'encoding'.padEnd(16)} emb sub uni object ID`,
  `${'-'.repeat(36)} ${'-'.repeat(17)} ${'-'.repeat(16)} --- --- --- ---------`,
  fontLine('ABCDEF+LMRoman10-Regular', 'Type 1C', 'yes'),
  fontLine('[none]', 'Type 3', 'yes'),
  fontLine('Arial', 'TrueType', 'no'),
].join('\n')

const PDF_INFO = [
  'Producer:        pdfTeX-1.40.26',
  'Pages:           5',
  'Page    2 size: 595.276 x 841.89 pts (A4)',
  'Page    2 rot:  0',
].join('\n')

/** pdfinfo for the five-page PDF, with the sizes of the pages asked for. */
function pdfInfo(args) {
  const lines = ['Producer:        pdfTeX-1.40.26', 'Pages:           5']
  if (args[0] !== '-f') {
    return [...lines, 'Page size:       595.276 x 841.89 pts (A4)'].join('\n')
  }
  const from = Number(args[1])
  const to = Math.min(Number(args[3]), 5)
  for (let page = from; page <= to; page++) {
    const n = String(page).padStart(4)
    lines.push(`Page ${n} size: 595.276 x 841.89 pts (A4)`, `Page ${n} rot:  0`)
  }
  return lines.join('\n')
}

const LOG = [
  '(./main.tex [1]',
  'Overfull \\hbox (48.2pt too wide) in alignment at lines 40--52',
  ' []',
  '[2]',
  '(./chapters/intro.tex',
  'Underfull \\hbox (badness 10000) in paragraph at lines 7--7',
  '[]',
  ')',
  'Overfull \\hbox (1.5pt too wide) in paragraph at lines 90--91',
  '[3])',
].join('\n')

describe('PdfPageInspector helpers', () => {
  it('reads the page count and the size of the requested page', () => {
    expect(parsePdfInfo(PDF_INFO, 2)).toEqual({
      pageCount: 5,
      pageSize: { width: 595.276, height: 841.89 },
    })
  })

  it('swaps the sides of a page rotated by 90 degrees', () => {
    const info = [
      'Pages: 1',
      'Page    1 size: 595 x 842 pts',
      'Page    1 rot:  90',
    ].join('\n')
    expect(parsePdfInfo(info, 1).pageSize).toEqual({ width: 842, height: 595 })
  })

  it('has no page size for a page past the end', () => {
    expect(parsePdfInfo('Pages: 5\n', 9)).toEqual({
      pageCount: 5,
      pageSize: null,
    })
  })

  it('reads the size of every page in a range, rotated as rendered', () => {
    const { pageCount, sizes } = parsePageSizes(
      [
        'Pages:           3',
        'Page    1 size: 595 x 842 pts (A4)',
        'Page    1 rot:  0',
        'Page    2 size: 595 x 842 pts (A4)',
        'Page    2 rot:  90',
      ].join('\n')
    )
    expect(pageCount).toBe(3)
    expect(sizes.get(1)).toEqual({ width: 595, height: 842 })
    expect(sizes.get(2)).toEqual({ width: 842, height: 595 })
    expect(sizes.has(3)).toBe(false)
  })

  it('names standard paper sizes either way round', () => {
    expect(paperName(A4)).toBe('A4')
    expect(paperName({ width: 792, height: 612 })).toBe('Letter')
    expect(paperName({ width: 500, height: 500 })).toBeNull()
  })

  it('lists the fonts that are not embedded or are Type 3', () => {
    expect(parsePdfFonts(PDF_FONTS)).toEqual({
      total: 3,
      notEmbedded: ['Arial'],
      type3: ['[none]'],
    })
    expect(parsePdfFonts('no fonts here')).toEqual({
      total: 0,
      notEmbedded: [],
      type3: [],
    })
  })

  it('reads the pixel size of a PNG and a JPEG', () => {
    expect(imageSize(pngHeader(1240, 1754))).toEqual({
      width: 1240,
      height: 1754,
    })
    // SOI, an APP0 segment, then SOF0 with height 300 and width 200
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11,
      0x08, 0x01, 0x2c, 0x00, 0xc8, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ])
    expect(imageSize(jpeg)).toEqual({ width: 200, height: 300 })
    expect(imageSize(Buffer.from('not an image at all, really'))).toBeNull()
  })

  it('renders a full A4 page at 150 dpi and zooms a region to twice that', () => {
    expect(renderPlan(A4, 'full')).toEqual({
      dpi: 150,
      top: 0,
      bottom: 1,
      crop: null,
    })
    const middle = renderPlan(A4, 'middle')
    // 2400px across 595pt caps the zoom just under 300 dpi
    expect(middle.dpi).toBe(290)
    expect(middle.crop).toEqual({
      x: 0,
      y: Math.floor(841.89 * 0.3 * (290 / 72)),
      width: Math.ceil(595.276 * (290 / 72)),
      height: Math.ceil(841.89 * 0.4 * (290 / 72)),
    })
  })

  it('zooms on a band given as fractions of the page', () => {
    const plan = renderPlan(A4, { top: 0.25, bottom: 0.5 })
    expect(plan.dpi).toBe(290)
    expect(plan.crop.y).toBe(Math.floor(841.89 * 0.25 * (290 / 72)))
    expect(renderPlan(A4, { top: 0, bottom: 1 }).crop).toBeNull()
  })

  it('lowers the resolution of a large page to stay within 2400px', () => {
    const a0 = { width: 2384, height: 3370 }
    const plan = renderPlan(a0, 'full')
    expect(Math.ceil((a0.height * plan.dpi) / 72)).toBeLessThanOrEqual(2400)
  })

  it('pads the band of a block and keeps it on the page', () => {
    // SyncTeX boxes: v is the bottom edge, height reaches up from it
    const tall = focusSpan(
      [
        { v: 300, height: 10 },
        { v: 500, height: 12 },
      ],
      1000
    )
    expect(tall.top).toBeCloseTo(0.26)
    expect(tall.bottom).toBeCloseTo(0.53)
    const short = focusSpan([{ v: 505, height: 10 }], 1000)
    expect(short.bottom - short.top).toBeCloseTo(0.15)
    const atTop = focusSpan([{ v: 20, height: 10 }], 1000)
    expect(atTop.top).toBe(0)
    expect(atTop.bottom).toBeCloseTo(0.15)
  })

  it('samples a long block evenly, ends included', () => {
    expect(sampleLines(10, 13)).toEqual([10, 11, 12, 13])
    const lines = sampleLines(1, 301, 16)
    expect(lines).toHaveLength(16)
    expect(lines[0]).toBe(1)
    expect(lines.at(-1)).toBe(301)
  })

  it('collects the line span of each file in the order it first appears', () => {
    expect(
      sourceRangesFrom([
        { path: 'main.tex', line: 40 },
        { path: 'tables/t.tex', line: 3 },
        { path: 'main.tex', line: 44 },
      ])
    ).toEqual([
      { path: 'main.tex', startLine: 40, endLine: 44 },
      { path: 'tables/t.tex', startLine: 3, endLine: 3 },
    ])
  })

  it('keeps the bad boxes built on the page or typeset from its source lines', () => {
    const typesetting = [
      { file: './main.tex', line: 40, page: 2, message: 'Overfull A' },
      {
        file: './chapters/intro.tex',
        line: 7,
        page: 3,
        message: 'Underfull B',
      },
      { file: './main.tex', line: 90, page: 3, message: 'Overfull C' },
    ]
    const boxes = badBoxesOnPage(typesetting, {
      page: 2,
      ranges: [{ path: 'chapters/intro.tex', startLine: 1, endLine: 6 }],
      rootDocPath: 'main.tex',
    })
    expect(boxes).toEqual([
      { path: 'main.tex', line: 40, message: 'Overfull A' },
      // line 7 is one past the sampled span: SyncTeX samples are sparse
      { path: 'chapters/intro.tex', line: 7, message: 'Underfull B' },
    ])
  })

  it('counts the bad boxes of each page and keeps the widest overfull one', () => {
    const byPage = badBoxesByPage(
      [
        {
          file: './a.tex',
          line: 1,
          page: 3,
          message: 'Underfull \\hbox (badness 10000)',
        },
        {
          file: './a.tex',
          line: 9,
          page: 3,
          message: 'Overfull \\hbox (2.5pt too wide)',
        },
        {
          file: './a.tex',
          line: 20,
          page: 3,
          message: 'Overfull \\hbox (31.0pt too wide)',
        },
        {
          file: './b.tex',
          line: 4,
          page: 4,
          message: 'Underfull \\vbox (badness 10000)',
        },
      ],
      'sub/main.tex'
    )
    expect(byPage.get(3)).toMatchObject({
      count: 3,
      worst: { path: 'sub/a.tex', line: 20 },
    })
    expect(byPage.get(4).worst.message).toMatch(/Underfull/)
  })

  it('leaves a running header and a page number out of the body', () => {
    const bands = [
      { top: 0.05, bottom: 0.065, left: 0.1, right: 0.9 },
      { top: 0.12, bottom: 0.8, left: 0.15, right: 0.85 },
      { top: 0.92, bottom: 0.935, left: 0.48, right: 0.52 },
    ]
    expect(bodyBands(bands)).toEqual([bands[1]])
    // A page number alone is a blank page
    expect(bodyBands([bands[2]])).toEqual([])
  })

  it('reports where a page ends early and its large empty bands', () => {
    const footer = { top: 0.92, bottom: 0.935, left: 0.48, right: 0.52 }
    expect(
      layoutFindings([
        { top: 0.12, bottom: 0.5, left: 0.15, right: 0.85 },
        footer,
      ])
    ).toMatchObject({ blank: false, endsAt: 50, gaps: [] })
    expect(
      layoutFindings([{ top: 0.12, bottom: 0.5, left: 0.15, right: 0.85 }], {
        lastPage: true,
      }).endsAt
    ).toBeNull()
    expect(
      layoutFindings([
        { top: 0.12, bottom: 0.3, left: 0.15, right: 0.85 },
        { top: 0.55, bottom: 0.85, left: 0.15, right: 0.85 },
      ]).gaps
    ).toEqual([{ top: 30, bottom: 55 }])
    expect(layoutFindings([footer])).toMatchObject({ blank: true, body: null })
  })

  it('finds the rows with ink past a column, and how far it reaches', () => {
    const page = raster([[0.15, 0.4, 0.97, 0.45]])
    const [run, ...rest] = inkBeyond(page, { side: 'right', limit: 0.86 })
    expect(rest).toEqual([])
    expect(run.top).toBeCloseTo(56 / 141)
    expect(run.bottom).toBeCloseTo(64 / 141)
    expect(run.beyond).toBeCloseTo(0.11)
    expect(inkBeyond(page, { side: 'left', limit: 0.1 })).toEqual([])
  })

  it('reports ink past the text block in millimetres, and near the paper edge', () => {
    const page = raster([BODY, [0.15, 0.4, 0.97, 0.45]])
    const body = { top: 0.15, bottom: 0.85, left: 0.15, right: 0.97 }
    const [past] = overflowFindings(page, {
      body,
      textBlock: { left: 0.15, right: 0.85 },
      widthPt: A4.width,
    })
    expect(past).toMatchObject({
      side: 'right',
      reference: 'textBlock',
      top: 40,
      bottom: 45,
    })
    // 0.12 of 210mm
    expect(past.mm).toBeCloseTo(25.2, 0)
    const [edge] = overflowFindings(page, {
      body,
      textBlock: null,
      widthPt: A4.width,
    })
    expect(edge).toMatchObject({ side: 'right', reference: 'paper' })
    expect(edge.mm).toBeCloseTo(6.3, 0)
    expect(
      overflowFindings(raster([BODY]), {
        body: { top: 0.15, bottom: 0.85, left: 0.15, right: 0.85 },
        textBlock: { left: 0.15, right: 0.85 },
        widthPt: A4.width,
      })
    ).toEqual([])
  })

  it('takes the text block from at least three pages of the same size', () => {
    const body = right => ({ top: 0.1, bottom: 0.9, left: 0.15, right })
    const pageOf = (right, size = A4) => ({ size, body: body(right) })
    const blockOf = textBlocks([
      pageOf(0.85),
      pageOf(0.97),
      pageOf(0.85),
      { size: A4, body: null },
      pageOf(0.9, { width: 842, height: 595 }),
    ])
    expect(blockOf(A4)).toEqual({ left: 0.15, right: 0.85 })
    expect(blockOf({ width: 842, height: 595 })).toBeNull()
  })

  it('lays thumbnails out in rows sized to about a megapixel', () => {
    expect(overviewLayout(Array(12).fill(A4))).toEqual({ columns: 4, dpi: 31 })
    expect(overviewLayout(Array(5).fill(A4)).columns).toBe(3)
    expect(overviewLayout([A4])).toEqual({ columns: 1, dpi: 109 })
  })

  it('has no DPI ceiling and lays out any number of pages', () => {
    const many = overviewLayout(Array(40).fill(A4))
    expect(many.columns).toBe(4)
    expect(many.dpi).toBeGreaterThanOrEqual(20)
  })
})

describe('column and option helpers', () => {
  it('lowers the DPI of a page to a smaller long-edge cap', () => {
    expect(renderPlan(A4, 'full', 150, 1200).dpi).toBe(102)
    expect(renderPlan(A4, 'full', 150).dpi).toBe(150)
  })

  it('reads the ink between two edges, with its outermost point', () => {
    const page = raster([[0.5, 0.1, 0.52, 0.2]], 200, 282)
    const [run] = inkBetween(page, { side: 'right', from: 0.4, to: 0.6 })
    expect(run.extent).toBeCloseTo(0.52, 2)
    expect(run.top).toBeCloseTo(0.1, 2)
    const [left] = inkBetween(page, { side: 'left', from: 0.4, to: 0.6 })
    expect(left.extent).toBeCloseTo(0.5, 2)
    expect(inkBetween(page, { side: 'right', from: 0.6, to: 1 })).toEqual([])
  })

  it('finds ink in the gutter beside a column, once, and not the text of the next', () => {
    const refs = [
      { left: 0.12, right: 0.5 },
      { left: 0.52, right: 0.9 },
    ]
    const bands = [[{ top: 0.2, bottom: 0.22 }], [{ top: 0.2, bottom: 0.22 }]]
    // Text in both columns on one row, and an overhang from the first into the gutter
    const overhang = raster(
      [
        [0.12, 0.2, 0.5, 0.22],
        [0.52, 0.2, 0.9, 0.22],
        [0.5, 0.2, 0.53, 0.22],
      ],
      200,
      282
    )
    const found = columnOverflowFindings(overhang, {
      refs,
      bands,
      widthPt: A4.width,
    })
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      side: 'right',
      reference: 'column',
      column: 1,
    })
    expect(found[0].mm).toBeGreaterThan(MIN_OVERFLOW_MM_FOR_TEST)
    expect(found[0].top).toBe(20)
    const clean = raster(
      [
        [0.12, 0.2, 0.5, 0.22],
        [0.52, 0.2, 0.9, 0.22],
      ],
      200,
      282
    )
    expect(
      columnOverflowFindings(clean, { refs, bands, widthPt: A4.width })
    ).toEqual([])
  })

  it('skips a row that a gutter word shares, such as a page number', () => {
    const refs = [
      { left: 0.12, right: 0.5 },
      { left: 0.52, right: 0.9 },
    ]
    const bands = [[{ top: 0.2, bottom: 0.22 }], []]
    const footer = raster([[0.5, 0.2, 0.53, 0.22]], 200, 282)
    expect(
      columnOverflowFindings(footer, {
        refs,
        bands,
        widthPt: A4.width,
        gutterBands: [{ top: 0.19, bottom: 0.23 }],
      })
    ).toEqual([])
  })

  it('takes a column edge from its own lines, ignoring one line that overhangs', () => {
    const lines = Array.from({ length: 10 }, (_, i) => ({
      xMin: 72,
      xMax: i === 3 ? 420 : 300,
    }))
    const columns = [{ left: 72, right: 302 }]
    const [ref] = localColumnReferences(columns, lines, 595)
    expect(ref.right).toBeCloseTo(300 / 595, 4)
    expect(ref.left).toBeCloseTo(72 / 595, 4)
    expect(localColumnReferences(columns, lines.slice(0, 3), 595)).toEqual([
      null,
    ])
  })

  it('reads the render options, keeping the old output when none are given', () => {
    expect(renderOptions()).toEqual({
      grayscale: false,
      maxEdgePx: 2400,
      split: 'none',
      labels: false,
      defects: false,
    })
    expect(
      renderOptions({
        maxEdgePx: 10,
        split: 'halves',
        labels: true,
        grayscale: true,
        defects: true,
      })
    ).toEqual({
      grayscale: true,
      maxEdgePx: 300,
      split: 'halves',
      labels: true,
      defects: true,
    })
    expect(
      renderOptions({ maxEdgePx: 'big', split: 'sideways' })
    ).toMatchObject({
      maxEdgePx: 2400,
      split: 'none',
    })
  })
})

describe('createPdfPageInspector', () => {
  let getOutputFileStream
  let syncTeX
  let execFile
  let inspector
  let rendered

  beforeEach(() => {
    rendered = []
    getOutputFileStream = vi.fn(
      async (projectId, userId, server, build, path) =>
        Readable.from([
          Buffer.from(path === 'output.log' ? LOG : '%PDF-1.5 fake'),
        ])
    )
    syncTeX = vi.fn(
      async (projectId, userId, { direction, validatedOptions }) => {
        if (direction === 'code') {
          const { line } = validatedOptions
          // The bad boxes of the log, by the page SyncTeX puts their line on
          if (line === 40) {
            return { pdf: [{ page: 2, h: 72, v: 421, width: 300, height: 10 }] }
          }
          if (line === 90) {
            return { pdf: [{ page: 3, h: 72, v: 421, width: 300, height: 10 }] }
          }
          if (line >= 20) {
            return { pdf: [{ page: 4, h: 72, v: 120, width: 300, height: 10 }] }
          }
          return {
            pdf:
              line >= 12
                ? [{ page: 3, h: 72, v: 421, width: 300, height: 10 }]
                : [],
          }
        }
        return {
          code: [
            {
              file:
                validatedOptions.v < 421 ? 'main.tex' : 'chapters/intro.tex',
              line: validatedOptions.v < 421 ? 40 : 7,
              column: -1,
            },
          ],
        }
      }
    )
    execFile = vi.fn(async (command, args) => {
      if (command === 'pdfinfo') return { stdout: pdfInfo(args) }
      if (command === 'pdftoppm') rendered.push([command, ...args])
      if (command === 'pdffonts') return { stdout: PDF_FONTS }
      if (command === 'pdftotext') {
        await fs.writeFile(
          args.at(-1),
          bboxLayout(Number(args[4]), Math.min(Number(args[6]), 5))
        )
        return { stdout: '' }
      }
      const prefix = args.at(-1)
      const gray = args.includes('-gray')
      if (args.includes('-singlefile') && args.includes('-png')) {
        await fs.writeFile(`${prefix}.png`, pngHeader(1240, 1754))
        return { stdout: '' }
      }
      if (args.includes('-singlefile') && args.includes('-jpeg')) {
        await fs.writeFile(`${prefix}.jpg`, pngHeader(1240, 1754))
        return { stdout: '' }
      }
      const from = Number(args[args.indexOf('-f') + 1])
      const to = Number(args[args.indexOf('-l') + 1])
      if (args.includes('-singlefile')) {
        // A raster for the labelled picture, which is composed before encoding
        const raster = PAGE_RASTERS[from]
        await fs.writeFile(
          `${prefix}.${gray ? 'pgm' : 'ppm'}`,
          gray ? pgm(raster) : ppm(raster)
        )
        return { stdout: '' }
      }
      for (let page = from; page <= to; page++) {
        await fs.writeFile(
          `${prefix}-${page}.${gray ? 'pgm' : 'ppm'}`,
          gray ? pgm(PAGE_RASTERS[page]) : ppm(PAGE_RASTERS[page])
        )
      }
      return { stdout: '' }
    })
    inspector = createPdfPageInspector({
      getOutputFileStream,
      syncTeX,
      execFile,
      tmpDir: os.tmpdir(),
    })
  })

  const BUILD = {
    projectId: 'p1',
    userId: 'u1',
    buildId: '18f4c3a2b10-0123456789abcdef',
    clsiServerId: 'clsi-1',
  }

  const downloads = () =>
    getOutputFileStream.mock.calls.filter(call => call[4] === 'output.pdf')
      .length

  describe('inspect', () => {
    it('renders the page and maps its heights to source lines', async () => {
      const shown = await inspector.inspect({
        ...BUILD,
        page: 2,
        rootDocPath: 'main.tex',
      })

      expect(getOutputFileStream).toHaveBeenCalledWith(
        'p1',
        'u1',
        'clsi-1',
        BUILD.buildId,
        'output.pdf'
      )
      expect(rendered[0]).toEqual(
        expect.arrayContaining(['-png', '-r', '150', '-f', '2', '-l', '2'])
      )
      expect(shown).toMatchObject({
        page: 2,
        pageCount: 5,
        pageSize: { width: 595, height: 842 },
        region: 'full',
        span: { top: 0, bottom: 100 },
        located: null,
        focus: null,
        text: null,
        sourceMap: [
          { y: 36, path: 'main.tex', line: 40 },
          { y: 60, path: 'chapters/intro.tex', line: 7 },
        ],
        sourceRanges: [
          { path: 'main.tex', startLine: 40, endLine: 40 },
          { path: 'chapters/intro.tex', startLine: 7, endLine: 7 },
        ],
        image: {
          mediaType: 'image/png',
          dpi: 150,
          width: 1240,
          height: 1754,
          data: pngHeader(1240, 1754).toString('base64'),
        },
      })
      // one probe at the middle of each text line, both against this build
      expect(syncTeX).toHaveBeenCalledTimes(2)
      expect(syncTeX.mock.calls[0][2]).toEqual({
        direction: 'pdf',
        compileFromClsiCache: false,
        clsiServerId: 'clsi-1',
        validatedOptions: { page: 2, h: 168, v: 306, buildId: BUILD.buildId },
      })
      expect(shown.sourceStatus).toBe('mapped')
      // 40 was reported while page 2 was built; 7 on page 3, but SyncTeX puts
      // its line on this page. 90 is neither.
      expect(shown.badBoxes).toEqual([
        {
          path: 'main.tex',
          line: 40,
          message:
            'Overfull \\hbox (48.2pt too wide) in alignment at lines 40--52',
        },
        {
          path: 'chapters/intro.tex',
          line: 7,
          message:
            'Underfull \\hbox (badness 10000) in paragraph at lines 7--7',
        },
      ])
    })

    it('opens the page where a source line is typeset, trying the next lines', async () => {
      const shown = await inspector.inspect({
        ...BUILD,
        path: '/chapters/intro.tex',
        line: 10,
      })
      expect(
        syncTeX.mock.calls.slice(0, 3).map(call => call[2].validatedOptions)
      ).toEqual([
        {
          file: 'chapters/intro.tex',
          line: 10,
          column: 0,
          buildId: BUILD.buildId,
        },
        {
          file: 'chapters/intro.tex',
          line: 11,
          column: 0,
          buildId: BUILD.buildId,
        },
        {
          file: 'chapters/intro.tex',
          line: 12,
          column: 0,
          buildId: BUILD.buildId,
        },
      ])
      expect(shown.page).toBe(3)
      expect(shown.located).toEqual({
        path: 'chapters/intro.tex',
        line: 12,
        y: 50,
      })
    })

    it('says when a source line is typeset nowhere', async () => {
      const err = await inspector
        .inspect({ ...BUILD, path: 'main.tex', line: 2 })
        .catch(error => error)
      expect(err.code).toBe(PDF_PAGE_ERRORS.LINE_NOT_IN_PDF)
    })

    it('zooms on where a block of source lines is typeset', async () => {
      const shown = await inspector.inspect({
        ...BUILD,
        path: 'main.tex',
        line: 10,
        endLine: 14,
      })
      const asked = syncTeX.mock.calls
        .filter(call => call[2].direction === 'code')
        .map(call => call[2].validatedOptions.line)
      expect(asked).toEqual([10, 11, 12, 13, 14])
      expect(shown.page).toBe(3)
      expect(shown.region).toBe('focus')
      // One line at v 421 (411-421pt): padded, then widened to 15% of the page
      expect(shown.focus).toEqual({
        path: 'main.tex',
        line: 10,
        endLine: 14,
        top: 42,
        bottom: 57,
        continuesOn: [],
      })
      expect(shown.span).toEqual({ top: 42, bottom: 57 })
      expect(rendered[0]).toEqual(expect.arrayContaining(['-r', '290', '-y']))
      expect(shown.located).toMatchObject({ line: 12 })
    })

    it('says which later pages a block runs onto', async () => {
      const shown = await inspector.inspect({
        ...BUILD,
        path: 'main.tex',
        line: 12,
        endLine: 22,
      })
      expect(shown.page).toBe(3)
      expect(shown.focus.continuesOn).toEqual([4])
    })

    it('lets an explicit region win over a block', async () => {
      const shown = await inspector.inspect({
        ...BUILD,
        path: 'main.tex',
        line: 12,
        endLine: 22,
        region: 'top',
      })
      expect(shown.region).toBe('top')
      expect(shown.focus).toBeNull()
    })

    it('crops a zoomed region at twice the resolution', async () => {
      const shown = await inspector.inspect({
        ...BUILD,
        page: 2,
        region: 'bottom',
      })
      expect(rendered[0]).toEqual(
        expect.arrayContaining(['-r', '290', '-x', '0', '-W', '2398'])
      )
      expect(shown.span).toEqual({ top: 60, bottom: 100 })
      // The only text in the band is one line: the five probes land on it
      expect(syncTeX).toHaveBeenCalledTimes(1)
      expect(shown.sourceMap.every(row => row.y >= 60)).toBe(true)
    })

    it('reports the page count for a page past the end', async () => {
      const err = await inspector
        .inspect({ ...BUILD, page: 9 })
        .catch(error => error)
      expect(err).toBeInstanceOf(PdfPageError)
      expect(err.code).toBe(PDF_PAGE_ERRORS.PAGE_OUT_OF_RANGE)
      expect(err.details).toEqual({ pageCount: 5 })
      expect(rendered).toHaveLength(0)
    })

    it('says the build has no PDF when CLSI has none', async () => {
      getOutputFileStream.mockRejectedValueOnce(
        new Errors.OutputFileFetchFailedError('missing')
      )
      const err = await inspector
        .inspect({ ...BUILD, page: 1 })
        .catch(error => error)
      expect(err.code).toBe(PDF_PAGE_ERRORS.NO_PDF)
    })

    it('says rendering is unavailable when poppler is not installed', async () => {
      execFile.mockRejectedValueOnce(
        Object.assign(new Error('spawn'), { code: 'ENOENT' })
      )
      const err = await inspector
        .inspect({ ...BUILD, page: 1 })
        .catch(error => error)
      expect(err.code).toBe(PDF_PAGE_ERRORS.RENDERER_UNAVAILABLE)
    })

    it('falls back to JPEG when the PNG is too large to send', async () => {
      execFile.mockImplementation(async (command, args) => {
        if (command === 'pdfinfo') return { stdout: PDF_INFO }
        if (command === 'pdftotext') {
          await fs.writeFile(args.at(-1), bboxLayout(2, 2))
          return { stdout: '' }
        }
        rendered.push(args)
        const prefix = args.at(-1)
        const png = args.includes('-png')
        await fs.writeFile(
          `${prefix}.${png ? 'png' : 'jpg'}`,
          png ? Buffer.alloc(MAX_IMAGE_BYTES + 1) : pngHeader(10, 10)
        )
        return { stdout: '' }
      })
      const shown = await inspector.inspect({ ...BUILD, page: 2 })
      expect(shown.image.mediaType).toBe('image/jpeg')
      expect(rendered[1]).toEqual(expect.arrayContaining(['-jpeg']))
    })

    it('reads the page text instead of rendering for a model without images', async () => {
      const shown = await inspector.inspect({
        ...BUILD,
        page: 2,
        withImage: false,
      })
      expect(rendered.some(call => call[0] === 'pdftoppm')).toBe(false)
      expect(shown.image).toBeNull()
      expect(shown.pageCount).toBe(5)
      expect(shown.sourceMap.length).toBeGreaterThan(0)
      expect(shown.text.lines.map(row => row.text)).toEqual([
        'As shown in Figure ?? the',
        'results [?] hold.',
      ])
      expect(shown.text.lines[0].y).toBe(36)
    })

    it('renders a page of a build once', async () => {
      await inspector.inspect({ ...BUILD, page: 2 })
      await inspector.inspect({ ...BUILD, page: 2 })
      expect(rendered).toHaveLength(1)
    })
  })

  describe('overview', () => {
    it('shows the pages as thumbnails and measures each one', async () => {
      const shown = await inspector.overview({
        ...BUILD,
        fromPage: 1,
        toPage: 99,
        rootDocPath: 'main.tex',
      })
      expect(rendered.find(call => call[0] === 'pdftoppm')).toEqual(
        expect.arrayContaining(['-f', '1', '-l', '5'])
      )
      expect(shown).toMatchObject({
        fromPage: 1,
        toPage: 5,
        pageCount: 5,
        paper: { width: 595, height: 842, name: 'A4', orientation: 'portrait' },
        mixedSizes: false,
        fonts: { total: 3, notEmbedded: ['Arial'], type3: ['[none]'] },
        columns: 3,
      })
      expect(shown.image.mediaType).toBe('image/png')
      expect(shown.image.data.startsWith('iVBOR')).toBe(true)
      expect(shown.image.width).toBeGreaterThan(300)

      const [p1, p2, p3, p4, p5] = shown.pages
      expect(p1).toMatchObject({
        page: 1,
        blank: false,
        endsAt: null,
        gaps: [],
        overflow: [],
        badBoxes: 0,
      })
      expect(p1.source.map(range => range.path)).toContain('main.tex')
      expect(p2).toMatchObject({
        endsAt: 50,
        badBoxes: 1,
        worstBadBox: { path: 'main.tex', line: 40 },
        unresolved: { refs: 1, cites: 1 },
      })
      expect(p3.badBoxes).toBe(2)
      expect(p3.overflow).toHaveLength(1)
      expect(p3.overflow[0]).toMatchObject({
        side: 'right',
        reference: 'textBlock',
        top: 40,
        bottom: 45,
      })
      expect(p3.overflow[0].mm).toBeGreaterThan(20)
      expect(p4).toMatchObject({ blank: true, source: [], overflow: [] })
      // The last page may end anywhere, but an empty band is still news
      expect(p5).toMatchObject({
        endsAt: null,
        gaps: [{ top: 30, bottom: 55 }],
      })
    })

    it('shows at most twelve pages a call', async () => {
      const shown = await inspector.overview({
        ...BUILD,
        fromPage: 2,
        toPage: 3,
      })
      expect(shown.pages.map(page => page.page)).toEqual([2, 3])
      expect(shown.columns).toBe(2)
    })

    it('reports the page count when the first page is past the end', async () => {
      const err = await inspector
        .overview({ ...BUILD, fromPage: 9 })
        .catch(error => error)
      expect(err.code).toBe(PDF_PAGE_ERRORS.PAGE_OUT_OF_RANGE)
      expect(err.details).toEqual({ pageCount: 5 })
    })

    it('measures without an image for a model that cannot take one', async () => {
      const shown = await inspector.overview({ ...BUILD, withImage: false })
      expect(shown.image).toBeNull()
      expect(shown.pages[3].blank).toBe(true)
    })
  })

  describe('search', () => {
    it('finds text as it reads in the PDF and the source that typeset it', async () => {
      const found = await inspector.search({ ...BUILD, query: '??' })
      expect(found).toMatchObject({
        query: '??',
        fromPage: 1,
        toPage: 5,
        pageCount: 5,
        matchCount: 1,
        pages: [2],
      })
      expect(found).not.toHaveProperty('truncated')
      expect(found.matches).toEqual([
        {
          page: 2,
          y: 36,
          text: '??',
          context: expect.stringContaining('Figure ??'),
          path: 'main.tex',
          line: 40,
        },
      ])
      const probe = syncTeX.mock.calls.at(-1)[2]
      expect(probe.validatedOptions).toMatchObject({ page: 2, h: 209, v: 306 })
    })

    it('matches across a hyphenated line break, ignoring case', async () => {
      const found = await inspector.search({
        ...BUILD,
        query: 'EXPERIMENT works',
      })
      expect(found.pages).toEqual([3])
    })

    it('counts and locates every match, without a cap', async () => {
      const found = await inspector.search({ ...BUILD, query: 'e' })
      expect(found.matchCount).toBeGreaterThan(2)
      expect(found.matches).toHaveLength(found.matchCount)
    })

    it('searches only the pages asked for', async () => {
      const found = await inspector.search({
        ...BUILD,
        query: '??',
        fromPage: 3,
        toPage: 4,
      })
      expect(found).toMatchObject({ fromPage: 3, toPage: 4, matchCount: 0 })
    })

    it('refuses an empty query', async () => {
      const err = await inspector
        .search({ ...BUILD, query: '   ' })
        .catch(error => error)
      expect(err.code).toBe(PDF_PAGE_ERRORS.INVALID_QUERY)
    })
  })

  it('downloads the PDF of a build once for every view of it', async () => {
    await inspector.overview({ ...BUILD })
    await inspector.search({ ...BUILD, query: 'Figure' })
    await inspector.inspect({ ...BUILD, page: 3 })
    expect(downloads()).toBe(1)
    await inspector.inspect({ ...BUILD, buildId: 'aaaa-bbbb', page: 3 })
    expect(downloads()).toBe(2)
  })

  describe('options', () => {
    it('renders grey pictures with pdftoppm -gray, as a PNG', async () => {
      const shown = await inspector.inspect({
        ...BUILD,
        page: 2,
        grayscale: true,
      })
      expect(rendered[0]).toEqual(
        expect.arrayContaining(['-gray', '-png', '-r', '150'])
      )
      expect(shown.image.mediaType).toBe('image/png')
    })

    it('lowers the DPI to fit a smaller long-edge cap', async () => {
      await inspector.inspect({ ...BUILD, page: 2, maxEdgePx: 600 })
      // A4 is 842pt long: 600px is 51 DPI
      expect(rendered[0]).toEqual(expect.arrayContaining(['-r', '51']))
    })

    it('splits a page into two overlapping halves, each with its own picture', async () => {
      const shown = await inspector.inspect({
        ...BUILD,
        page: 2,
        split: 'halves',
      })
      expect(shown.images.map(image => [image.part, image.span])).toEqual([
        ['top', { top: 0, bottom: 53 }],
        ['bottom', { top: 48, bottom: 100 }],
      ])
      expect(shown.images[0]).toMatchObject({ mimeType: 'image/png', dpi: 150 })
      expect(shown.image.data).toBe(shown.images[0].data)
      expect(rendered.filter(call => call.includes('-y'))).toHaveLength(2)
      // the map is of the whole page, as without the split
      expect(shown.span).toEqual({ top: 0, bottom: 100 })
    })

    it('labels the text blocks in a margin, with their source, and resolves them', async () => {
      const shown = await inspector.inspect({ ...BUILD, page: 2, labels: true })
      expect(shown.blocks.map(block => block.id)).toEqual(['B1', 'B2'])
      expect(shown.blocks[0]).toMatchObject({
        id: 'B1',
        page: 2,
        path: 'main.tex',
        line: 40,
        bbox: { x: 100 },
      })
      expect(shown.blocks[1]).toMatchObject({
        id: 'B2',
        path: 'chapters/intro.tex',
        line: 7,
      })
      // the picture is drawn with a margin, so it is wider than the raster
      expect(shown.image.mediaType).toBe('image/png')
      expect(shown.image.width).toBeGreaterThan(100)
      expect(rendered[0]).toEqual(expect.arrayContaining(['-singlefile']))
      expect(rendered[0]).not.toContain('-png')
      expect(
        resolveBlock({
          projectId: BUILD.projectId,
          buildId: BUILD.buildId,
          page: 2,
          blockId: 'B2',
        })
      ).toEqual({ path: 'chapters/intro.tex', line: 7, endLine: 7 })
      // another project naming the same build sees nothing
      expect(
        resolveBlock({
          projectId: 'other-project',
          buildId: BUILD.buildId,
          page: 2,
          blockId: 'B2',
        })
      ).toBeNull()
    })

    it('labels each half of a split page', async () => {
      const shown = await inspector.inspect({
        ...BUILD,
        page: 2,
        labels: true,
        split: 'halves',
      })
      expect(shown.images).toHaveLength(2)
      expect(shown.images.every(image => image.width > 100)).toBe(true)
      expect(shown.blocks).toHaveLength(2)
    })

    it('leaves out blocks and defects unless asked for them', async () => {
      const shown = await inspector.inspect({ ...BUILD, page: 3 })
      expect(shown).not.toHaveProperty('blocks')
      expect(shown).not.toHaveProperty('defects')
      expect(shown).not.toHaveProperty('contentHash')
    })

    it('returns the defects of the page as records, with ids and banned fixes', async () => {
      const shown = await inspector.inspect({
        ...BUILD,
        page: 2,
        defects: true,
      })
      const categories = shown.defects.map(defect => defect.category)
      expect(categories).toEqual(
        expect.arrayContaining([
          'unresolved_ref',
          'unresolved_cite',
          'overfull_hbox',
        ])
      )
      expect(shown.defects[0].id).toBe('D1')
      const overfull = shown.defects.find(
        defect => defect.category === 'overfull_hbox'
      )
      expect(overfull).toMatchObject({
        page: 2,
        path: 'main.tex',
        line: 40,
        severity: 'error',
      })
      expect(overfull.bannedFixes).toContain('\\sloppy')
    })

    it('echoes the content hash the caller passes', async () => {
      expect(
        (await inspector.inspect({ ...BUILD, page: 2, contentHash: 'abc' }))
          .contentHash
      ).toBe('abc')
      expect(
        await inspector.search({ ...BUILD, query: '??', contentHash: 'def' })
      ).toMatchObject({ contentHash: 'def' })
    })
  })

  describe('source status', () => {
    it('says the build has no SyncTeX when its file is missing', async () => {
      const missing = createPdfPageInspector({
        getOutputFileStream,
        syncTeX: vi.fn(async () => {
          throw new Errors.NotFoundError('no synctex')
        }),
        execFile,
        tmpDir: os.tmpdir(),
      })
      const shown = await missing.inspect({ ...BUILD, page: 2 })
      expect(shown.sourceStatus).toBe('no_synctex')
      expect(shown.sourceMap).toEqual([])
      expect(shown.sourceNote).toMatch(/-synctex=1/)
      expect(shown.image).not.toBeNull()
    })

    it('says a source line cannot be found, not that the line is blank, without SyncTeX', async () => {
      const missing = createPdfPageInspector({
        getOutputFileStream,
        syncTeX: vi.fn(async () => {
          throw new Errors.NotFoundError('no synctex')
        }),
        execFile,
        tmpDir: os.tmpdir(),
      })
      const err = await missing
        .inspect({ ...BUILD, path: 'main.tex', line: 40 })
        .catch(error => error)
      expect(err.code).toBe(PDF_PAGE_ERRORS.SYNCTEX_UNAVAILABLE)
    })

    it('says a page with text had its probes miss, when SyncTeX answers nothing', async () => {
      syncTeX.mockImplementation(async () => ({ code: [] }))
      const shown = await inspector.inspect({ ...BUILD, page: 2 })
      expect(shown.sourceStatus).toBe('probe_missed')
      expect(shown.sourceMap).toEqual([])
    })

    it('says a page with no text has nothing to map, not that its probes missed', async () => {
      syncTeX.mockImplementation(async () => ({ code: [] }))
      const shown = await inspector.inspect({ ...BUILD, page: 4 })
      expect(shown.sourceStatus).toBe('page_without_source')
      expect(shown.sourceNote).toMatch(/nothing to map/)
    })

    it('reports the status of each overview page', async () => {
      syncTeX.mockImplementation(async () => ({ code: [] }))
      const shown = await inspector.overview({ ...BUILD })
      // pages 4 and 5 have no text: nothing to map
      expect(shown.pages.map(page => page.sourceStatus)).toEqual([
        'probe_missed',
        'probe_missed',
        'probe_missed',
        'page_without_source',
        'page_without_source',
      ])
    })
  })

  describe('source map on a two-column page', () => {
    it('probes each column where its text is, not the gutter between them', async () => {
      const base = execFile.getMockImplementation()
      const twoColumn = [0, 1, 2, 3, 4, 5].map(
        i =>
          `<line xMin="0" yMin="0" xMax="0" yMax="0">` +
          word(72, 290, 100 + i * 14, 'left column text here') +
          word(310, 530, 100 + i * 14, 'right column text here') +
          `</line>`
      )
      execFile.mockImplementation(async (command, args) => {
        if (command !== 'pdftotext') return base(command, args)
        const page = `<page width="595.276" height="841.89"><flow>${block(twoColumn)}</flow></page>`
        await fs.writeFile(
          args.at(-1),
          `<html><body><doc>${page}</doc></body></html>`
        )
        return { stdout: '' }
      })
      const shown = await inspector.inspect({
        ...BUILD,
        page: 2,
        withImage: false,
      })
      const probed = syncTeX.mock.calls.map(call => call[2].validatedOptions.h)
      expect(probed.some(h => h > 300)).toBe(true)
      expect(probed.some(h => h < 300)).toBe(true)
      expect(shown.sourceStatus).toBe('mapped')
    })
  })

  describe('caching and limits', () => {
    it('keeps the SyncTeX answers of a build, so a second look asks nothing new', async () => {
      await inspector.inspect({ ...BUILD, page: 2 })
      const asked = syncTeX.mock.calls.length
      await inspector.inspect({ ...BUILD, page: 2, withImage: false })
      expect(syncTeX.mock.calls.length).toBe(asked)
    })

    it('reads the log of a build once for all its views', async () => {
      await inspector.overview({ ...BUILD })
      await inspector.inspect({ ...BUILD, page: 2 })
      const logs = getOutputFileStream.mock.calls.filter(
        call => call[4] === 'output.log'
      )
      expect(logs).toHaveLength(1)
    })

    it('asks SyncTeX about at most four points at once', async () => {
      let active = 0
      let peak = 0
      const inner = syncTeX.getMockImplementation()
      const slow = vi.fn(async (...args) => {
        active++
        peak = Math.max(peak, active)
        await new Promise(resolve => setTimeout(resolve, 5))
        active--
        return inner(...args)
      })
      const busy = createPdfPageInspector({
        getOutputFileStream,
        syncTeX: slow,
        execFile,
        tmpDir: os.tmpdir(),
      })
      await busy.overview({ ...BUILD })
      expect(slow.mock.calls.length).toBeGreaterThan(4)
      expect(peak).toBeLessThanOrEqual(4)
      expect(peak).toBeGreaterThan(1)
    })

    it('gives the defect records of an overview, with the font problems and no page for them', async () => {
      const shown = await inspector.overview({ ...BUILD, defects: true })
      const fonts = shown.defects.filter(defect => defect.category === 'font')
      expect(fonts.map(defect => defect.evidence).join(' ')).toMatch(
        /Arial[\s\S]*not embedded/
      )
      expect(fonts.every(defect => defect.page === null)).toBe(true)
      expect(shown.defects.map(defect => defect.id)[0]).toBe('D1')
      expect((await inspector.overview({ ...BUILD })).defects).toBeUndefined()
    })
  })

  describe('limits', () => {
    it('lays out at most maxOverviewPages pages and says where it stopped', async () => {
      const capped = createPdfPageInspector({
        getOutputFileStream,
        syncTeX,
        execFile,
        tmpDir: os.tmpdir(),
        maxOverviewPages: 2,
      })
      const shown = await capped.overview({ ...BUILD, withImage: false })
      expect(shown).toMatchObject({ fromPage: 1, toPage: 2, pageCount: 5 })
      expect(shown.pages.map(entry => entry.page)).toEqual([1, 2])
    })

    it('locates only the first matches, and still counts every one', async () => {
      const capped = createPdfPageInspector({
        getOutputFileStream,
        syncTeX,
        execFile,
        tmpDir: os.tmpdir(),
        maxLocatedMatches: 1,
      })
      const found = await capped.search({ ...BUILD, query: 'e' })
      expect(found.matchCount).toBeGreaterThan(1)
      expect(found.matches).toHaveLength(1)
      expect(found.truncated).toBe(true)
    })

    it('caps the long edge at MAX_EDGE_PX_LIMIT whatever the caller asks', () => {
      expect(renderOptions({ maxEdgePx: 1e6 }).maxEdgePx).toBe(
        MAX_EDGE_PX_LIMIT
      )
    })

    it('keeps a very large page within the edge cap rather than a DPI floor', () => {
      const poster = { width: 14400, height: 14400 }
      const plan = renderPlan(poster, 'full', 150, 2400)
      expect(Math.ceil((poster.width * plan.dpi) / 72)).toBeLessThanOrEqual(
        2400
      )
    })
  })
})
