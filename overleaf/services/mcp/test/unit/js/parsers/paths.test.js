import { expect } from 'chai'
import {
  globMatcher,
  normalisePath,
  requireFilePath,
} from '../../../../src/parsers/paths.js'

describe('normalisePath', function () {
  it('adds a leading slash and drops empty and . segments', function () {
    expect(normalisePath('main.tex')).to.equal('/main.tex')
    expect(normalisePath('./chapters//intro.tex/')).to.equal('/chapters/intro.tex')
  })

  it('accepts backslashes and surrounding quotes', function () {
    expect(normalisePath('\\chapters\\intro.tex')).to.equal('/chapters/intro.tex')
    expect(normalisePath('"/main.tex"')).to.equal('/main.tex')
  })

  it('resolves a .. that stays inside the project', function () {
    expect(normalisePath('/a/b/../c.tex')).to.equal('/a/c.tex')
  })

  it('refuses a .. that would leave the project root', function () {
    expect(() => normalisePath('../secrets.tex')).to.throw().with.property('code', 'validation_error')
  })

  it('maps an empty value to the root', function () {
    expect(normalisePath('')).to.equal('/')
  })
})

describe('requireFilePath', function () {
  it('rejects a missing path and the root', function () {
    expect(() => requireFilePath('')).to.throw(/path is required/)
    expect(() => requireFilePath('/')).to.throw(/not the project root/)
  })

  it('names the parameter in its message', function () {
    expect(() => requireFilePath(undefined, 'oldPath')).to.throw(/oldPath is required/)
  })
})

describe('globMatcher', function () {
  it('matches a bare pattern against the file name at any depth', function () {
    const match = globMatcher('*.tex')
    expect(match('/main.tex')).to.be.true
    expect(match('/a/b/intro.tex')).to.be.true
    expect(match('/refs.bib')).to.be.false
  })

  it('matches a pattern with a slash against the full path', function () {
    const match = globMatcher('figures/*.png')
    expect(match('/figures/a.png')).to.be.true
    expect(match('/figures/sub/a.png')).to.be.false
  })

  it('lets ** cross folders, including zero of them', function () {
    expect(globMatcher('figures/**')('/figures/x/y.png')).to.be.true
    expect(globMatcher('**/*.tex')('/main.tex')).to.be.true
    expect(globMatcher('**/*.tex')('/c/d.tex')).to.be.true
  })

  it('is case-insensitive', function () {
    expect(globMatcher('MAIN.TEX')('/main.tex')).to.be.true
  })

  it('needs `**/` to end in a slash when it matches anything', function () {
    expect(globMatcher('a/**/b.tex')('/a/x/y/b.tex')).to.be.true
    expect(globMatcher('a/**/b.tex')('/a/b.tex')).to.be.true
    expect(globMatcher('a/**/b.tex')('/ax/b.tex')).to.be.false
  })

  it('stays fast on a glob of many stars against a long name', function () {
    const started = Date.now()
    const match = globMatcher(`${'*a'.repeat(40)}b`)
    expect(match(`/${'a'.repeat(5000)}`)).to.be.false
    expect(Date.now() - started).to.be.below(1000)
  })
})
