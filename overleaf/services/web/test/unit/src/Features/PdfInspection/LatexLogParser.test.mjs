import { describe, it, expect } from 'vitest'
import {
  parseLatexLog,
  default as defaultParse,
} from '../../../../../app/src/Features/PdfInspection/LatexLogParser.mjs'

// Excerpts of real pdflatex logs (TeX Live 2026). The "plain" logs run in
// default mode, the "fl" ones with -file-line-error.

// Undefined control sequence and a missing $, file:line mode.
const FILE_LINE_ERRORS = [
  './errors.tex:3: Undefined control sequence.',
  'l.3 \\undefinedmacro',
  '                   ',
  'The control sequence at the end of the top line',
  "of your error message was never \\def'ed. If you have",
  "misspelled it (e.g., `\\hobx'), type `I' and the correct",
  "spelling (e.g., `I\\hbox'). Otherwise just continue,",
  "and I'll forget about whatever was undefined.",
  '',
  "LaTeX Font Info:    External font `cmex10' loaded for size",
  '(Font)              <7> on input line 4.',
  './errors.tex:5: Missing $ inserted.',
  '<inserted text> ',
  '                $',
  'l.5 \\end{document}',
  '                  ',
  "I've inserted a begin-math/end-math symbol since I think",
  'you left one out. Proceed, with fingers crossed.',
  '',
  '[1',
  '',
  '{/usr/local/texlive/2026/texmf-var/fonts/map/pdftex/updmap/pdftex.map}]',
].join('\n')

// A missing package stops the run. The error's own line is the one the
// "Emergency stop." below reports.
const MISSING_PACKAGE_FILE_LINE = [
  "! LaTeX Error: File `nosuchpackage.sty' not found.",
  '',
  'Type X to quit or <RETURN> to proceed,',
  'or enter new name. (Default extension: sty)',
  '',
  'Enter file name: ',
  './fatalpkg.tex:3: Emergency stop.',
  '<read *> ',
  '         ',
  'l.3 \\begin',
  '          {document}^^M',
  '*** (cannot \\read from terminal in nonstop modes)',
  '',
  ' ',
  "Here is how much of TeX's memory you used:",
  ' 243 strings out of 468997',
  ' 35i,0n,38p,153b,36s stack positions out of 10000i,1000n,20000p,200000b,200000s',
  './fatalpkg.tex:3:  ==> Fatal error occurred, no output PDF file produced!',
].join('\n')

// The same run in plain mode. The fatal line is the "!  ==>" form.
const MISSING_PACKAGE_PLAIN = [
  "! LaTeX Error: File `nosuchpackage.sty' not found.",
  '',
  'Type X to quit or <RETURN> to proceed,',
  'or enter new name. (Default extension: sty)',
  '',
  'Enter file name: ',
  '! Emergency stop.',
  '<read *> ',
  '         ',
  'l.3 \\begin',
  '          {document}^^M',
  '*** (cannot \\read from terminal in nonstop modes)',
  '',
  '!  ==> Fatal error occurred, no output PDF file produced!',
].join('\n')

// The fatal line is printed right after an entry filled to 79 characters.
// That line must not be joined onto it.
const FATAL_AFTER_FULL_LINE = [
  './fatal.tex:3: Emergency stop.',
  'l.3 \\input{does-not-exist}',
  '                          ^^M',
  '*** (cannot \\read from terminal in nonstop modes)',
  '',
  ' 35i,0n,38p,153b,36s stack positions out of 10000i,1000n,20000p,200000b,200000s',
  './fatal.tex:3:  ==> Fatal error occurred, no output PDF file produced!',
].join('\n')

// A runaway argument. The error after it is its own entry, not context.
const RUNAWAY = [
  'Runaway argument?',
  '{abc \\par Body text here. \\end {document} ',
  '! File ended while scanning use of \\@xdblarg.',
  '<inserted text> ',
  '                \\par ',
  '<*> runaway.tex',
  '               ',
  "I suspect you have forgotten a `}', causing me",
  'to read past where you wanted me to stop.',
  '',
  '! Emergency stop.',
  '<*> runaway.tex',
  '',
  '!  ==> Fatal error occurred, no output PDF file produced!',
].join('\n')

// Two package warnings, one over two lines and one wrapped by TeX at 79
// characters.
const PACKAGE_WARNINGS = [
  'Package mypkg Warning: This is a long warning which is printed',
  '(mypkg)                on two lines with the package name on input line 3.',
  '',
  '',
  'Package mypkg Warning: Short warning that should be a single line but it is lon',
  'g enough to wrap around the limit.',
  '',
  "Package natbib Warning: Citation `nobody' on page 1 undefined on input line 7.",
  '',
  '',
].join('\n')

// A font warning carries its line number on the "(Font)" line below it.
const FONT_WARNING = [
  'LaTeX Font Info:    Trying to load font information for OT1+nosuchfamily on inp',
  'ut line 6.',
  '',
  "LaTeX Font Warning: Font shape `OT1/nosuchfamily/m/n' undefined",
  "(Font)              using `OT1/cmr/m/n' instead on input line 6.",
  '',
].join('\n')

// References and the rerun warning that follows them.
const REFERENCES = [
  "LaTeX Warning: Reference `nope' on page 1 undefined on input line 3.",
  "LaTeX Warning: Citation `missing' on page 1 undefined on input line 3.",
  '',
  'LaTeX Warning: There were undefined references.',
  '',
  'LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.',
].join('\n')

// The same overfull header is printed as page 1, 2 and 3 is shipped out.
const HEADER_BOXES = [
  'Underfull \\hbox (badness 10000) has occurred while \\output is active',
  '\\OT1/cmr/m/n/10 Overfull header line xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  ' []',
  '',
  '',
  'Overfull \\hbox (555.0pt too wide) has occurred while \\output is active',
  ' [][]| ',
  ' []',
  '',
  '[1{/usr/local/texlive/2026/texmf-var/fonts/map/pdftex/updmap/pdftex.map}]',
  'Underfull \\hbox (badness 10000) has occurred while \\output is active',
  '\\OT1/cmr/m/n/10 Overfull header line xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  ' []',
  '',
  '',
  'Overfull \\hbox (555.0pt too wide) has occurred while \\output is active',
  ' [][]| ',
  ' []',
  '',
  '[2]',
  'Overfull \\hbox (227.9439pt too wide) in paragraph at lines 4--5',
  '[]\\OT1/cmr/m/n/10 Supercalifragilisticexpialidocious',
].join('\n')

describe('parseLatexLog on real pdflatex logs', () => {
  it('reads file:line errors with the excerpt that follows each one', () => {
    const { errors } = parseLatexLog(FILE_LINE_ERRORS)
    expect(errors).toHaveLength(2)
    expect(errors[0]).toMatchObject({
      file: './errors.tex',
      line: 3,
      message: 'Undefined control sequence.',
    })
    expect(errors[0].context[0]).toBe('l.3 \\undefinedmacro')
    expect(errors[0].context).not.toContain('')
    expect(errors[1]).toMatchObject({
      file: './errors.tex',
      line: 5,
      message: 'Missing $ inserted.',
    })
    expect(errors[1].context).toContain('l.5 \\end{document}')
  })

  it('exposes the raw excerpt text the AI-assist tools cut excerpts from', () => {
    const [first] = parseLatexLog(FILE_LINE_ERRORS).errors
    expect(first.raw.split('\n')[0]).toBe(
      './errors.tex:3: Undefined control sequence.'
    )
    expect(first.raw).toContain('l.3 \\undefinedmacro')
  })

  it('gives a missing file the line its "Emergency stop." reports (file:line mode)', () => {
    const { errors, fatal } = parseLatexLog(MISSING_PACKAGE_FILE_LINE)
    expect(fatal).toBe(true)
    expect(errors.map(e => [e.line, e.message])).toEqual([
      [3, "LaTeX Error: File `nosuchpackage.sty' not found."],
      [3, 'Emergency stop.'],
    ])
  })

  it('gives a missing file the line its "Emergency stop." reports (plain mode)', () => {
    const { errors, fatal } = parseLatexLog(MISSING_PACKAGE_PLAIN)
    expect(fatal).toBe(true)
    expect(errors.map(e => [e.line, e.message])).toEqual([
      [3, "LaTeX Error: File `nosuchpackage.sty' not found."],
      [3, 'Emergency stop.'],
    ])
  })

  it('reports the no-PDF line as fatal, not as an error, in file:line mode', () => {
    const { errors, fatal } = parseLatexLog(FATAL_AFTER_FULL_LINE)
    expect(fatal).toBe(true)
    expect(errors.map(e => e.message)).toEqual(['Emergency stop.'])
  })

  it('reads a runaway argument and the error after it as separate entries', () => {
    const { errors, fatal } = parseLatexLog(RUNAWAY)
    expect(fatal).toBe(true)
    expect(errors.map(e => e.message)).toEqual([
      'Runaway argument?',
      'File ended while scanning use of \\@xdblarg.',
      'Emergency stop.',
    ])
  })

  it('joins multi-line package warnings and wrapped warnings into one message', () => {
    const { warnings } = parseLatexLog(PACKAGE_WARNINGS)
    expect(warnings.map(w => w.message)).toEqual([
      'Package mypkg Warning: This is a long warning which is printed on two lines with the package name on input line 3.',
      'Package mypkg Warning: Short warning that should be a single line but it is long enough to wrap around the limit.',
      "Package natbib Warning: Citation `nobody' on page 1 undefined on input line 7.",
    ])
    expect(warnings[0].line).toBe(3)
    expect(warnings[2].line).toBe(7)
  })

  it('reads the line of a font warning from its (Font) continuation', () => {
    const { warnings } = parseLatexLog(FONT_WARNING)
    expect(warnings).toEqual([
      {
        level: 'warning',
        file: undefined,
        line: 6,
        message:
          "Font shape `OT1/nosuchfamily/m/n' undefined using `OT1/cmr/m/n' instead on input line 6.",
      },
    ])
  })

  it('reads undefined references, citations and the rerun warning', () => {
    const { warnings } = parseLatexLog(REFERENCES)
    expect(warnings.map(w => [w.line, w.message])).toEqual([
      [3, "Reference `nope' on page 1 undefined on input line 3."],
      [3, "Citation `missing' on page 1 undefined on input line 3."],
      [null, 'There were undefined references.'],
      [null, 'Label(s) may have changed. Rerun to get cross-references right.'],
    ])
  })

  it('counts a bad box once per page it is printed on', () => {
    const { typesetting } = parseLatexLog(HEADER_BOXES)
    expect(typesetting.map(t => [t.page, t.message])).toEqual([
      [
        1,
        'Underfull \\hbox (badness 10000) has occurred while \\output is active',
      ],
      [
        1,
        'Overfull \\hbox (555.0pt too wide) has occurred while \\output is active',
      ],
      [
        2,
        'Underfull \\hbox (badness 10000) has occurred while \\output is active',
      ],
      [
        2,
        'Overfull \\hbox (555.0pt too wide) has occurred while \\output is active',
      ],
      [3, 'Overfull \\hbox (227.9439pt too wide) in paragraph at lines 4--5'],
    ])
    expect(typesetting[4].line).toBe(4)
  })

  it('drops repeated entries by default and keeps them with ignoreDuplicates false', () => {
    const log = [
      './main.tex:3: Undefined control sequence.',
      'l.3 \\foo',
      '',
      './main.tex:3: Undefined control sequence.',
      'l.3 \\foo',
      '',
    ].join('\n')
    expect(parseLatexLog(log).errors).toHaveLength(1)
    expect(parseLatexLog(log, { ignoreDuplicates: false }).errors).toHaveLength(
      2
    )
  })

  it('rewrites file names with normalizeFile before returning them', () => {
    const { errors } = parseLatexLog(FILE_LINE_ERRORS, {
      normalizeFile: file => file?.replace(/^\.\//, ''),
    })
    expect(errors.map(e => e.file)).toEqual(['errors.tex', 'errors.tex'])
  })

  it('reads CRLF line endings the same as LF', () => {
    const lf = parseLatexLog(FILE_LINE_ERRORS)
    const crlf = parseLatexLog(FILE_LINE_ERRORS.replace(/\n/g, '\r\n'))
    expect(crlf).toEqual(lf)
  })

  it('returns empty results for an empty log', () => {
    expect(parseLatexLog('')).toEqual({
      errors: [],
      warnings: [],
      typesetting: [],
      fatal: false,
    })
    expect(parseLatexLog(null).errors).toEqual([])
  })

  it('exports the same function as the default export', () => {
    expect(defaultParse).toBe(parseLatexLog)
  })
})

describe('parseLatexLog page tracking', () => {
  it('counts the next page only when its number is in sequence', () => {
    const log = [
      'Overfull \\hbox (1pt too wide) detected at line 1',
      '[1]',
      'Overfull \\hbox (2pt too wide) detected at line 2',
      'see the note [7] in the text',
      'Overfull \\hbox (3pt too wide) detected at line 3',
      '[2 <./fig.png>]',
      'Overfull \\hbox (4pt too wide) detected at line 4',
    ].join('\n')
    const { typesetting } = parseLatexLog(log)
    expect(typesetting.map(t => t.page)).toEqual([1, 2, 2, 3])
  })
})
