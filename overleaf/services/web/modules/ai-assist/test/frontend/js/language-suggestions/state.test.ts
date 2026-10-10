import { expect } from 'chai'
import fetchMock from 'fetch-mock'
import { EditorState } from '@codemirror/state'
import { EditorView, showTooltip } from '@codemirror/view'
import customLocalStorage from '@/infrastructure/local-storage'
import { learnedWords } from '@/features/source-editor/extensions/spelling/learned-words'
import { editsForRewrite } from '../../../../frontend/js/features/ai-assist/language-suggestions/edits'
import {
  blockSuggestion,
  forgetLanguageSuggestionsPreferences,
} from '../../../../frontend/js/features/ai-assist/language-suggestions/preferences'
import {
  ACCEPT_USER_EVENT,
  bringCardToFront,
  closeCard,
  languageSuggestionsField,
  nextSuggestion,
  openCard,
  refreshFilters,
  removeEdits,
  setUnitResults,
  suggestionCount,
  togglePinCard,
  UnitSuggestions,
} from '../../../../frontend/js/features/ai-assist/language-suggestions/state'
import { buildUnits } from '../../../../frontend/js/features/ai-assist/language-suggestions/units'

/** The suggestions for every unit of `doc` that `rewrites` changes. */
function suggestionsFor(doc: string, rewrites: Record<string, string>): UnitSuggestions[] {
  return buildUnits(doc)
    .map(unit => ({
      hash: unit.hash,
      from: unit.from,
      to: unit.to,
      masked: unit.masked,
      edits: rewrites[unit.masked.text]
        ? editsForRewrite(unit.masked, rewrites[unit.masked.text]) ?? []
        : [],
    }))
    .filter(unit => unit.edits.length > 0)
}

function stateWith(doc: string, rewrites: Record<string, string>) {
  return EditorState.create({ doc, extensions: [languageSuggestionsField] }).update({
    effects: setUnitResults.of(suggestionsFor(doc, rewrites)),
  }).state
}

/** The underlined text, in document order. */
function underlined(state: EditorState): string[] {
  const texts: string[] = []
  for (const set of state.facet(EditorView.decorations)) {
    if (typeof set === 'function') continue
    set.between(0, state.doc.length, (from, to) => {
      texts.push(state.sliceDoc(from, to))
    })
  }
  return texts
}

const SENTENCE = 'The results shows that the accuracy improve today.'
const FIXED = 'The results show that the accuracy improves today.'

describe('language suggestions: editor state', function () {
  beforeEach(function () {
    customLocalStorage.clear()
    forgetLanguageSuggestionsPreferences()
    fetchMock.removeRoutes().clearHistory()
    fetchMock.put('/ai-assist/preferences', { preferences: null })
  })

  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
    customLocalStorage.clear()
    forgetLanguageSuggestionsPreferences()
  })

  it('underlines one range per visible edit', function () {
    const state = stateWith(SENTENCE, { [SENTENCE]: FIXED })
    expect(underlined(state)).to.deep.equal(['shows', 'improve'])
    expect(suggestionCount(state.field(languageSuggestionsField))).to.equal(2)
  })

  it('moves with edits made before the sentence', function () {
    const doc = `Intro text is here.\n\n${SENTENCE}`
    let state = stateWith(doc, { [SENTENCE]: FIXED })
    state = state.update({ changes: { from: 0, insert: 'XX ' } }).state
    expect(underlined(state)).to.deep.equal(['shows', 'improve'])
  })

  it("drops a sentence's suggestions as soon as its text changes", function () {
    let state = stateWith(SENTENCE, { [SENTENCE]: FIXED })
    state = state.update({ changes: { from: 4, insert: 'new ' } }).state
    expect(underlined(state)).to.deep.equal([])
    expect(state.field(languageSuggestionsField).units).to.deep.equal([])
  })

  it('keeps them when typing right after the sentence', function () {
    let state = stateWith(SENTENCE, { [SENTENCE]: FIXED })
    state = state.update({ changes: { from: SENTENCE.length, insert: ' More.' } }).state
    expect(underlined(state)).to.deep.equal(['shows', 'improve'])
  })

  it('underlines the word before an insertion', function () {
    const doc = 'We use this however it fails here.'
    const state = stateWith(doc, { [doc]: 'We use this, however it fails here.' })
    expect(underlined(state)).to.deep.equal(['this'])
  })

  it('underlines a removed mark together with its word', function () {
    const doc = 'We use this, however it fails here.'
    const state = stateWith(doc, { [doc]: 'We use this however it fails here.' })
    expect(underlined(state)).to.deep.equal(['this,'])
  })

  it('opens a card under an edit and closes it on any other change', function () {
    let state = stateWith(SENTENCE, { [SENTENCE]: FIXED })
    const [unit] = state.field(languageSuggestionsField).units
    state = state.update({ effects: openCard.of({ hash: unit.hash, from: unit.from, edit: 1 }) }).state
    const card = state.field(languageSuggestionsField).card!
    expect(card.edit).to.equal(1)
    expect(card.tooltip.pos).to.equal(SENTENCE.indexOf('improve'))

    const moved = state.update({
      changes: { from: SENTENCE.length, insert: ' More.' },
      userEvent: ACCEPT_USER_EVENT,
    }).state
    expect(moved.field(languageSuggestionsField).card?.edit).to.equal(1)

    const typed = state.update({ changes: { from: SENTENCE.length, insert: ' More.' } }).state
    expect(typed.field(languageSuggestionsField).card).to.equal(null)

    const closed = state.update({ effects: closeCard.of(null) }).state
    expect(closed.field(languageSuggestionsField).card).to.equal(null)
  })

  it('pins cards so they hold on screen, stack with higher layer on newer pin, and survive clicking elsewhere', function () {
    const S1 = 'The results shows error.'
    const S1_FIXED = 'The results show error.'
    const S2 = 'Also this sentence need fix.'
    const S2_FIXED = 'Also this sentence needs fix.'
    const DOC2 = `${S1} ${S2}`
    let state = stateWith(DOC2, { [S1]: S1_FIXED, [S2]: S2_FIXED })
    const [unit1, unit2] = state.field(languageSuggestionsField).units
    expect(unit1).to.exist
    expect(unit2).to.exist

    // Open card 1 and pin it
    state = state.update({ effects: openCard.of({ hash: unit1.hash, from: unit1.from, edit: 0 }) }).state
    expect(state.field(languageSuggestionsField).cards).to.have.length(1)
    expect(state.field(languageSuggestionsField).cards[0].pinned).to.be.false

    state = state.update({ effects: togglePinCard.of({ hash: unit1.hash, from: unit1.from }) }).state
    const pinned1 = state.field(languageSuggestionsField).cards[0]
    expect(pinned1.pinned).to.be.true
    expect(pinned1.pinOrder).to.be.greaterThan(0)

    // Clicking elsewhere (closeCard.of(null)) does NOT close the pinned card!
    state = state.update({ effects: closeCard.of(null) }).state
    expect(state.field(languageSuggestionsField).cards).to.have.length(1)
    expect(state.field(languageSuggestionsField).cards[0].pinned).to.be.true

    // Typing in the document keeps pinned card holding, with position mapped
    state = state.update({ changes: { from: 0, insert: 'Header. ' } }).state
    expect(state.field(languageSuggestionsField).cards).to.have.length(1)
    expect(state.field(languageSuggestionsField).cards[0].pinned).to.be.true
    expect(state.field(languageSuggestionsField).cards[0].from).to.equal(unit1.from + 'Header. '.length)

    // Open card 2 and pin it -> Card 2 has higher pinOrder than Card 1
    const [mappedUnit1, mappedUnit2] = state.field(languageSuggestionsField).units
    state = state.update({ effects: openCard.of({ hash: mappedUnit2.hash, from: mappedUnit2.from, edit: 0 }) }).state
    expect(state.field(languageSuggestionsField).cards).to.have.length(2)

    state = state.update({ effects: togglePinCard.of({ hash: mappedUnit2.hash, from: mappedUnit2.from }) }).state
    const cards = state.field(languageSuggestionsField).cards
    expect(cards).to.have.length(2)
    const card1 = cards.find(c => c.hash === mappedUnit1.hash)!
    const card2 = cards.find(c => c.hash === mappedUnit2.hash)!
    expect(card1.pinned).to.be.true
    expect(card2.pinned).to.be.true
    expect(card2.pinOrder).to.be.greaterThan(card1.pinOrder) // newer pin is in higher layer!

    // Clicking card 1 brings it to front (higher pinOrder than card 2)
    state = state.update({ effects: bringCardToFront.of({ hash: card1.hash, from: card1.from }) }).state
    const updatedCard1 = state.field(languageSuggestionsField).cards.find(c => c.hash === card1.hash)!
    expect(updatedCard1.pinOrder).to.be.greaterThan(card2.pinOrder)

    // Unpinning card 1 and clicking elsewhere removes card 1 but keeps card 2
    state = state.update({ effects: togglePinCard.of({ hash: card1.hash, from: card1.from }) }).state
    state = state.update({ effects: closeCard.of(null) }).state
    expect(state.field(languageSuggestionsField).cards).to.have.length(1)
    expect(state.field(languageSuggestionsField).cards[0].hash).to.equal(card2.hash)
  })

  it('removes edits, and the sentence with its last edit', function () {
    let state = stateWith(SENTENCE, { [SENTENCE]: FIXED })
    const [unit] = state.field(languageSuggestionsField).units
    state = state.update({ effects: removeEdits.of({ hash: unit.hash, edits: [unit.edits[0]] }) }).state
    expect(underlined(state)).to.deep.equal(['improve'])
    state = state.update({ effects: removeEdits.of({ hash: unit.hash, edits: [unit.edits[1]] }) }).state
    expect(state.field(languageSuggestionsField).units).to.deep.equal([])
  })

  it('hides a blocked edit and moves an open card off it', function () {
    let state = stateWith(SENTENCE, { [SENTENCE]: FIXED })
    const [unit] = state.field(languageSuggestionsField).units
    state = state.update({ effects: openCard.of({ hash: unit.hash, from: unit.from, edit: 0 }) }).state
    blockSuggestion('shows', 'show')
    state = state.update({ effects: refreshFilters.of(null) }).state
    expect(underlined(state)).to.deep.equal(['improve'])
    expect(state.field(languageSuggestionsField).card?.edit).to.equal(1)
  })

  it('hides an edit to a word in the user dictionary', function () {
    learnedWords.global.add('Overleef')
    try {
      const doc = 'We love Overleef very much indeed.'
      const state = stateWith(doc, { [doc]: 'We love Overleaf very much indeed.' })
      expect(underlined(state)).to.deep.equal([])
    } finally {
      learnedWords.global.delete('Overleef')
    }
  })

  it('finds the next and previous suggestion from the cursor, wrapping around', function () {
    const value = stateWith(SENTENCE, { [SENTENCE]: FIXED }).field(languageSuggestionsField)
    const shows = SENTENCE.indexOf('shows')
    const improve = SENTENCE.indexOf('improve')
    expect(nextSuggestion(value, 0, 1)?.from).to.equal(shows)
    expect(nextSuggestion(value, shows, 1)?.from).to.equal(improve)
    expect(nextSuggestion(value, improve, 1)?.from).to.equal(shows)
    expect(nextSuggestion(value, shows, -1)?.from).to.equal(improve)
  })
})
