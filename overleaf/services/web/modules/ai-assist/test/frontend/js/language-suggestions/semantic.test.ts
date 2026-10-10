import { expect } from 'chai'
import {
  contextChanged,
  contextFingerprint,
  moveEdits,
  normalizeForCheck,
} from '../../../../frontend/js/features/ai-assist/language-suggestions/semantic'
import { hashUnit } from '../../../../frontend/js/features/ai-assist/language-suggestions/units'

describe('language suggestions: what counts as a change', function () {
  it('reads spacing, quotes and placeholder numbers the same', function () {
    const a = normalizeForCheck(' The  model [[M1]] uses “data”.\n')
    const b = normalizeForCheck('The model [[M7]]\nuses "data".')
    expect(a.text).to.equal(b.text)
    expect(hashUnit('text', ' The  model [[M1]] uses “data”.')).to.equal(
      hashUnit('text', 'The model [[M7]] uses "data".')
    )
    expect(hashUnit('text', 'The model uses data.')).to.not.equal(hashUnit('text', 'The model use data.'))
    expect(hashUnit('text', 'The model uses data.')).to.not.equal(hashUnit('text', 'The model uses data!'))
  })

  it('moves edits onto a text that reads the same', function () {
    const from = 'The results shows [[M1]] a gain.'
    const to = 'The  results   shows [[M12]] a gain.'
    const edit = { from: 12, to: 17, original: 'shows', insert: 'show' }
    const [moved] = moveEdits([edit], from, to)!
    expect(to.slice(moved.from, moved.to)).to.equal('shows')
    expect(moved.insert).to.equal('show')
    expect(moveEdits([edit], from, 'The results show a gain.')).to.equal(null)
  })

  it('ignores a small change next door, notices a rewritten neighbour', function () {
    const checked = contextFingerprint('We trained the model on three datasets.', 'It took two days.')
    expect(
      contextChanged(checked, contextFingerprint('We trained the model on three data sets.', 'It took two days.'))
    ).to.equal(false)
    expect(
      contextChanged(
        checked,
        contextFingerprint('Nobody expected any improvement from this at first.', 'It took two days.')
      )
    ).to.equal(true)
    // Removing a neighbour changes it; writing a new one where there was none does not
    expect(contextChanged(checked, contextFingerprint(null, 'It took two days.'))).to.equal(true)
    const alone = contextFingerprint('We trained the model on three datasets.', null)
    expect(contextChanged(alone, checked)).to.equal(false)
  })
})
