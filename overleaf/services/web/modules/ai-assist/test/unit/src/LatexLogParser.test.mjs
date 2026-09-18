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
