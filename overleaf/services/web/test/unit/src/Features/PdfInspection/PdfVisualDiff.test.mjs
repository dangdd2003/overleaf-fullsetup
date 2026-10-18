import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import Path from 'node:path'
import { Readable } from 'node:stream'
import Errors from '../../../../../app/src/Features/Errors/Errors.js'
vi.mock('../../../../../app/src/Features/Compile/ClsiManager.mjs', () => ({
  default: { promises: { getOutputFileStream: vi.fn() } },
}))

const {
  createPdfVisualDiff,
  diffRasters,
  pairPagesByText,
  VISUAL_DIFF_ERRORS,
} = await import('../../../../../app/src/Features/PdfInspection/PdfVisualDiff.mjs')

const DPI = 100

function hasBinary(name) {
  try {
    execFileSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const HAS_POPPLER = hasBinary('pdftoppm') && hasBinary('pdfinfo')
const HAS_LATEX = hasBinary('pdflatex') && HAS_POPPLER

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// A page of white paper, one byte per pixel.
function paper(width = 400, height = 600) {
  return {
    width,
    height,
    channels: 1,
    data: Buffer.alloc(width * height, 255),
  }
}

function fill(page, x, y, w, h, value = 0) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      if (xx < 0 || yy < 0 || xx >= page.width || yy >= page.height) continue
      page.data[yy * page.width + xx] = value
    }
  }
}

// A line of "text": short dark runs of pseudo-random length, seeded by `seed`.
function textLine(page, y, seed) {
  const rand = mulberry32(seed)
  let x = 40
  while (x < page.width - 40) {
    const w = 3 + Math.floor(rand() * 14)
    const gap = 2 + Math.floor(rand() * 6)
    fill(page, x, y, Math.min(w, page.width - 40 - x), 6, 40)
    x += w + gap
  }
}

// A body of text lines, one every 12 px from `top`.
function body(page, top, count, seed) {
  for (let k = 0; k < count; k++) textLine(page, top + k * 12, seed * 1000 + k)
}

function clone(page) {
  return { ...page, data: Buffer.from(page.data) }
}

describe('diffRasters', () => {
  it('reports an identical page as unchanged', () => {
    const a = paper()
    body(a, 40, 20, 1)
    const result = diffRasters(a, clone(a), { dpi: DPI })
    expect(result).toMatchObject({
      changed: false,
      regions: [],
      shiftedBelow: null,
      removed: [],
    })
  })

  it('ignores anti-aliasing noise', () => {
    const a = paper()
    body(a, 40, 20, 2)
    const b = clone(a)
    const rand = mulberry32(9)
    for (let p = 0; p < b.data.length; p++) {
      const v = b.data[p] + Math.floor((rand() - 0.5) * 40)
      b.data[p] = Math.max(0, Math.min(255, v))
    }
    expect(diffRasters(a, b, { dpi: DPI }).changed).toBe(false)
  })

  it('ignores isolated speckle that is not a changed area', () => {
    const a = paper()
    body(a, 40, 20, 3)
    const b = clone(a)
    for (const [x, y] of [
      [50, 300],
      [120, 310],
      [200, 330],
      [260, 340],
      [330, 360],
    ]) {
      b.data[y * b.width + x] = 0
    }
    expect(diffRasters(a, b, { dpi: DPI }).regions).toEqual([])
  })

  it('boxes a word changed inside a line that did not move', () => {
    const a = paper()
    body(a, 40, 20, 4)
    const b = clone(a)
    fill(b, 150, 40 + 5 * 12, 30, 6, 0)
    const result = diffRasters(a, b, { dpi: DPI })
    expect(result.changed).toBe(true)
    expect(result.shiftedBelow).toBeNull()
    expect(result.regions).toHaveLength(1)
    const [region] = result.regions
    expect(region.kind).toBe('changed')
    // the fill covers x 150..180; the first pixel that changed is at 152
    expect(region.x * 400).toBeLessThanOrEqual(160)
    expect((region.x + region.w) * 400).toBeGreaterThanOrEqual(175)
    expect(region.y * 600).toBeLessThanOrEqual(101)
    expect((region.y + region.h) * 600).toBeGreaterThanOrEqual(105)
    expect(result.changedFraction).toBeGreaterThan(0)
  })

  it('reports a paragraph inserted above as content shifted, not as a box over the rest', () => {
    const a = paper()
    body(a, 40, 30, 5)
    fill(a, 40, 580, 200, 6, 40)
    const b = paper()
    body(b, 40, 6, 5)
    // three new lines, then the old lines 6.. continue 36 px lower
    body(b, 40 + 6 * 12, 3, 77)
    for (let k = 6; k < 30; k++) textLine(b, 40 + (k + 3) * 12, 5 * 1000 + k)
    fill(b, 40, 580, 200, 6, 40)

    const result = diffRasters(a, b, { dpi: DPI })
    expect(result.changed).toBe(true)
    expect(result.shiftedBelow).toMatchObject({
      shiftPx: 36,
      shiftPt: 25.92,
    })
    expect(result.regions.length).toBeGreaterThan(0)
    for (const region of result.regions) {
      expect(region.kind).toBe('changed')
      // the inserted lines sit between 112 px and 148 px; nothing past 170 px
      expect((region.y + region.h) * 600).toBeLessThanOrEqual(170)
    }
  })

  it('boxes a moved figure at its new place, not the text it moved past', () => {
    const a = paper()
    body(a, 40, 10, 6) // 40..160
    fill(a, 40, 220, 300, 80, 90) // figure at 220..300
    body(a, 340, 8, 7) // 340..424
    fill(a, 40, 560, 200, 6, 40) // footer
    const b = paper()
    body(b, 40, 10, 6)
    body(b, 340, 8, 7)
    fill(b, 40, 470, 300, 80, 90) // figure moved down to 470..550
    fill(b, 40, 560, 200, 6, 40)

    const result = diffRasters(a, b, { dpi: DPI })
    expect(result.changed).toBe(true)
    const figure = result.regions.find(region => region.y * 600 > 440)
    expect(figure).toBeDefined()
    expect(figure.y * 600).toBeGreaterThanOrEqual(465)
    expect((figure.y + figure.h) * 600).toBeLessThanOrEqual(560)
    expect(result.removed.length).toBeGreaterThan(0)
  })

  it('reports a page whose size changed as a whole-page change', () => {
    const result = diffRasters(paper(400, 600), paper(400, 700), { dpi: DPI })
    expect(result).toMatchObject({
      changed: true,
      reason: 'size_changed',
      regions: [{ x: 0, y: 0, w: 1, h: 1, kind: 'changed' }],
    })
  })

  it('reports every region of a page, past eight, and covers each change', () => {
    const a = paper()
    const b = clone(a)
    for (let k = 0; k < 12; k++) {
      fill(b, 40 + (k % 3) * 110, 40 + k * 40 + 4, 20, 6, 0)
    }
    const result = diffRasters(a, b, { dpi: DPI })
    expect(result.regions.length).toBeGreaterThan(8)
    for (let k = 0; k < 12; k++) {
      const px = 40 + (k % 3) * 110 + 10
      const py = 40 + k * 40 + 7
      const covered = result.regions.some(
        r =>
          r.x * 400 <= px &&
          (r.x + r.w) * 400 >= px &&
          r.y * 600 <= py &&
          (r.y + r.h) * 600 >= py
      )
      expect(covered).toBe(true)
    }
  })

  it('reports a removed block as a seam without boxing the text above it', () => {
    const a = paper()
    body(a, 40, 10, 9)
    fill(a, 40, 200, 300, 60, 90)
    body(a, 300, 10, 10)
    const b = paper()
    body(b, 40, 10, 9)
    body(b, 300, 10, 10)
    const result = diffRasters(a, b, { dpi: DPI })
    expect(result.changed).toBe(true)
    expect(result.removed.length).toBeGreaterThan(0)
  })

  it('rejects something that is not a raster', () => {
    expect(() => diffRasters({}, paper(), {})).toThrow(TypeError)
  })
})

describe('pairPagesByText', () => {
  it('pairs pages of equal text in order and leaves an inserted page unpaired', () => {
    const before = [
      'introduction to the problem and its context',
      'methods used for the experiment and analysis',
      'results of the experiment with tables',
    ]
    const after = [
      'introduction to the problem and its context',
      'a brand new section about related work',
      'methods used for the experiment and analysis',
      'results of the experiment with tables',
    ]
    expect(pairPagesByText(before, after)).toEqual([
      { before: 0, after: 0 },
      { before: null, after: 1 },
      { before: 1, after: 2 },
      { before: 2, after: 3 },
    ])
  })
})

describe('createPdfVisualDiff with real PDFs', () => {
  const dirs = []
  let tmp

  beforeAll(async () => {
    tmp = await fsPromises.mkdtemp(Path.join(os.tmpdir(), 'visual-diff-test-'))
    dirs.push(tmp)
  })

  afterAll(async () => {
    for (const dir of dirs) {
      await fsPromises.rm(dir, { recursive: true, force: true })
    }
  })

  // Writes a PDF with one content stream per page. Rectangles are given in
  // points from the top left of the page.
  function makePdf(pages, { width = 300, height = 400 } = {}) {
    const objects = []
    objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
    const ids = pages.map((_, k) => 3 + 2 * k)
    objects[2] = `<< /Type /Pages /Kids [${ids
      .map(id => `${id} 0 R`)
      .join(' ')}] /Count ${pages.length} >>`
    pages.forEach((rects, k) => {
      const pid = 3 + 2 * k
      const cid = 4 + 2 * k
      const content = rects
        .map(([x, top, w, h]) => `${x} ${height - top - h} ${w} ${h} re f`)
        .join('\n')
      objects[pid] =
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents ${cid} 0 R >>`
      objects[cid] =
        `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`
    })
    let out = '%PDF-1.4\n'
    const offsets = []
    for (let id = 1; id < objects.length; id++) {
      offsets[id] = Buffer.byteLength(out)
      out += `${id} 0 obj\n${objects[id]}\nendobj\n`
    }
    const xref = Buffer.byteLength(out)
    out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`
    for (let id = 1; id < objects.length; id++) {
      out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
    }
    out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    return Buffer.from(out, 'latin1')
  }

  // Builds served from a map of buildId -> file path; any other build is gone.
  function fakeClsi(files) {
    return vi.fn(async (projectId, userId, clsiServerId, buildId, file) => {
      const path = files[buildId]
      if (!path) {
        throw new Errors.OutputFileFetchFailedError('gone', { status: 404 })
      }
      expect(file).toBe('output.pdf')
      return Readable.from([fs.readFileSync(path)])
    })
  }

  const PROJECT = '64b000000000000000000001'
  const USER = '64b000000000000000000002'

  it.skipIf(!HAS_POPPLER)(
    'reports a page edit, then fails with previous_build_gone once the earlier build is dropped',
    async () => {
      const oldPdf = Path.join(tmp, 'old.pdf')
      const newPdf = Path.join(tmp, 'new.pdf')
      fs.writeFileSync(
        oldPdf,
        makePdf([
          [
            [40, 40, 200, 10],
            [40, 80, 220, 10],
            [40, 200, 100, 60],
          ],
        ])
      )
      fs.writeFileSync(
        newPdf,
        makePdf([
          [
            [40, 40, 200, 10],
            [40, 80, 220, 10],
            [40, 200, 100, 60],
            [40, 300, 80, 10],
          ],
        ])
      )
      const getOutputFileStream = fakeClsi({
        'aaaa-0001': oldPdf,
        'aaaa-0002': newPdf,
      })
      const diff = createPdfVisualDiff({ getOutputFileStream, tmpDir: tmp })

      const result = await diff.diffBuilds({
        projectId: PROJECT,
        userId: USER,
        beforeBuildId: 'aaaa-0001',
        afterBuildId: 'aaaa-0002',
      })
      expect(result.ok).toBe(true)
      expect(result.pairing).toBe('index')
      expect(result.pageCount).toEqual({ before: 1, after: 1 })
      expect(result.changed).toBe(true)
      expect(result.pages).toHaveLength(1)
      expect(result.pages[0].page).toBe(1)
      expect(result.highlights[0]).toMatchObject({ page: 1, kind: 'changed' })
      expect(result.image.mimeType).toBe('image/png')
      expect(result.image.pages).toEqual([1])

      const gone = await diff.diffBuilds({
        projectId: PROJECT,
        userId: USER,
        beforeBuildId: 'aaaa-9999',
        afterBuildId: 'aaaa-0002',
      })
      expect(gone).toMatchObject({
        ok: false,
        reason: VISUAL_DIFF_ERRORS.PREVIOUS_BUILD_GONE,
      })
    }
  )

  it.skipIf(!HAS_POPPLER)(
    'compares against a remembered build after the compile server dropped it',
    async () => {
      const oldPdf = Path.join(tmp, 'remember-old.pdf')
      const newPdf = Path.join(tmp, 'remember-new.pdf')
      fs.writeFileSync(
        oldPdf,
        makePdf([[[40, 40, 200, 10]], [[40, 40, 100, 10]]])
      )
      fs.writeFileSync(
        newPdf,
        makePdf([
          [[40, 40, 200, 10]],
          [
            [40, 40, 100, 10],
            [40, 90, 100, 10],
          ],
        ])
      )
      // The compile server drops the old build once it has moved on.
      const files = { 'bbbb-0001': oldPdf, 'bbbb-0002': newPdf }
      const getOutputFileStream = fakeClsi(files)
      const diff = createPdfVisualDiff({ getOutputFileStream, tmpDir: tmp })

      const remembered = await diff.rememberBuildPages({
        projectId: PROJECT,
        userId: USER,
        buildId: 'bbbb-0001',
      })
      expect(remembered).toMatchObject({ ok: true })
      expect(remembered.bytes).toBeGreaterThan(0)
      delete files['bbbb-0001']

      const result = await diff.diffBuilds({
        projectId: PROJECT,
        userId: USER,
        beforeBuildId: 'bbbb-0001',
        afterBuildId: 'bbbb-0002',
      })
      expect(result.ok).toBe(true)
      expect(result.pageCount).toEqual({ before: 2, after: 2 })
      expect(result.pages.map(page => page.page)).toEqual([2])
      expect(result.pages[0].regions.length).toBeGreaterThan(0)
    }
  )

  it.skipIf(!HAS_POPPLER)(
    'keeps remembered builds within a byte budget, dropping the least recently used',
    async () => {
      const first = Path.join(tmp, 'lru-first.pdf')
      const second = Path.join(tmp, 'lru-second.pdf')
      fs.writeFileSync(first, makePdf([[[40, 40, 200, 10]]]))
      fs.writeFileSync(second, makePdf([[[60, 90, 120, 30]]]))
      const getOutputFileStream = fakeClsi({
        'dddd-0001': first,
        'dddd-0002': second,
      })
      const remember = diff => buildId =>
        diff.rememberBuildPages({ projectId: PROJECT, userId: USER, buildId })

      const tiny = createPdfVisualDiff({
        getOutputFileStream,
        tmpDir: tmp,
        maxRememberedBytes: 1,
      })
      expect(await remember(tiny)('dddd-0001')).toMatchObject({
        ok: false,
        reason: 'too_large',
      })

      const sized = await remember(
        createPdfVisualDiff({ getOutputFileStream, tmpDir: tmp })
      )('dddd-0001')
      const budget = createPdfVisualDiff({
        getOutputFileStream,
        tmpDir: tmp,
        maxRememberedBytes: sized.bytes + 16,
      })
      await remember(budget)('dddd-0001')
      await remember(budget)('dddd-0002')
      // The second build does not fit beside the first, so the first goes.
      expect(budget.rememberedBuildCount()).toBe(1)
    }
  )

  it.skipIf(!HAS_POPPLER)(
    'pairs pages by text when a page was added',
    async () => {
      const oldPdf = Path.join(tmp, 'count-old.pdf')
      const newPdf = Path.join(tmp, 'count-new.pdf')
      fs.writeFileSync(
        oldPdf,
        makePdf([[[40, 40, 200, 10]], [[40, 200, 60, 60]]])
      )
      fs.writeFileSync(
        newPdf,
        makePdf([[[40, 40, 200, 10]], [[40, 40, 90, 90]], [[40, 200, 60, 60]]])
      )
      const diff = createPdfVisualDiff({
        getOutputFileStream: fakeClsi({
          'cccc-0001': oldPdf,
          'cccc-0002': newPdf,
        }),
        tmpDir: tmp,
      })
      const result = await diff.diffBuilds({
        projectId: PROJECT,
        userId: USER,
        beforeBuildId: 'cccc-0001',
        afterBuildId: 'cccc-0002',
      })
      expect(result.ok).toBe(true)
      expect(result.pageCount).toEqual({ before: 2, after: 3 })
      expect(result.pairing).toBe('text')
    }
  )

  describe.skipIf(!HAS_LATEX)('real pdflatex builds', () => {
    const DOC = (body, extra = '') => `\\documentclass{article}
\\pagestyle{empty}
${extra}
\\begin{document}
${body}
\\end{document}
`
    const PARA = Array.from(
      { length: 6 },
      (_, k) => `Line ${k} of the body text with some words to fill it out.`
    )

    function compile(name, source) {
      const dir = Path.join(tmp, name)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(Path.join(dir, 'main.tex'), source)
      execFileSync(
        'pdflatex',
        ['-interaction=nonstopmode', '-halt-on-error', 'main.tex'],
        { cwd: dir, stdio: 'ignore' }
      )
      return Path.join(dir, 'main.pdf')
    }

    async function diffPdfs(oldPdf, newPdf, tag) {
      const getOutputFileStream = fakeClsi({
        [`${tag}-0001`]: oldPdf,
        [`${tag}-0002`]: newPdf,
      })
      const diff = createPdfVisualDiff({ getOutputFileStream, tmpDir: tmp })
      return diff.diffBuilds({
        projectId: PROJECT,
        userId: USER,
        beforeBuildId: `${tag}-0001`,
        afterBuildId: `${tag}-0002`,
      })
    }

    it('boxes a paragraph that changed and leaves the rest of the page alone', async () => {
      const oldPdf = compile('para-old', DOC(PARA.join('\n\n')))
      const newPdf = compile(
        'para-new',
        DOC(
          PARA.map((line, k) =>
            k === 2
              ? 'A completely rewritten paragraph that now runs to two lines of text and says something new.'
              : line
          ).join('\n\n')
        )
      )
      const result = await diffPdfs(oldPdf, newPdf, 'eeee')
      expect(result.ok).toBe(true)
      expect(result.pairing).toBe('index')
      expect(result.pages).toHaveLength(1)
      expect(result.pages[0].regions.length).toBeGreaterThan(0)
      // Lines below the rewrite moved down a line: reported as a shift, not boxed.
      expect(result.pages[0].shiftedBelow).not.toBeNull()
      expect(result.pages[0].shiftedBelow.shiftPt).toBeGreaterThan(0)
      expect(result.image.data.length).toBeGreaterThan(100)
    }, 60_000)

    it('boxes a figure that moved and reports the text it moved past as shifted', async () => {
      const figureFirst = DOC(
        `Intro text before the figure.\n\n\\rule{4cm}{3cm}\n\n${PARA.join('\n\n')}`
      )
      const figureLast = DOC(
        `Intro text before the figure.\n\n${PARA.join('\n\n')}\n\n\\rule{4cm}{3cm}`
      )
      const oldPdf = compile('fig-old', figureFirst)
      const newPdf = compile('fig-new', figureLast)
      const result = await diffPdfs(oldPdf, newPdf, 'ffff')
      expect(result.ok).toBe(true)
      expect(result.pages).toHaveLength(1)
      const page = result.pages[0]
      // The text moved up into the old figure's place: reported as shifted,
      // not boxed. The figure's new place (below the text) is boxed, and its
      // old place is a removal.
      expect(page.shiftedBelow).not.toBeNull()
      expect(page.shiftedBelow.shiftPt).toBeLessThan(0)
      expect(page.regions.some(region => region.y > 0.2)).toBe(true)
      expect(page.removed.length).toBeGreaterThan(0)
    }, 60_000)

    it('reports an added page, paired by its text', async () => {
      const oldPdf = compile('page-old', DOC(PARA.join('\n\n')))
      const newPdf = compile(
        'page-new',
        DOC(
          `${PARA.join('\n\n')}\n\\newpage\nA whole new page of text that the old build did not have.`
        )
      )
      const result = await diffPdfs(oldPdf, newPdf, 'abcd')
      expect(result.ok).toBe(true)
      expect(result.pageCount).toEqual({ before: 1, after: 2 })
      expect(result.pairing).toBe('text')
      expect(result.pages.find(page => page.status === 'added')).toMatchObject({
        page: 2,
      })
    }, 60_000)
  })
})

// These run without poppler: execFile stands in for pdfinfo and pdftoppm, and
// pdftoppm writes a white grey raster for each page it is asked for.
describe('createPdfVisualDiff limits', () => {
  function fakePoppler({ pages, sizes = {} }) {
    const calls = []
    const execFile = vi.fn(async (command, args) => {
      calls.push([command, ...args])
      if (command === 'pdfinfo') {
        const lines = [`Pages:           ${pages}`]
        if (args[0] === '-f') {
          const from = Number(args[1])
          const to = Number(args[3])
          for (let page = from; page <= to; page++) {
            const [w, h] = sizes[page] ?? [612, 792]
            lines.push(`Page ${String(page).padStart(4)} size: ${w} x ${h} pts`)
          }
        }
        return { stdout: lines.join('\n') }
      }
      if (command === 'pdftoppm') {
        const prefix = args.at(-1)
        const from = Number(args[args.indexOf('-f') + 1])
        const to = Number(args[args.indexOf('-l') + 1])
        for (let page = from; page <= to; page++) {
          await fsPromises.writeFile(
            `${prefix}-${page}.pgm`,
            Buffer.concat([
              Buffer.from('P5\n8 8\n255\n'),
              Buffer.alloc(64, 255),
            ])
          )
        }
      }
      return { stdout: '' }
    })
    return { calls, execFile }
  }

  const getOutputFileStream = vi.fn(async () =>
    Readable.from([Buffer.from('%PDF-1.5 fake')])
  )
  const BUILDS = {
    projectId: 'p1',
    userId: 'u1',
    beforeBuildId: '18f4c3a2b10-0123456789abcdef',
    afterBuildId: '18f4c3a2b11-0123456789abcdef',
  }

  it('refuses a page too large to rasterise, before pdftoppm runs', async () => {
    const { calls, execFile } = fakePoppler({
      pages: 1,
      sizes: { 1: [14400, 14400] },
    })
    const diff = createPdfVisualDiff({
      getOutputFileStream,
      execFile,
      tmpDir: os.tmpdir(),
    })
    const result = await diff.diffBuilds(BUILDS)
    expect(result).toMatchObject({
      ok: false,
      reason: VISUAL_DIFF_ERRORS.TOO_LARGE,
    })
    expect(calls.some(([command]) => command === 'pdftoppm')).toBe(false)
  })

  it('refuses a diff of more pages than it compares at once', async () => {
    const { execFile } = fakePoppler({ pages: 41 })
    const diff = createPdfVisualDiff({
      getOutputFileStream,
      execFile,
      tmpDir: os.tmpdir(),
    })
    const result = await diff.diffBuilds(BUILDS)
    expect(result).toMatchObject({
      ok: false,
      reason: VISUAL_DIFF_ERRORS.TOO_MANY_PAGES,
    })
  })

  it('renders one run per stretch of the pages asked for, not the span between them', async () => {
    const { calls, execFile } = fakePoppler({ pages: 4 })
    const diff = createPdfVisualDiff({
      getOutputFileStream,
      execFile,
      tmpDir: os.tmpdir(),
    })
    const result = await diff.diffBuilds({ ...BUILDS, pages: [1, 3] })
    expect(result.ok).toBe(true)
    const ranges = calls
      .filter(([command]) => command === 'pdftoppm')
      .map(args => [args[args.indexOf('-f') + 1], args[args.indexOf('-l') + 1]])
    // two builds, and each renders pages 1 and 3 as two runs of one page
    expect(ranges).toHaveLength(4)
    expect(ranges.every(([first, last]) => first === last)).toBe(true)
  })
})
