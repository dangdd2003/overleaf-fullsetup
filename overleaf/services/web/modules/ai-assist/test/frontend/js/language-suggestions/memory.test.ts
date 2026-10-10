import { expect } from 'chai'
import customLocalStorage from '@/infrastructure/local-storage'
import {
  DISMISS_LIMIT,
  dismissedOften,
  forgetAnswers,
  noteAccepted,
  noteDismissed,
  undoesAccepted,
} from '../../../../frontend/js/features/ai-assist/language-suggestions/memory'

const edit = (original: string, insert: string) => ({ from: 0, to: original.length, original, insert })

describe('language suggestions: remembered answers', function () {
  beforeEach(function () {
    customLocalStorage.clear()
    forgetAnswers()
  })

  it('hides a suggestion that would undo an accepted one, across reloads', function () {
    noteAccepted([edit('which', 'that')])
    expect(undoesAccepted(edit('that', 'which'))).to.equal(true)
    expect(undoesAccepted(edit('which', 'that'))).to.equal(false)
    forgetAnswers()
    expect(undoesAccepted(edit('that', 'which'))).to.equal(true)
  })

  it(`hides a change dismissed ${DISMISS_LIMIT} times`, function () {
    for (let i = 1; i < DISMISS_LIMIT; i++) noteDismissed([edit('data is', 'data are')])
    expect(dismissedOften(edit('data is', 'data are'))).to.equal(false)
    noteDismissed([edit('data  is', 'data are')])
    forgetAnswers()
    expect(dismissedOften(edit('data is', 'data are'))).to.equal(true)
    expect(dismissedOften(edit('data is', 'data were'))).to.equal(false)
  })
})
