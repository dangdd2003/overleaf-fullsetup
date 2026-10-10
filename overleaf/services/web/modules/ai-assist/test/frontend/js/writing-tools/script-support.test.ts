import { expect } from 'chai'
import { scriptWarning } from '../../../../frontend/js/features/ai-assist/writing-tools/script-support'

const ARTICLE = '\\documentclass{article}\n'

describe('writing tools: script support', function () {
  it('warns when the document loads nothing for a CJK script', function () {
    expect(scriptWarning('Chinese (Simplified)', ARTICLE + '\\usepackage{amsmath}')).to.deep.equal({
      kind: 'script',
      message:
        'Chinese (Simplified) text may not compile here: the document loads nothing for its script (for example xeCJK or ctex).',
    })
    expect(scriptWarning('Japanese', ARTICLE + '\\usepackage{fontspec}')?.kind).to.equal('script')
  })

  it('accepts the packages and classes that typeset CJK', function () {
    expect(scriptWarning('Chinese (Simplified)', ARTICLE + '\\usepackage{xeCJK}')).to.equal(null)
    expect(scriptWarning('Korean', ARTICLE + '\\usepackage[UTF8]{ctex}')).to.equal(null)
    expect(scriptWarning('Chinese (Traditional)', '\\documentclass{ctexart}')).to.equal(null)
  })

  it('accepts babel, fontenc, fontspec or polyglossia for other scripts', function () {
    expect(scriptWarning('Russian', ARTICLE + '\\usepackage[T2A]{fontenc}')).to.equal(null)
    expect(scriptWarning('Ukrainian', ARTICLE + '\\usepackage[ukrainian,english]{babel}')).to.equal(null)
    expect(scriptWarning('Vietnamese', ARTICLE + '\\usepackage{vietnam}')).to.equal(null)
    expect(
      scriptWarning('Greek', ARTICLE + '\\usepackage{polyglossia}\n\\setotherlanguage{greek}')
    ).to.equal(null)
    expect(scriptWarning('Arabic', ARTICLE + '\\usepackage{fontspec}')).to.equal(null)
    expect(scriptWarning('Russian', ARTICLE)?.kind).to.equal('script')
  })

  it('says nothing for Latin-script languages or for a file without \\documentclass', function () {
    expect(scriptWarning('French', ARTICLE)).to.equal(null)
    expect(scriptWarning('Vietnamese', '\\section{Intro}\nText')).to.equal(null)
    expect(scriptWarning(undefined, ARTICLE)).to.equal(null)
  })

  it('ignores packages in comments', function () {
    expect(scriptWarning('Japanese', ARTICLE + '% \\usepackage{xeCJK}')?.kind).to.equal('script')
  })
})
