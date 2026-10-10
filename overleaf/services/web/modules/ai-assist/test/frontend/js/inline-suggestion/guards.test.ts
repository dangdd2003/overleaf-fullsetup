import { expect } from 'chai'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { canTriggerAt } from '../../../../frontend/js/features/ai-assist/inline-suggestion/guards'
import {
  inlinePopupExtension,
  openInlinePopup,
} from '../../../../frontend/js/features/ai-assist/inline-suggestion/popup-field'
import { openTexGpt, texGptExtension } from '../../../../frontend/js/features/ai-assist/texgpt/target'
import {
  openWritingSession,
  writingToolsExtension,
} from '../../../../frontend/js/features/ai-assist/writing-tools/extension'

function makeView(
  doc: string,
  selection: EditorSelection,
  extra: any[] = []
) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    state: EditorState.create({
      doc,
      selection,
      extensions: [
        EditorState.allowMultipleSelections.of(true),
        texGptExtension(),
        writingToolsExtension(),
        inlinePopupExtension(),
        ...extra,
      ],
    }),
    parent,
  })
}

describe('inline suggestions: guards', function () {
  afterEach(function () {
    document.body.innerHTML = ''
  })

  it('allows a single cursor in an editable editor', function () {
    const view = makeView('Text', EditorSelection.single(4))
    expect(canTriggerAt(view)).to.equal(true)
    view.destroy()
  })

  it('refuses a selection and several cursors', function () {
    const selected = makeView('Text', EditorSelection.single(0, 4))
    expect(canTriggerAt(selected)).to.equal(false)
    selected.destroy()
    const many = makeView(
      'Text',
      EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(3)])
    )
    expect(canTriggerAt(many)).to.equal(false)
    many.destroy()
  })

  it('refuses a read-only editor', function () {
    const readOnly = makeView('Text', EditorSelection.single(4), [EditorState.readOnly.of(true)])
    expect(canTriggerAt(readOnly)).to.equal(false)
    readOnly.destroy()
    const notEditable = makeView('Text', EditorSelection.single(4), [EditorView.editable.of(false)])
    expect(canTriggerAt(notEditable)).to.equal(false)
    notEditable.destroy()
  })

  it('refuses Vim normal mode, allows insert mode', function () {
    const view = makeView('Text', EditorSelection.single(4))
    ;(view as any).cm = { state: { vim: { insertMode: false } } }
    expect(canTriggerAt(view)).to.equal(false)
    ;(view as any).cm.state.vim.insertMode = true
    expect(canTriggerAt(view)).to.equal(true)
    view.destroy()
  })

  it('refuses while another AI popup is open', function () {
    const withTexGpt = makeView('Text', EditorSelection.single(4))
    withTexGpt.dispatch({ effects: openTexGpt.of({ from: 4, to: 4 }) })
    expect(canTriggerAt(withTexGpt)).to.equal(false)
    withTexGpt.destroy()

    const withCard = makeView('Some text', EditorSelection.single(9))
    withCard.dispatch({ effects: openWritingSession.of({ from: 0, to: 4, action: 'rephrase' }) })
    expect(canTriggerAt(withCard)).to.equal(false)
    withCard.destroy()

    const withPopup = makeView('Text', EditorSelection.single(4))
    withPopup.dispatch({ effects: openInlinePopup.of({ pos: 4, mode: 'notice', notice: { name: 'consent' } }) })
    expect(canTriggerAt(withPopup)).to.equal(false)
    withPopup.destroy()
  })
})
