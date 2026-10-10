import { expect } from 'chai'
import fetchMock from 'fetch-mock'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView, runScopeHandlers } from '@codemirror/view'
import customLocalStorage from '@/infrastructure/local-storage'
import { inlineSuggestionsExtension } from '../../../../frontend/js/features/ai-assist/inline-suggestion/extension'
import { inlinePopupField } from '../../../../frontend/js/features/ai-assist/inline-suggestion/popup-field'
import {
  forgetInlineSuggestionsPreferences,
  updateInlineSuggestionsPreferences,
} from '../../../../frontend/js/features/ai-assist/inline-suggestion/preferences'

function viewAt(doc: string, cursor: number) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(cursor),
      extensions: inlineSuggestionsExtension(),
    }),
    parent,
  })
}

function press(view: EditorView, key: string, shiftKey = false) {
  return runScopeHandlers(view, new KeyboardEvent('keydown', { key, shiftKey }), 'editor')
}

describe('inline suggestions: editor keys', function () {
  beforeEach(function () {
    customLocalStorage.clear()
    forgetInlineSuggestionsPreferences()
    fetchMock.removeRoutes().clearHistory()
    fetchMock.put('/ai-assist/preferences', { preferences: null })
  })

  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
    customLocalStorage.clear()
    forgetInlineSuggestionsPreferences()
    document.body.innerHTML = ''
  })

  it('with both switches off, Space, Shift+Space and Tab are untouched', function () {
    const view = viewAt('Intro\n\nMore', 6)
    expect(press(view, ' ')).to.equal(false)
    expect(press(view, ' ', true)).to.equal(false)
    expect(press(view, 'Tab')).to.equal(false)
    view.destroy()
  })

  it('Space on an empty line opens the bar once the switch is on', function () {
    updateInlineSuggestionsPreferences({ emptyLineShortcut: true })
    const view = viewAt('Intro\n\nMore', 6)
    expect(press(view, ' ')).to.equal(true)
    expect(view.state.field(inlinePopupField)).to.include({ pos: 6, mode: 'prompt' })
    view.destroy()
  })

  it('Shift+Space asks for a completion once the switch is on', function () {
    updateInlineSuggestionsPreferences({ completionMode: 'manual' })
    customLocalStorage.removeItem('ai-assist:provider')
    const view = viewAt('Our method', 10)
    expect(press(view, ' ', true)).to.equal(true)
    // No provider in this test: it says so at the cursor
    expect(view.state.field(inlinePopupField)!.notice).to.deep.equal({ name: 'noProvider' })
    view.destroy()
  })
})
