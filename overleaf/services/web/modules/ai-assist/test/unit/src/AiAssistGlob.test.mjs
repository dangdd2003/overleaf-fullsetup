import { describe, it } from 'vitest'
import { expect } from 'chai'
import { matchesGlob } from '../../../app/src/AiAssistGlob.mjs'

describe('matchesGlob', function () {
  it('matches the forms the tools document', function () {
    expect(matchesGlob('chapters/intro.tex', '*.tex')).to.be.false
    expect(matchesGlob('chapters/intro.tex', 'chapters/*.tex')).to.be.true
    expect(matchesGlob('chapters/a/intro.tex', 'chapters/*.tex')).to.be.false
    expect(matchesGlob('chapters/a/intro.tex', 'chapters/**/*.tex')).to.be.true
    expect(matchesGlob('intro.tex', '**/*.tex')).to.be.true
    expect(matchesGlob('a/b/c.bib', '**/c.?ib')).to.be.true
    expect(matchesGlob('a(1).tex', 'a(1).tex')).to.be.true
    expect(matchesGlob('axb', 'a.b')).to.be.false
  })

  it('answers a pattern of many stars at once, not exponentially', function () {
    const path = `chapters/${'a'.repeat(200)}.tex`
    const started = Date.now()
    expect(matchesGlob(path, `${'*a'.repeat(30)}b`)).to.be.false
    expect(Date.now() - started).to.be.below(1000)
  })
})
