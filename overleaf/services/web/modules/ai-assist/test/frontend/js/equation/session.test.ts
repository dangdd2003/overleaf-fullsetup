import { expect } from 'chai'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView, runScopeHandlers } from '@codemirror/view'
import {
  closeEquation,
  equationExtension,
  equationField,
  isPassageStale,
  openEquation,
  openEquationDialog,
  startEquationReview,
} from '../../../../frontend/js/features/ai-assist/equation/session'
import {
  openTexGpt,
  texGptExtension,
  texGptField,
} from '../../../../frontend/js/features/ai-assist/texgpt/target'
import {
  openWritingSession,
  writingSessionField,
  writingToolsExtension,
} from '../../../../frontend/js/features/ai-assist/writing-tools/extension'

function opened(doc: string, from: number, to = from) {
  const state = EditorState.create({ doc, extensions: equationExtension() })
  return state.update({ effects: openEquationDialog.of({ from, to }) }).state
}

function makeView(doc: string, from: number, to = from) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(from, to),
      extensions: [writingToolsExtension(), texGptExtension(), equationExtension()],
    }),
    parent,
  })
}

describe('equation: session', function () {
  afterEach(function () {
    document.body.innerHTML = ''
  })

  it('opens the dialog on the cursor, with no passage or card yet', function () {
    const session = opened('The energy is here.', 13).field(equationField)!
    expect(session).to.include({ phase: 'dialog', keepDraft: false, passage: null, tooltip: null })
    expect(session.anchor).to.deep.equal({ from: 13, to: 13 })
  })

  it('starts the review on a passage, remembering its text, under the same id', function () {
    let state = opened('The energy is here.', 13)
    const id = state.field(equationField)!.id
    state = state.update({ effects: startEquationReview.of({ from: 4, to: 18 }) }).state
    const session = state.field(equationField)!
    expect(session.id).to.equal(id)
    expect(session.phase).to.equal('review')
    expect(session.passage).to.deep.equal({ from: 4, to: 18, original: 'energy is here' })
    expect(session.tooltip).to.include({ above: false, strictSide: true })
  })

  it('gives every opening a new id and keeps the draft flag', function () {
    const first = opened('Text', 1).field(equationField)!.id
    const state = EditorState.create({ doc: 'Text', extensions: equationExtension() }).update({
      effects: openEquationDialog.of({ from: 1, to: 1, keepDraft: true }),
    }).state
    expect(state.field(equationField)!.id).to.be.greaterThan(first)
    expect(state.field(equationField)!.keepDraft).to.equal(true)
  })

  it('follows edits made before the anchor and the passage, by anyone', function () {
    let state = opened('The energy is here.', 13)
    state = state.update({ effects: startEquationReview.of({ from: 4, to: 18 }) }).state
    state = state.update({ changes: { from: 0, insert: '>> ' } }).state
    const session = state.field(equationField)!
    expect(session.anchor).to.deep.equal({ from: 16, to: 16 })
    expect(session.passage).to.include({ from: 7, to: 21 })
    expect(isPassageStale(state, session.passage!)).to.equal(false)
  })

  it('reads an edit inside the passage as stale', function () {
    let state = opened('The energy is here.', 13)
    state = state.update({ effects: startEquationReview.of({ from: 4, to: 18 }) }).state
    state = state.update({ changes: { from: 5, to: 6, insert: 'N' } }).state
    expect(isPassageStale(state, state.field(equationField)!.passage!)).to.equal(true)
  })

  it('keeps text typed at the passage edges outside it', function () {
    let state = opened('The energy is here.', 13)
    state = state.update({ effects: startEquationReview.of({ from: 4, to: 18 }) }).state
    state = state.update({ changes: [{ from: 4, insert: 'X' }, { from: 18, insert: 'Y' }] }).state
    const passage = state.field(equationField)!.passage!
    expect(state.sliceDoc(passage.from, passage.to)).to.equal('energy is here')
  })

  it('closes on closeEquation', function () {
    let state = opened('Text', 1)
    state = state.update({ effects: closeEquation.of(null) }).state
    expect(state.field(equationField)).to.equal(null)
  })

  it('closes on Escape in the text', function () {
    const view = makeView('Text', 1)
    view.dispatch({ effects: openEquationDialog.of({ from: 1, to: 1 }) })
    const handled = runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'Escape' }), 'editor')
    expect(handled).to.equal(true)
    expect(view.state.field(equationField)).to.equal(null)
    view.destroy()
  })

  it('marks the passage and the insertion point while reviewing', function () {
    const view = makeView('The energy is here.', 13)
    view.dispatch({ effects: openEquationDialog.of({ from: 13, to: 13 }) })
    expect(view.dom.querySelector('.ai-equation-target')).to.equal(null)
    view.dispatch({ effects: startEquationReview.of({ from: 4, to: 18 }) })
    expect(view.dom.querySelector('.ai-equation-target')).to.not.equal(null)
    expect(view.dom.querySelector('.ai-equation-caret')).to.not.equal(null)
    view.destroy()
  })

  it('openEquation opens on the selection and closes TeXGPT and Writing tools', function () {
    const view = makeView('We saw a quick result.', 9, 14)
    view.dispatch({
      effects: [
        openTexGpt.of({ from: 9, to: 14 }),
        openWritingSession.of({ from: 9, to: 14, action: 'rephrase' }),
      ],
    })
    openEquation(view)
    expect(view.state.field(texGptField)).to.equal(null)
    expect(view.state.field(writingSessionField)).to.equal(null)
    expect(view.state.field(equationField)!.anchor).to.deep.equal({ from: 9, to: 14 })
    view.destroy()
  })

  it('openEquation can reopen on a given anchor, keeping the draft', function () {
    const view = makeView('Some text here.', 2)
    openEquation(view, { anchor: { from: 5, to: 9 }, keepDraft: true })
    expect(view.state.field(equationField)).to.include({ keepDraft: true })
    expect(view.state.field(equationField)!.anchor).to.deep.equal({ from: 5, to: 9 })
    view.destroy()
  })
})
