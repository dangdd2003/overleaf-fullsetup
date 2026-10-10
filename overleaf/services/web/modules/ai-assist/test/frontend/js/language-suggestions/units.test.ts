import { expect } from 'chai'
import {
  buildUnits,
  hashUnit,
  splitSentences,
  unitAt,
  wordCount,
} from '../../../../frontend/js/features/ai-assist/language-suggestions/units'

describe('language suggestions: units', function () {
  it('splits sentences and keeps academic abbreviations inside them', function () {
    const text =
      'We test e.g. the base case. Results in Fig. [[R1]] are good. Smith et al. found more.'
    expect(splitSentences(text).map(([a, b]) => text.slice(a, b))).to.deep.equal([
      'We test e.g. the base case.',
      'Results in Fig. [[R1]] are good.',
      'Smith et al. found more.',
    ])
  })

  it('makes one unit per sentence, placeholders numbered from 1 in each', function () {
    const doc = 'First $a$ sentence here now. Second $b$ sentence here now. Short one.'
    const units = buildUnits(doc)
    expect(units.map(u => u.masked.text)).to.deep.equal([
      'First [[M1]] sentence here now.',
      'Second [[M1]] sentence here now.',
    ])
    expect(units[1].masked.placeholders[0].source).to.equal('$b$')
    expect(doc.slice(units[1].from, units[1].to)).to.equal(
      'Second $b$ sentence here now.'
    )
  })

  it('skips sentences that are mostly LaTeX', function () {
    expect(buildUnits('$a$, $b$, $c$, $d$ and the end.')).to.deep.equal([])
  })

  it('records the paragraph and the kind of text', function () {
    const units = buildUnits(
      'Para one is here.\n\nPara two is here.\n\\caption{A caption is here.}'
    )
    expect(units.map(u => [u.paragraph, u.container])).to.deep.equal([
      [0, 'text'],
      [1, 'text'],
      [2, 'caption'],
    ])
  })

  it('hashes by text and kind of text', function () {
    expect(hashUnit('text', 'A b c.')).to.equal(hashUnit('text', 'A b c.'))
    expect(hashUnit('text', 'A b c.')).to.not.equal(hashUnit('caption', 'A b c.'))
    expect(hashUnit('text', 'A b c.')).to.not.equal(hashUnit('text', 'A b d.'))
  })

  it('counts words, not placeholders', function () {
    expect(wordCount('A [[M1]] b, c.')).to.equal(3)
  })

  it('finds the unit at a position', function () {
    const doc = 'One sentence is here. Another sentence is here.'
    const units = buildUnits(doc)
    expect(unitAt(units, doc.indexOf('Another') + 2)?.masked.text).to.equal(
      'Another sentence is here.'
    )
    expect(unitAt(units, doc.length + 5)).to.equal(undefined)
  })
})
