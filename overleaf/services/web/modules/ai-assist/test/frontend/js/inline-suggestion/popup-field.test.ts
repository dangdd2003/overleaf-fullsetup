import { expect } from 'chai'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView, runScopeHandlers } from '@codemirror/view'
import {
  inlinePopupExtension,
  inlinePopupField,
  openInlinePopup,
} from '../../../../frontend/js/features/ai-assist/inline-suggestion/popup-field'

function stateAt(doc: string, cursor: number) {
  return EditorState.create({
    doc,
    selection: EditorSelection.single(cursor),
    extensions: inlinePopupExtension(),
  })
}

// "Intro\n\nMore": the empty line starts at 6
const DOC = 'Intro\n\nMore'

describe('inline suggestions: popup field', function () {
  it('opens at the position with its mode, notice and prompt', function () {
    const state = stateAt(DOC, 6).update({
      effects: openInlinePopup.of({ pos: 6, mode: 'prompt', prompt: 'a table' }),
    }).state
    const popup = state.field(inlinePopupField)!
    expect(popup).to.include({ pos: 6, mode: 'prompt', notice: null, prompt: 'a table' })
    expect(popup.tooltip.pos).to.equal(6)
  })

  it('closes the prompt bar once its line is no longer empty', function () {
    let state = stateAt(DOC, 6).update({ effects: openInlinePopup.of({ pos: 6, mode: 'prompt' }) }).state
    state = state.update({ changes: { from: 6, insert: 'x' } }).state
    expect(state.field(inlinePopupField)).to.equal(null)
  })

  it('follows an edit on another line', function () {
    let state = stateAt(DOC, 6).update({ effects: openInlinePopup.of({ pos: 6, mode: 'prompt' }) }).state
    state = state.update({ changes: { from: 0, insert: '>> ' } }).state
    expect(state.field(inlinePopupField)!.pos).to.equal(9)
    expect(state.field(inlinePopupField)!.tooltip.pos).to.equal(9)
  })

  it('closes a notice on any edit', function () {
    let state = stateAt(DOC, 5).update({
      effects: openInlinePopup.of({ pos: 5, mode: 'notice', notice: { name: 'consent' } }),
    }).state
    state = state.update({ changes: { from: 0, insert: '>> ' } }).state
    expect(state.field(inlinePopupField)).to.equal(null)
  })

  it('closes when the cursor moves away', function () {
    let state = stateAt(DOC, 6).update({ effects: openInlinePopup.of({ pos: 6, mode: 'prompt' }) }).state
    state = state.update({ selection: { anchor: 2 } }).state
    expect(state.field(inlinePopupField)).to.equal(null)
  })

  it('Esc in the editor closes it', function () {
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({ state: stateAt(DOC, 5), parent })
    view.dispatch({ effects: openInlinePopup.of({ pos: 5, mode: 'notice', notice: { name: 'noProvider' } }) })
    const handled = runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'Escape' }), 'editor')
    expect(handled).to.equal(true)
    expect(view.state.field(inlinePopupField)).to.equal(null)
    view.destroy()
    document.body.innerHTML = ''
  })
})
