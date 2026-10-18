import { describe, it, expect } from 'vitest'
import { parseLatexLog } from '../../../../../app/src/Features/PdfInspection/LatexLogParser.mjs'
import { parseBibLog } from '../../../app/src/BibLogParser.mjs'
import {
  normalizeLogPath,
  rootDirectory,
  summarizeCompileLogs,
} from '../../../app/src/CompileLogSummary.mjs'

const FATAL = '!  ==> Fatal error occurred, no output PDF file produced!'

describe('parseLatexLog', () => {
  it('reads file:line errors with the source excerpt that follows', () => {
    const log = [
      '(./main.tex',
      './chapters/intro.tex:12: Undefined control sequence.',
      'l.12 \\foo',
      '         bar',
      '',
      'LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.',
    ].join('\n')
    const { errors, warnings } = parseLatexLog(log)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({
      file: './chapters/intro.tex',
      line: 12,
      message: 'Undefined control sequence.',
    })
    expect(errors[0].context).toEqual(['l.12 \\foo', '         bar'])
    expect(warnings).toHaveLength(1)
  })

  it('finds the line of a classic "! " error whose help text comes before the l.N line', () => {
    const log = [
      '! LaTeX Error: Environment itemize undefined.',
      '',
      'See the LaTeX manual or LaTeX Companion for explanation.',
      'Type  H <return>  for immediate help.',
      '',
      'l.20 \\begin{itemize}',
      '',
    ].join('\n')
    const [error] = parseLatexLog(log).errors
    expect(error.line).toBe(20)
    expect(error.message).toBe('LaTeX Error: Environment itemize undefined.')
    expect(error.context.at(-1)).toBe('l.20 \\begin{itemize}')
  })

  it('attributes warnings to the innermost open file and returns to the parent on close', () => {
    const log = [
      '(./main.tex',
      '(./chapters/intro.tex',
      "LaTeX Warning: Reference `a' on page 1 undefined on input line 4.",
      ')',
      "LaTeX Warning: Reference `b' on page 1 undefined on input line 9.",
    ].join('\n')
    const { warnings } = parseLatexLog(log)
    expect(warnings[0]).toMatchObject({ file: './chapters/intro.tex', line: 4 })
    expect(warnings[1]).toMatchObject({ file: './main.tex', line: 9 })
  })

  it('joins a multi-line package warning into one message', () => {
    const log = [
      'Package natbib Warning: Citation(s) may have changed.',
      '(natbib)                Rerun to get citations correct.',
      '',
    ].join('\n')
    const { warnings } = parseLatexLog(log)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toBe(
      'Package natbib Warning: Citation(s) may have changed. Rerun to get citations correct.'
    )
  })

  it('reports the fatal no-PDF line as a flag and does not treat it as an error', () => {
    const log = ['! Emergency stop.', FATAL].join('\n')
    const parsed = parseLatexLog(log)
    expect(parsed.fatal).toBe(true)
    expect(parsed.errors).toHaveLength(1)
    expect(parsed.errors[0].message).toBe('Emergency stop.')
  })

  it('reads overfull boxes as typesetting entries with their line', () => {
    const log = 'Overfull \\hbox (12.0pt too wide) in paragraph at lines 10--12'
    const { typesetting } = parseLatexLog(log)
    expect(typesetting).toEqual([
      expect.objectContaining({ line: 10, level: 'typesetting' }),
    ])
  })

  it('notes the page TeX was building when it reported a bad box', () => {
    const log = [
      '(./main.tex [1{/usr/local/texlive/2024/texmf-var/fonts/map/pdftex/updmap/pdftex.map}]',
      'Overfull \\hbox (3.1pt too wide) in paragraph at lines 20--21',
      '[]\\OT1/cmr/m/n/10 some text',
      '',
      '[2] [3 <./figures/plot.png>]',
      'Table [12] row (see [99])',
      'Overfull \\hbox (48.2pt too wide) in alignment at lines 40--52',
      ' []',
      '[4])',
    ].join('\n')
    const { typesetting } = parseLatexLog(log)
    expect(typesetting.map(entry => [entry.line, entry.page])).toEqual([
      [20, 2],
      // "[12]" and "[99]" are not the next page in sequence, so they are not
      // read as page breaks
      [40, 4],
    ])
  })

  it('rejoins lines LaTeX wrapped at 79 columns', () => {
    const head =
      'LaTeX Warning: Reference `' + 'x'.repeat(32) + "' on page 2 undefined"
    expect(head.length).toBe(79)
    const log = `${head}\n on input line 9.`
    const [warning] = parseLatexLog(log).warnings
    expect(warning.line).toBe(9)
    expect(warning.message).toContain('on input line 9.')
  })

  it('returns empty lists for an empty log', () => {
    expect(parseLatexLog('')).toEqual({
      errors: [],
      warnings: [],
      typesetting: [],
      fatal: false,
    })
  })
})

describe('parseBibLog', () => {
  it('reads BibTeX warnings and errors with their file and line', () => {
    const blg = [
      'This is BibTeX, Version 0.99d (TeX Live 2023)',
      'Warning--I didn\'t find a database entry for "lamport1994"',
      '--line 12 of file main.tex',
      "I couldn't open database file missing.bib",
    ].join('\n')
    const parsed = parseBibLog(blg)
    expect(parsed.dialect).toBe('bibtex')
    expect(parsed.warnings).toEqual([
      expect.objectContaining({ file: 'main.tex', line: 12 }),
    ])
    expect(parsed.errors).toEqual([
      expect.objectContaining({
        message: "I couldn't open database file missing.bib",
      }),
    ])
  })

  it('reads Biber syntax errors with the file they came from', () => {
    const blg = [
      'INFO - This is Biber 2.19',
      "[1] Biber::Config > ERROR - BibTeX subsystem: /compile/refs.bib_123.utf8, line 8, syntax error: it's bad",
    ].join('\n')
    const parsed = parseBibLog(blg)
    expect(parsed.dialect).toBe('biber')
    expect(parsed.errors).toEqual([
      expect.objectContaining({ file: 'refs.bib', line: 8 }),
    ])
  })

  it('returns null for text that is not a bibliography log', () => {
    expect(parseBibLog('just some text\n')).toBeNull()
  })
})

describe('normalizeLogPath', () => {
  it('strips the compile directory and leading ./', () => {
    expect(normalizeLogPath('./chapters/intro.tex')).toBe('chapters/intro.tex')
    expect(normalizeLogPath('/compile/chapters/intro.tex')).toBe(
      'chapters/intro.tex'
    )
    expect(
      normalizeLogPath(
        '/compiles/0123456789abcdef01234567-89abcdef0123456789abcdef/main.tex'
      )
    ).toBe('main.tex')
  })

  it('joins relative paths onto the root document directory', () => {
    expect(normalizeLogPath('./main.tex', 'thesis')).toBe('thesis/main.tex')
  })

  it('returns null for absolute system paths and empty input', () => {
    expect(
      normalizeLogPath('/usr/local/texlive/texmf-dist/article.cls')
    ).toBeNull()
    expect(normalizeLogPath('')).toBeNull()
    expect(normalizeLogPath(undefined)).toBeNull()
  })
})

describe('rootDirectory', () => {
  it('returns the folder of the root document, or empty at the top level', () => {
    expect(rootDirectory('/thesis/main.tex')).toBe('thesis')
    expect(rootDirectory('main.tex')).toBe('')
    expect(rootDirectory(null)).toBe('')
  })
})

describe('summarizeCompileLogs', () => {
  const LOG = [
    '(./main.tex',
    './chapters/intro.tex:12: Undefined control sequence.',
    'l.12 \\foo',
    '',
    "LaTeX Warning: Reference `sec:x' on page 1 undefined on input line 5.",
    "LaTeX Warning: Citation `knuth' on page 1 undefined on input line 7.",
    'LaTeX Warning: There were undefined references.',
    'LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.',
    'Overfull \\hbox (1.0pt too wide) in paragraph at lines 3--3',
    '',
  ].join('\n')

  it('counts errors, warnings, bad boxes and undefined targets', () => {
    const summary = summarizeCompileLogs({
      latexLog: LOG,
      rootDocPath: 'thesis/main.tex',
    })
    expect(summary.counts).toEqual({
      errors: 1,
      warnings: 3,
      badBoxes: 1,
      undefinedReferences: 1,
      undefinedCitations: 1,
    })
    expect(summary.fatal).toBe(false)
    expect(summary.rerunNeeded).toBe(true)
  })

  it('reports paths relative to the project, including the root document folder', () => {
    const summary = summarizeCompileLogs({
      latexLog: LOG,
      rootDocPath: 'thesis/main.tex',
    })
    expect(summary.errors[0]).toMatchObject({
      source: 'latex',
      file: 'thesis/chapters/intro.tex',
      line: 12,
    })
    // The warnings come after the file-line error, with no file opened in
    // between, so they belong to the root document.
    expect(summary.warnings[0]).toMatchObject({
      kind: 'undefined-reference',
      file: 'thesis/main.tex',
    })
  })

  it('does not list the summary "There were undefined" line as a warning', () => {
    const summary = summarizeCompileLogs({ latexLog: LOG })
    expect(
      summary.warnings.some(w => /There were undefined/.test(w.message))
    ).toBe(false)
  })

  it('merges BibTeX messages into the same error and warning lists', () => {
    const blg = [
      'This is BibTeX, Version 0.99d',
      'Warning--I didn\'t find a database entry for "x"',
      '--line 3 of file refs.bib',
    ].join('\n')
    const summary = summarizeCompileLogs({ latexLog: LOG, bibLogs: [blg] })
    expect(
      summary.warnings.some(
        w => w.source === 'bibtex' && w.kind === 'missing-entry'
      )
    ).toBe(true)
    expect(summary.counts.warnings).toBe(4)
  })

  it('says so when the log says the build produced no PDF', () => {
    const summary = summarizeCompileLogs({
      latexLog: ['! Emergency stop.', FATAL].join('\n'),
    })
    expect(summary.fatal).toBe(true)
    expect(summary.advice[0]).toMatch(/fatal error/)
  })

  it('returns an empty summary when no log was read', () => {
    const summary = summarizeCompileLogs({ latexLog: null })
    expect(summary.counts.errors).toBe(0)
    expect(summary.errors).toEqual([])
    expect(summary.advice).toEqual([])
  })

  it('lists every error, without a cap', () => {
    const many = Array.from(
      { length: 505 },
      (_, i) => `./a.tex:${i + 1}: Something ${i}.`
    ).join('\n')
    const summary = summarizeCompileLogs({ latexLog: many })
    expect(summary.counts.errors).toBe(505)
    expect(summary.errors).toHaveLength(505)
    expect(summary).not.toHaveProperty('errorsTruncated')
  })

  it('keeps every context line of an excerpt', () => {
    const excerptLines = Array.from({ length: 30 }, (_, i) => `context ${i}`)
    const log = ['./a.tex:1: Boom.', 'l.1 start', ...excerptLines, ''].join(
      '\n'
    )
    const [error] = summarizeCompileLogs({ latexLog: log }).errors
    expect(error.context.split('\n').length).toBeGreaterThanOrEqual(30)
  })
})

describe('bad boxes repeated across pages', () => {
  it('counts a box LaTeX repeats on several pages once, with its page count', () => {
    const log = [
      '(./main.tex [1]',
      'Overfull \\hbox (3.1pt too wide) in paragraph at lines 20--21',
      '[2]',
      'Overfull \\hbox (3.1pt too wide) in paragraph at lines 20--21',
      '[3]',
      'Overfull \\hbox (3.1pt too wide) in paragraph at lines 20--21',
      '[4])',
    ].join('\n')
    const summary = summarizeCompileLogs({ latexLog: log })
    expect(summary.counts.badBoxes).toBe(1)
    expect(summary.badBoxes).toHaveLength(1)
    expect(summary.badBoxes[0]).toMatchObject({
      file: 'main.tex',
      line: 20,
      occurrences: expect.any(Number),
    })
    expect(summary.badBoxes[0].occurrences).toBeGreaterThanOrEqual(1)
  })

  it('keeps boxes at different source lines apart', () => {
    const log = [
      'Overfull \\hbox (3.1pt too wide) in paragraph at lines 20--21',
      'Underfull \\hbox (badness 10000) in paragraph at lines 40--41',
    ].join('\n')
    const summary = summarizeCompileLogs({ latexLog: log })
    expect(summary.counts.badBoxes).toBe(2)
    expect(summary.badBoxes.map(box => box.line)).toEqual([20, 40])
  })
})

