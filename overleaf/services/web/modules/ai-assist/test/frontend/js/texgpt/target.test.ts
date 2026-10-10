import { expect } from 'chai'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView, runScopeHandlers } from '@codemirror/view'
import {
  closeTexGpt,
  isStale,
  openTexGpt,
  setTexGptBlock,
  texGptExtension,
  texGptField,
  TexGptRange,
} from '../../../../frontend/js/features/ai-assist/texgpt/target'

function open(doc: string, from: number, to = from) {
  const state = EditorState.create({ doc, extensions: texGptExtension() })
  return state.update({ effects: openTexGpt.of({ from, to }) }).state
}

describe('texgpt: target', function () {
  it('inserts at the cursor when nothing is selected', function () {
    expect(open('Hello world', 5).field(texGptField)).to.deep.equal({
      target: { mode: 'insert', pos: 5 },
      block: null,
    })
  })

  it('replaces a selection and remembers its text', function () {
    expect(open('Hello brave world', 6, 11).field(texGptField)!.target).to.deep.equal({
      mode: 'replace',
      from: 6,
      to: 11,
      original: 'brave',
    })
  })

  it('follows edits made before the target, by anyone', function () {
    let state = open('Hello brave world', 6, 11)
    state = state.update({ changes: { from: 0, insert: '>> ' } }).state
    expect(state.field(texGptField)!.target).to.include({ from: 9, to: 14 })
    let insert = open('Hello world', 5)
    insert = insert.update({ changes: { from: 0, insert: '>> ' } }).state
    expect(insert.field(texGptField)!.target).to.deep.equal({
      mode: 'insert',
      pos: 8,
    })
  })

  it('keeps text typed at the edges outside, and reads a deleted target as stale', function () {
    let state = open('Hello brave world', 6, 11)
    state = state.update({
      changes: [
        { from: 6, insert: 'A' },
        { from: 11, insert: 'B' },
      ],
    }).state
    const target = state.field(texGptField)!.target as TexGptRange
    expect(state.sliceDoc(target.from, target.to)).to.equal('brave')
    expect(isStale(state, target)).to.equal(false)

    state = state.update({ changes: { from: 5, to: 14 } }).state
    const gone = state.field(texGptField)!.target as TexGptRange
    expect(gone.to).to.equal(gone.from)
    expect(isStale(state, gone)).to.equal(true)
  })

  it('moves the insertion point with the cursor, but never a selection target', function () {
    let state = open('Hello world', 5)
    state = state.update({ selection: EditorSelection.cursor(11) }).state
    expect(state.field(texGptField)!.target).to.deep.equal({
      mode: 'insert',
      pos: 11,
    })
    let replace = open('Hello brave world', 6, 11)
    replace = replace.update({ selection: EditorSelection.cursor(0) }).state
    expect(replace.field(texGptField)!.target).to.include({ from: 6, to: 11 })
  })

  it('holds a generator block, mapped like the target, until cleared or closed', function () {
    let state = open('\\title{Old}\nText', 16)
    state = state.update({
      effects: setTexGptBlock.of({ from: 7, to: 10, original: 'Old' }),
    }).state
    state = state.update({ changes: { from: 0, insert: '% x\n' } }).state
    expect(state.field(texGptField)!.block).to.deep.equal({
      from: 11,
      to: 14,
      original: 'Old',
    })
    state = state.update({ effects: setTexGptBlock.of(null) }).state
    expect(state.field(texGptField)!.block).to.equal(null)
    state = state.update({ effects: closeTexGpt.of(null) }).state
    expect(state.field(texGptField)).to.equal(null)
  })

  it('marks the target in the text and closes on Escape', function () {
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({
      state: EditorState.create({
        doc: 'Hello world',
        extensions: texGptExtension(),
      }),
      parent,
    })
    view.dispatch({ effects: openTexGpt.of({ from: 5, to: 5 }) })
    expect(view.contentDOM.querySelector('.ai-texgpt-caret')).to.not.equal(null)
    view.dispatch({ effects: openTexGpt.of({ from: 0, to: 5 }) })
    expect(
      view.contentDOM.querySelector('.ai-texgpt-target')?.textContent
    ).to.equal('Hello')
    runScopeHandlers(
      view,
      new KeyboardEvent('keydown', { key: 'Escape' }),
      'editor'
    )
    expect(view.state.field(texGptField)).to.equal(null)
    view.destroy()
    parent.remove()
  })
})
