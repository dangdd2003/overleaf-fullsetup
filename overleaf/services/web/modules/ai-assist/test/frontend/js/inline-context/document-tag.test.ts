import { expect } from 'chai'
import {
  documentTag,
  MAX_PACKAGES_LISTED,
} from '../../../../frontend/js/features/ai-assist/inline-context/document-tag'

describe('inline context: document tag', function () {
  it('writes the shared facts first, then the feature attributes', function () {
    expect(
      documentTag(
        {
          docClass: 'article',
          language: 'english',
          packages: ['amsmath', 'booktabs'],
          macros: ['\\R'],
        },
        [
          ['label_style', 'eq:'],
          ['envs', 'equation:2'],
        ]
      )
    ).to.equal(
      '<document class="article" language="english" packages="amsmath booktabs" macros="\\R" label_style="eq:" envs="equation:2" />'
    )
  })

  it('escapes every value', function () {
    expect(documentTag({ language: 'a"b' }, [['section', '<A & B>']])).to.equal(
      '<document language="a&quot;b" section="&lt;A &amp; B&gt;" />'
    )
  })

  it('leaves out empty values, and returns null when nothing is left', function () {
    expect(
      documentTag({ docClass: null, packages: [], macros: [] }, [['envs', '']])
    ).to.equal(null)
    expect(documentTag({ macros: ['\\R'] })).to.equal('<document macros="\\R" />')
  })

  it('lists at most MAX_PACKAGES_LISTED packages', function () {
    const packages = Array.from(
      { length: MAX_PACKAGES_LISTED + 10 },
      (_, i) => `p${i}`
    )
    const tag = documentTag({ packages })!
    expect(tag).to.include(`p${MAX_PACKAGES_LISTED - 1}"`)
    expect(tag).not.to.include(`p${MAX_PACKAGES_LISTED} `)
  })
})
