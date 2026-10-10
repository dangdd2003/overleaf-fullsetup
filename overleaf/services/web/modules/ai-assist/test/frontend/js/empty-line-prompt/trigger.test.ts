import { expect } from 'chai'
import fetchMock from 'fetch-mock'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import customLocalStorage from '@/infrastructure/local-storage'
import { hintLineAt } from '../../../../frontend/js/features/ai-assist/empty-line-prompt/hint'
import { openPromptOnSpace } from '../../../../frontend/js/features/ai-assist/empty-line-prompt/trigger'
import { inlineSuggestionEngine } from '../../../../frontend/js/features/ai-assist/inline-suggestion/engine'
import {
  inlinePopupExtension,
  inlinePopupField,
  openInlinePopup,
} from '../../../../frontend/js/features/ai-assist/inline-suggestion/popup-field'
import {
  forgetInlineSuggestionsPreferences,
  updateInlineSuggestionsPreferences,
} from '../../../../frontend/js/features/ai-assist/inline-suggestion/preferences'

// "Intro\n\nMore": the empty line starts at 6
const DOC = 'Intro\n\nMore'

function stateAt(cursor: number, extra: any[] = []) {
  return EditorState.create({
    doc: DOC,
    selection: EditorSelection.single(cursor),
    extensions: [inlineSuggestionEngine(), inlinePopupExtension(), ...extra],
  })
}

function viewAt(cursor: number) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({ state: stateAt(cursor), parent })
}

describe('empty-line prompt: hint and Space', function () {
  beforeEach(function () {
    customLocalStorage.clear()
    forgetInlineSuggestionsPreferences()
    fetchMock.removeRoutes().clearHistory()
    fetchMock.put('/ai-assist/preferences', { preferences: null })
    updateInlineSuggestionsPreferences({ emptyLineShortcut: true })
  })

  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
    customLocalStorage.clear()
    forgetInlineSuggestionsPreferences()
    document.body.innerHTML = ''
  })

  it('hints on the empty line holding the cursor', function () {
    expect(hintLineAt(stateAt(6), true)).to.equal(6)
    expect(hintLineAt(stateAt(3), true)).to.equal(null)
  })

  it('no hint when read-only or unfocused, or with the setting off', function () {
    expect(hintLineAt(stateAt(6, [EditorState.readOnly.of(true)]), true)).to.equal(null)
    expect(hintLineAt(stateAt(6), false)).to.equal(null)
    updateInlineSuggestionsPreferences({ emptyLineShortcut: false })
    expect(hintLineAt(stateAt(6), true)).to.equal(null)
  })

  it('no hint while the bar is open', function () {
    const state = stateAt(6).update({ effects: openInlinePopup.of({ pos: 6, mode: 'prompt' }) }).state
    expect(hintLineAt(state, true)).to.equal(null)
  })

  it('Space on an empty line opens the bar and types nothing', function () {
    const view = viewAt(6)
    expect(openPromptOnSpace(view)).to.equal(true)
    expect(view.state.field(inlinePopupField)).to.include({ pos: 6, mode: 'prompt' })
    expect(view.state.doc.toString()).to.equal(DOC)
    view.destroy()
  })

  it('Space types a space on a line with text, or with the setting off', function () {
    const onText = viewAt(3)
    expect(openPromptOnSpace(onText)).to.equal(false)
    onText.destroy()
    updateInlineSuggestionsPreferences({ emptyLineShortcut: false })
    const off = viewAt(6)
    expect(openPromptOnSpace(off)).to.equal(false)
    off.destroy()
  })
})
