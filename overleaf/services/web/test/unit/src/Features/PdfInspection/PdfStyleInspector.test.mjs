import { describe, it, expect, vi } from 'vitest'
import {
  classifyFont,
  parseLength,
  parsePreamble,
  parseLog,
  walkOps,
  buildLines,
  findColumns,
  summarizePages,
  linkValues,
  buildOutput,
  compareStyles,
  extractStyle,
  extractStyleFromPages,
  createPdfStyleInspector,
  PdfStyleError,
  PDF_STYLE_ERRORS,
  MAX_STYLE_PAGES,
  samplePageNumbers,
} from '../../../../../app/src/Features/PdfInspection/PdfStyleInspector.mjs'
import Errors from '../../../../../app/src/Features/Errors/Errors.js'
import { Readable } from 'node:stream'
import { makePdf } from './helpers/makePdf.mjs'

describe('PdfStyleInspector', () => {
  describe('classifyFont', () => {
    it('strips subset prefix and classifies Computer Modern Roman', () => {
      const f = classifyFont('ABCDEF+CMR10')
      expect(f).toMatchObject({
        name: 'CMR10',
        family: 'CM',
        bold: false,
        italic: false,
        mono: false,
        math: false,
      })
    })

    it('classifies Computer Modern Bold Extended', () => {
      const f = classifyFont('CMBX12')
      expect(f).toMatchObject({
        family: 'CM',
        bold: true,
      })
    })

    it('classifies Computer Modern Math', () => {
      const f = classifyFont('CMMI10')
      expect(f).toMatchObject({
        family: 'CM',
        math: true,
      })
    })

    it('classifies Latin Modern and Times fonts', () => {
      expect(classifyFont('LMRoman10-Regular').family).toBe('LM')
      expect(classifyFont('NimbusRomNo9L-Regu').family).toBe('Times')
      expect(classifyFont('TimesNewRomanPS-BoldMT')).toMatchObject({
        family: 'Times',
        bold: true,
      })
    })

    it('classifies Helvetica and Monospace', () => {
      expect(classifyFont('Helvetica-Bold')).toMatchObject({
        family: 'Helvetica',
        bold: true,
      })
      expect(classifyFont('Courier')).toMatchObject({
        family: 'Mono',
        mono: true,
      })
      expect(classifyFont('CMTT10')).toMatchObject({
        family: 'CM-Mono',
        mono: true,
      })
    })
  })

  describe('parseLength', () => {
    it('parses pt, bp, in, mm, cm lengths to pt', () => {
      expect(parseLength('10pt')).toBe(10)
      expect(parseLength('72bp')).toBeCloseTo(72.27, 2)
      expect(parseLength('1in')).toBeCloseTo(72.27, 2)
      expect(parseLength('25.4mm')).toBeCloseTo(72.27, 2)
      expect(parseLength('2.54cm')).toBeCloseTo(72.27, 2)
      expect(parseLength('1pc')).toBe(12)
    })

    it('returns null for font-relative units or invalid strings', () => {
      expect(parseLength('1.5em')).toBeNull()
      expect(parseLength('2ex')).toBeNull()
      expect(parseLength('not-a-length')).toBeNull()
      expect(parseLength(null)).toBeNull()
    })
  })

  describe('parsePreamble', () => {
    it('extracts documentclass, options, and packages', () => {
      const preamble = `
\\documentclass[11pt,twocolumn]{article}
% a comment line
\\usepackage[margin=1in]{geometry}
\\usepackage{times}
\\usepackage{parskip}
\\linespread{1.2}
\\setlength{\\parindent}{15pt}
\\renewcommand{\\headrulewidth}{0.4pt}
\\titleformat{\\section}{\\large\\bfseries}{\\thesection}{1em}{}
\\definecolor{myblue}{rgb}{0,0,1}
`
      const p = parsePreamble(preamble)
      expect(p.documentClass).toMatchObject({
        name: 'article',
        options: ['11pt', 'twocolumn'],
        sizePt: 11,
      })
      expect(p.packages.geometry).toBeDefined()
      expect(p.geometry.options.kv.margin).toBe('1in')
      expect(p.fontPackage.name).toBe('times')
      expect(p.parskipPackage).toBeDefined()
      expect(p.linespread.value).toBe(1.2)
      expect(p.setlength.parindent.pt).toBe(15)
      expect(p.rules.headrulewidth.pt).toBe(0.4)
      expect(p.headings).toHaveLength(1)
      expect(p.colors).toHaveLength(1)
    })

    it('detects spacing package commands and baselinestretch', () => {
      const p1 = parsePreamble('\\onehalfspacing')
      expect(p1.stretch).toMatchObject({ value: 1.5, cmd: '\\onehalfspacing' })

      const p2 = parsePreamble('\\doublespacing')
      expect(p2.stretch).toMatchObject({ value: 2, cmd: '\\doublespacing' })

      const p3 = parsePreamble('\\setstretch{1.3}')
      expect(p3.stretch).toMatchObject({ value: 1.3, cmd: '\\setstretch' })
    })
  })

  describe('parseLog', () => {
    it('parses document class and loaded packages from log output', () => {
      const log = `
This is pdfTeX, Version 3.141592653-2.6-1.40.26 (TeX Live 2024)
Document Class: article 2023/05/17 v1.4n Standard LaTeX document class
(/usr/local/texlive/2024/texmf-dist/tex/latex/base/size10.clo)
Package: geometry 2020/01/02 v5.9 Page Geometry
(/usr/local/texlive/2024/texmf-dist/tex/latex/amsmath/amsmath.sty
`
      const parsed = parseLog(log)
      expect(parsed.documentClass).toMatchObject({
        name: 'article',
        date: '2023/05/17',
      })
      expect(parsed.packages).toContain('geometry')
      expect(parsed.packages).toContain('amsmath')
    })
  })

  it('reads every package of a log, however long', () => {
    const filler = 'x'.repeat(200) + '\n'
    const log = [
      'Document Class: article 2024/01/01',
      filler.repeat(50_000),
      'Package: amsmath 2020/01/01',
      '(/usr/share/texlive/texmf-dist/tex/latex/hyperref/hyperref.sty',
    ].join('\n')
    expect(log.length).toBeGreaterThan(8 * 1024 * 1024)
    const parsed = parseLog(log)
    expect(parsed.documentClass).toEqual({ name: 'article', date: '2024/01/01' })
    expect(parsed.packages).toEqual(['amsmath', 'hyperref'])
  })

  describe('buildLines and findColumns', () => {
    it('groups text items sharing a baseline into lines', () => {
      const items = [
        { s: 'Hello', font: 'CMR10', size: 10, x: 100, y: 700, w: 25 },
        { s: 'world', font: 'CMR10', size: 10, x: 130, y: 700, w: 25 },
        { s: 'Second line', font: 'CMR10', size: 10, x: 100, y: 686, w: 60 },
      ]
      const lines = buildLines(items)
      expect(lines).toHaveLength(2)
      expect(lines[0].text).toBe('Hello world')
      expect(lines[0].y).toBe(700)
      expect(lines[1].text).toBe('Second line')
      expect(lines[1].y).toBe(686)
    })

    it('detects two column layouts from line start positions', () => {
      const lines = []
      // Left column lines at x0 = 50, right edge ~ 220
      for (let i = 0; i < 15; i++) {
        lines.push({ x0: 50, x1: 220, y: 700 - i * 14, text: `Left col line ${i}` })
      }
      // Right column lines at x0 = 250, right edge ~ 420
      for (let i = 0; i < 15; i++) {
        lines.push({ x0: 250, x1: 420, y: 700 - i * 14, text: `Right col line ${i}` })
      }
      const cols = findColumns(lines)
      expect(cols).not.toBeNull()
      expect(cols.leftStart).toBe(50)
      expect(cols.colRight).toBe(220)
      expect(cols.rightStart).toBe(250)
      expect(cols.rightEdge).toBe(420)
    })

    it('returns null for single column layout', () => {
      const lines = []
      for (let i = 0; i < 20; i++) {
        lines.push({ x0: 72, x1: 500, y: 700 - i * 14, text: `Single col line ${i}` })
      }
      expect(findColumns(lines)).toBeNull()
    })
  })

  describe('summarizePages, linkValues, and buildOutput', () => {
    function makePage(items = [], rules = []) {
      return {
        width: 612, // Letter width bp
        height: 792, // Letter height bp
        items,
        rules,
        textColours: { '#000000': 100 },
      }
    }

    it('extracts style properties from synthesized pages and matches defaults', () => {
      const items = []
      // 1 heading
      items.push({ s: 'Section Title', font: 'CMBX12', size: 14.4, x: 72, y: 700, w: 120 })
      // Body text lines (size 10bp => 10.04pt, baseline ~ 12bp => 12.05pt)
      for (let i = 1; i <= 20; i++) {
        items.push({
          s: `This is paragraph text line number ${i} which has sufficient length to count.`,
          font: 'CMR10',
          size: 10,
          x: 72,
          y: 700 - i * 12,
          w: 350,
        })
      }
      // Caption
      items.push({ s: 'Figure 1: Test caption', font: 'CMR10', size: 9, x: 72, y: 400, w: 100 })
      // Footnote
      items.push({ s: '1. A footnote text', font: 'CMR10', size: 8, x: 72, y: 100, w: 100 })

      const pages = [makePage(items)]
      const preambleText = `
\\documentclass[10pt]{article}
\\usepackage[margin=1in]{geometry}
`
      const summary = summarizePages(pages, { preambleText, documentClass: 'article' })
      expect(summary.values.body.sizePt).toBeCloseTo(10, 0)
      expect(summary.values.area.cols).toBe(1)
      expect(summary.values.headings).toHaveLength(1)
      expect(summary.values.headings[0].bold).toBe(true)

      const output = buildOutput(summary)
      expect(output.v).toBe(1)
      expect(output.paper).toBe('Letter')
      expect(output.class).toBe('article 10pt')
      expect(output.area.w.v).toBeDefined()
      expect(output.body.size.v).toBeDefined()
      expect(output.headings[0].size).toBeDefined()

      // Verify compact output: JSON length should be well under 4000 characters (< 1000 tokens)
      const json = JSON.stringify(output)
      expect(json.length).toBeLessThan(2500)
    })
  })

  describe('compareStyles', () => {
    it('compares two style objects and generates LaTeX fixes', () => {
      const a = {
        area: {
          w: { v: 400 },
          h: { v: 600 },
          left: { v: 54 },
          right: { v: 54 },
          top: { v: 70 },
          bottom: { v: 70 },
          cols: 1,
        },
        body: {
          size: { v: 10 },
          baseline: { v: 12 },
          font: { family: 'Times' },
        },
        parIndent: { v: 15 },
        parSkip: { v: 0 },
        headings: [{ lvl: 1, size: 14.4, before: 15, after: 10 }],
        colours: { text: [['#000000', 1]] },
      }

      const b = {
        area: {
          w: { v: 450 }, // diff: +50pt
          h: { v: 600 },
          left: { v: 54 },
          right: { v: 54 },
          top: { v: 70 },
          bottom: { v: 70 },
          cols: 1,
        },
        body: {
          size: { v: 11 }, // diff: 11pt vs 10pt
          baseline: { v: 14 }, // diff: 14pt vs 12pt
          stretch: 1.15,
          font: { family: 'Palatino' }, // diff: Palatino vs Times
        },
        parIndent: { v: 20 }, // diff: 20pt vs 15pt
        parSkip: { v: 6 }, // diff: 6pt vs 0pt
        headings: [{ lvl: 1, size: 17.28, before: 18, after: 12 }],
        colours: { text: [['#111111', 1]] },
      }

      const comparison = compareStyles(a, b)
      expect(comparison.same).toBeGreaterThan(0)
      expect(comparison.diffs.length).toBeGreaterThan(0)

      const widthDiff = comparison.diffs.find(d => d.prop === 'area.w')
      expect(widthDiff).toBeDefined()
      expect(widthDiff.now).toBe(400)
      expect(widthDiff.template).toBe(450)
      expect(widthDiff.fix).toContain('450pt')

      const baselineDiff = comparison.diffs.find(d => d.prop === 'body.baseline')
      expect(baselineDiff).toBeDefined()
      expect(baselineDiff.fix).toContain('1.15')

      const bodySizeDiff = comparison.diffs.find(d => d.prop === 'body.size')
      expect(bodySizeDiff).toBeDefined()
      expect(bodySizeDiff.fix).toContain('11pt')

      const familyDiff = comparison.diffs.find(d => d.prop === 'body.family')
      expect(familyDiff).toBeDefined()
      expect(familyDiff.template).toBe('Palatino')
    })
  })

  describe('inspectCompiledStyle (async with mocked CLSI)', () => {
    it('throws NO_PDF when output.pdf is missing or empty', async () => {
      const getOutputFileStream = vi.fn().mockImplementation((...args) => {
        throw new Errors.OutputFileFetchFailedError('Not found')
      })
      const inspector = createPdfStyleInspector({ getOutputFileStream })

      let err = null
      try {
        await inspector.inspectCompiledStyle({
          projectId: 'p1',
          userId: 'u1',
          buildId: 'b1',
        })
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(PdfStyleError)
      expect(err.code).toBe(PDF_STYLE_ERRORS.NO_PDF)
    })

    it('extracts style and diffs when against is provided', async () => {
      const pagesA = [
        {
          width: 612,
          height: 792,
          items: [
            { s: 'Heading A', font: 'CMBX12', size: 14.4, x: 72, y: 700, w: 100 },
            ...Array.from({ length: 20 }, (_, i) => ({
              s: `Body line ${i} of document A with enough characters.`,
              font: 'CMR10',
              size: 10,
              x: 72,
              y: 680 - i * 12,
              w: 300,
            })),
          ],
          rules: [],
          textColours: { '#000000': 50 },
        },
      ]

      const pagesB = [
        {
          width: 612,
          height: 792,
          items: [
            { s: 'Heading B', font: 'CMBX12', size: 17.28, x: 72, y: 700, w: 100 },
            ...Array.from({ length: 20 }, (_, i) => ({
              s: `Body line ${i} of document B with enough characters.`,
              font: 'CMR10',
              size: 12,
              x: 72,
              y: 680 - i * 15,
              w: 350,
            })),
          ],
          rules: [],
          textColours: { '#000000': 50 },
        },
      ]

      const styleA = extractStyleFromPages(pagesA, { documentClass: 'article' })
      const styleB = extractStyleFromPages(pagesB, { documentClass: 'article' })

      const diff = compareStyles(styleA, styleB)
      expect(diff.diffs.length).toBeGreaterThan(0)
      expect(diff.same).toBeGreaterThan(0)
    })
  })
})

describe('extractStyle through the PDF worker', () => {
  it('reads a real PDF in a worker thread', async () => {
    const style = await extractStyle(makePdf('Body text'), { documentClass: 'article' })
    expect(style.v).toBe(1)
    expect(style.pages).toBe(1)
  })

  it('rejects bytes that are not a PDF with NOT_A_PDF', async () => {
    let err = null
    try {
      await extractStyle(Buffer.from('not a pdf at all'))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(PdfStyleError)
    expect(err.code).toBe(PDF_STYLE_ERRORS.NOT_A_PDF)
  })

  it('leaves the caller bytes intact after the read', async () => {
    const pdf = makePdf('Intact')
    const before = Buffer.from(pdf)
    await extractStyle(pdf)
    expect(pdf.equals(before)).toBe(true)
  })
})

describe('samplePageNumbers', () => {
  it('reads every page of a short document', () => {
    expect(samplePageNumbers(3)).toEqual([1, 2, 3])
  })

  it('spreads the cap evenly over a long one, first and last included', () => {
    const pages = samplePageNumbers(5000)
    expect(pages).toHaveLength(MAX_STYLE_PAGES)
    expect(pages[0]).toBe(1)
    expect(pages.at(-1)).toBe(5000)
    expect(pages.every((page, i) => i === 0 || page > pages[i - 1])).toBe(true)
  })
})
