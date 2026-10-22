import { describe, it } from 'vitest'
import { expect } from 'chai'
import { LatexLogParser } from '../../../app/src/LatexLogParser.mjs'

describe('LatexLogParser -file-line-error handling', () => {
  it('parses consecutive -file-line-error entries without swallowing lines', () => {
    const log = [
      'This is pdfTeX, Version 3.141592653-2.6-1.40.24 (TeX Live 2022)',
      'entering extended mode',
      './main.tex:14: Undefined control sequence.',
      'l.14 \\undefinedmacro',
      './sections/intro.tex:25: Missing $ inserted.',
      '<inserted text>',
      '                $',
      'l.25 \\begin{equation}',
      '(./main.aux)',
      ')',
      'Output written on main.pdf (1 page, 1000 bytes).',
    ].join('\n')

    const result = LatexLogParser.parse(log)

    expect(result.errors).to.have.length(2)
    expect(result.errors[0].file).to.equal('main.tex')
    expect(result.errors[0].line).to.equal(14)
    expect(result.errors[0].message).to.equal('Undefined control sequence.')

    expect(result.errors[1].file).to.equal('sections/intro.tex')
    expect(result.errors[1].line).to.equal(25)
    expect(result.errors[1].message).to.equal('Missing $ inserted.')
  })

  it('normalizes container prefixes and leading ./ from file paths', () => {
    const log = [
      '/compiles/64f123456789/chapters/abstract.tex:5: LaTeX Error: Environment foo undefined.',
    ].join('\n')

    const result = LatexLogParser.parse(log)
    expect(result.errors).to.have.length(1)
    expect(result.errors[0].file).to.equal('chapters/abstract.tex')
    expect(result.errors[0].line).to.equal(5)
  })
})

describe('LatexLogParser adapter over the shared parser', () => {
  it('cleans the file name of every entry, not only file:line errors', () => {
    const log = [
      '(./main.tex',
      '! Undefined control sequence.',
      'l.4 \\foo',
      '',
      'LaTeX Warning: Reference `a` on page 1 undefined on input line 9.',
      '(./chapters/intro.tex',
      'Overfull \\hbox (4.0pt too wide) in paragraph at lines 2--3',
    ].join('\n')

    const result = LatexLogParser.parse(log)

    expect(result.errors[0].file).to.equal('main.tex')
    expect(result.warnings[0].file).to.equal('main.tex')
    expect(result.warnings[0].line).to.equal(9)
    expect(result.typesetting[0].file).to.equal('chapters/intro.tex')
  })

  it('gives excerpts through raw, cut from the lines after the headline', () => {
    const log = [
      './main.tex:3: Undefined control sequence.',
      'l.3 \\undefinedmacro',
      '                   ',
      'The control sequence at the end of the top line',
      '',
      './main.tex:5: Missing $ inserted.',
      'l.5 \\end{document}',
    ].join('\n')

    const [first, second] = LatexLogParser.parse(log).errors

    expect(first.raw.split('\n').slice(1)).to.include('l.3 \\undefinedmacro')
    expect(first.raw).to.not.include('Missing $')
    expect(second.line).to.equal(5)
  })

  it('gives a missing file the line of the "Emergency stop." that follows it', () => {
    const log = [
      "! LaTeX Error: File `nosuchpackage.sty' not found.",
      '',
      'Enter file name: ',
      '! Emergency stop.',
      '<read *> ',
      'l.3 \\begin',
      '          {document}^^M',
      '!  ==> Fatal error occurred, no output PDF file produced!',
    ].join('\n')

    const result = LatexLogParser.parse(log)

    expect(result.errors.map(e => [e.line, e.message])).to.deep.equal([
      [3, "LaTeX Error: File `nosuchpackage.sty' not found."],
      [3, 'Emergency stop.'],
    ])
    expect(result.fatal).to.equal(true)
  })

  it('keeps repeated entries when ignoreDuplicates is false', () => {
    const log = [
      './main.tex:3: Undefined control sequence.',
      'l.3 \\foo',
      '',
      './main.tex:3: Undefined control sequence.',
      'l.3 \\foo',
      '',
    ].join('\n')

    expect(LatexLogParser.parse(log).errors).to.have.length(1)
    expect(
      LatexLogParser.parse(log, { ignoreDuplicates: false }).errors
    ).to.have.length(2)
  })

  it('strips the compile directory given in fileBaseNames', () => {
    const log = '/srv/builds/abc/chapters/a.tex:2: Boom.'

    const result = LatexLogParser.parse(log, {
      fileBaseNames: [/srv\/builds\/abc/],
    })

    expect(result.errors[0].file).to.equal('chapters/a.tex')
  })

  it('does not mangle file paths containing "compiles" when using custom fileBaseNames', () => {
    const log = '/srv/compiles/abc/chapters/compiles-notes.tex:2: Boom.'

    const result = LatexLogParser.parse(log, {
      fileBaseNames: [/srv\/compiles\/abc/],
    })

    expect(result.errors[0].file).to.equal('chapters/compiles-notes.tex')
  })
})
