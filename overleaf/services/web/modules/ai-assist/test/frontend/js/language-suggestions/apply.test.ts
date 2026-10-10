import { expect } from 'chai'
import fetchMock from 'fetch-mock'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history, undo } from '@codemirror/commands'
import customLocalStorage from '@/infrastructure/local-storage'
import {
  acceptEdits,
  rebaseEdits,
  blockEdit,
  rejectEdits,
} from '../../../../frontend/js/features/ai-assist/language-suggestions/apply'
import {
  cacheKey,
  suggestionCache,
} from '../../../../frontend/js/features/ai-assist/language-suggestions/cache'
import { editsForRewrite } from '../../../../frontend/js/features/ai-assist/language-suggestions/edits'
import {
  forgetLanguageSuggestionsPreferences,
  readLanguageSuggestionsPreferences,
  updateLanguageSuggestionsPreferences,
} from '../../../../frontend/js/features/ai-assist/language-suggestions/preferences'
import {
  languageSuggestionsField,
  setUnitResults,
  visibleEdits,
} from '../../../../frontend/js/features/ai-assist/language-suggestions/state'
import { buildUnits } from '../../../../frontend/js/features/ai-assist/language-suggestions/units'

const SENTENCE = 'The results shows that the accuracy improve today.'
const FIXED = 'The results show that the accuracy improves today.'
const CONTEXT = { slot: 'fast' as const, model: 'qwen3:4b', variant: 'en-US' as const, style: true }

function editorWith(doc: string, rewrites: Record<string, string>) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [languageSuggestionsField, history()] }),
    parent,
  })
  const results = buildUnits(doc)
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
  view.dispatch({ effects: setUnitResults.of(results) })
  return view
}

const field = (view: EditorView) => view.state.field(languageSuggestionsField)
const pairs = (view: EditorView) =>
  field(view).units.map(unit => unit.edits.map(e => [e.original, e.insert]))

describe('language suggestions: accept, reject, block', function () {
  beforeEach(function () {
    document.body.innerHTML = ''
    customLocalStorage.clear()
    forgetLanguageSuggestionsPreferences()
    suggestionCache.clear()
    customLocalStorage.setItem('ai-assist:provider', { type: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'k', model: 'claude' })
    customLocalStorage.setItem('ai-assist:fast-provider', {
      type: 'ollama',
      baseUrl: 'http://ollama:11434/v1',
      apiKey: '',
      model: 'qwen3:4b',
    })
    fetchMock.removeRoutes().clearHistory()
    fetchMock.put('/ai-assist/preferences', { preferences: null })
  })

  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
    customLocalStorage.clear()
    forgetLanguageSuggestionsPreferences()
    suggestionCache.clear()
  })

  it('accepts one edit in one undoable step and keeps the others on screen', function () {
    const view = editorWith(SENTENCE, { [SENTENCE]: FIXED })
    const [unit] = field(view).units
    acceptEdits(view, unit.hash, unit.from, [0])
    expect(view.state.doc.toString()).to.equal('The results show that the accuracy improve today.')
    expect(pairs(view)).to.deep.equal([[['improve', 'improves']]])
    expect(field(view).card?.edit).to.equal(0)

    const [next] = field(view).units
    acceptEdits(view, next.hash, next.from, [0])
    expect(view.state.doc.toString()).to.equal(FIXED)
    expect(field(view).units).to.deep.equal([])
    expect(field(view).card).to.equal(null)

    undo(view)
    undo(view)
    expect(view.state.doc.toString()).to.equal(SENTENCE)
    view.destroy()
  })

  it('accepts every edit of a sentence at once', function () {
    const view = editorWith(SENTENCE, { [SENTENCE]: FIXED })
    const [unit] = field(view).units
    acceptEdits(view, unit.hash, unit.from, [0, 1])
    expect(view.state.doc.toString()).to.equal(FIXED)
    undo(view)
    expect(view.state.doc.toString()).to.equal(SENTENCE)
    view.destroy()
  })

  it('remembers the new sentence so accepting never asks the model again', function () {
    const view = editorWith(SENTENCE, { [SENTENCE]: FIXED })
    const [unit] = field(view).units
    acceptEdits(view, unit.hash, unit.from, [0])
    const [next] = field(view).units
    expect(
      suggestionCache.visible(cacheKey(CONTEXT, next.hash))?.map(e => [e.original, e.insert])
    ).to.deep.equal([['improve', 'improves']])
  })

  it('rejects for the rest of the session', function () {
    const view = editorWith(SENTENCE, { [SENTENCE]: FIXED })
    const [unit] = field(view).units
    suggestionCache.set(cacheKey(CONTEXT, unit.hash), { edits: unit.edits, rejected: [] })
    rejectEdits(view, unit.hash, unit.from, [0])
    expect(pairs(view)).to.deep.equal([[['improve', 'improves']]])
    expect(
      suggestionCache.visible(cacheKey(CONTEXT, unit.hash))?.map(e => e.original)
    ).to.deep.equal(['improve'])
    view.destroy()
  })

  it('blocks an edit everywhere', function () {
    const view = editorWith(SENTENCE, { [SENTENCE]: FIXED })
    const [unit] = field(view).units
    blockEdit(view, unit.hash, unit.from, 0)
    expect(readLanguageSuggestionsPreferences().blocked[0]).to.include({
      from: 'shows',
      to: 'show',
    })
    expect(visibleEdits(field(view).units[0]).map(v => v.edit.original)).to.deep.equal([
      'improve',
    ])
    view.destroy()
  })

  it('accepting in one copy of a repeated sentence leaves the other', function () {
    const doc = 'The results shows a gain. The results shows a gain.'
    const view = editorWith(doc, { 'The results shows a gain.': 'The results show a gain.' })
    const second = field(view).units[1]
    acceptEdits(view, second.hash, second.from, [0])
    expect(view.state.doc.toString()).to.equal(
      'The results shows a gain. The results show a gain.'
    )
    expect(field(view).units.map(u => u.from)).to.deep.equal([0])
    view.destroy()
  })
  it('moves a rewording around a correction onto the corrected words once it is taken', function () {
    const done = { from: 12, to: 17, original: 'shows', insert: 'show', kind: 'grammar' as const }
    const around = { from: 0, to: 17, original: 'The results shows', insert: 'These results show', kind: 'style' as const }
    const later = { from: 20, to: 23, original: 'big', insert: 'substantial', kind: 'style' as const }
    expect(rebaseEdits([around, later], [done])).to.deep.equal([
      { ...around, to: 16, original: 'The results show' },
      { ...later, from: 19, to: 22 },
    ])
  })
  it('hides a rewording around a correction until the correction is settled', function () {
    const correction = { from: 12, to: 17, original: 'shows', insert: 'show', kind: 'grammar' as const }
    const around = { from: 0, to: 17, original: 'The results shows', insert: 'These results show', kind: 'style' as const }
    const unit = { ...field(editorWith(SENTENCE, {})), hash: 'h', from: 0, to: 10, masked: buildUnits(SENTENCE)[0].masked }
    expect(visibleEdits({ ...unit, edits: [around, correction] }).map(v => v.edit.kind)).to.deep.equal(['grammar'])
    expect(visibleEdits({ ...unit, edits: [around] }).map(v => v.edit.kind)).to.deep.equal(['style'])
  })
  it('shows only the kind the suggestion options ask for', function () {
    const correction = { from: 12, to: 17, original: 'shows', insert: 'show', kind: 'grammar' as const }
    const around = { from: 0, to: 17, original: 'The results shows', insert: 'These results show', kind: 'style' as const }
    const unit = { ...field(editorWith(SENTENCE, {})), hash: 'h', from: 0, to: 10, masked: buildUnits(SENTENCE)[0].masked, edits: [around, correction] }
    updateLanguageSuggestionsPreferences({ types: 'grammar' })
    expect(visibleEdits(unit).map(v => v.edit.kind)).to.deep.equal(['grammar'])
    // Style alone: the rewording no longer waits for a correction that is hidden
    updateLanguageSuggestionsPreferences({ types: 'style' })
    expect(visibleEdits(unit).map(v => v.edit.kind)).to.deep.equal(['style'])
    updateLanguageSuggestionsPreferences({ types: 'all' })
    expect(visibleEdits(unit).map(v => v.edit.kind)).to.deep.equal(['grammar'])
  })
})
