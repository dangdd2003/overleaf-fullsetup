import { expect } from 'chai'
import { ChangeSet, EditorState } from '@codemirror/state'
import { snippet } from '@codemirror/autocomplete'
import {
  aiEdit,
  aiEditGlowExtension,
  aiEditGlowField,
  changedRanges,
  isAiTransaction,
} from '../../../../frontend/js/features/ai-assist/ai-edit-glow/extension'

const create = (doc: string) =>
  EditorState.create({ doc, extensions: aiEditGlowExtension() })

describe('ai edit glow', function () {
  it('ignores edits that are not the AI’s', function () {
    const state = create('Hello world').update({
      changes: { from: 0, insert: 'X' },
    }).state
    expect(state.field(aiEditGlowField)).to.deep.equal([])
  })

  it('holds an AI edit as pending until the view shows it', function () {
    const state = create('Hello world').update({
      changes: { from: 6, to: 11, insert: 'there' },
      annotations: aiEdit.of(true),
    }).state
    const glows = state.field(aiEditGlowField)
    expect(glows).to.have.length(1)
    expect(glows[0]).to.include({ from: 6, to: 11, playing: false })
  })

  it('follows later edits and drops a glow whose text is deleted', function () {
    let state = create('Hello world').update({
      changes: { from: 6, to: 11, insert: 'there' },
      annotations: aiEdit.of(true),
    }).state
    state = state.update({ changes: { from: 0, insert: '>> ' } }).state
    expect(state.field(aiEditGlowField)[0]).to.include({ from: 9, to: 14 })
    state = state.update({ changes: { from: 8, to: 14 } }).state
    expect(state.field(aiEditGlowField)).to.deep.equal([])
  })

  it('marks every changed range of one transaction', function () {
    const state = create('one two three').update({
      changes: [
        { from: 0, to: 3, insert: 'ONE' },
        { from: 8, to: 13, insert: 'THREE' },
      ],
      annotations: aiEdit.of(true),
    }).state
    expect(
      state.field(aiEditGlowField).map(({ from, to }) => [from, to])
    ).to.deep.equal([
      [0, 3],
      [8, 13],
    ])
  })

  it('stands in a neighbouring character for a pure deletion', function () {
    const doc = 'abc def ghi'
    const changes = ChangeSet.of({ from: 3, to: 7 }, doc.length)
    expect(changedRanges(changes, doc.length - 4)).to.deep.equal([
      { from: 3, to: 4 },
    ])
    const atEnd = ChangeSet.of({ from: 7, to: 11 }, doc.length)
    expect(changedRanges(atEnd, 7)).to.deep.equal([{ from: 6, to: 7 }])
  })

  it('recognizes table snippet insertions', function () {
    const state = create('hello\nworld')
    let nextState = state
    snippet('\\begin{table}\n\\end{table}')(
      {
        state,
        dispatch: tr => {
          expect(isAiTransaction(tr)).to.be.true
          nextState = state.update(tr).state
        },
      },
      { label: 'Table' },
      0,
      0
    )
    const glows = nextState.field(aiEditGlowField)
    expect(glows.length).to.be.greaterThan(0)
    expect(glows[0].from).to.equal(0)
    expect(glows[0].to).to.be.greaterThan(0)
  })

  it('recognizes transactions with ai userEvents', function () {
    const tr = create('hello').update({
      changes: { from: 0, insert: 'X' },
      userEvent: 'input.ai-table',
    })
    expect(isAiTransaction(tr)).to.be.true
  })

  it('adds manual glows via markAiGlow', function () {
    const state = create('hello world')
    let nextState = state
    const mockView: any = {
      state,
      dispatch: (tr: any) => {
        nextState = state.update(tr).state
      },
    }
    const { markAiGlow } = require('../../../../frontend/js/features/ai-assist/ai-edit-glow/extension')
    markAiGlow(mockView, [{ from: 0, to: 5 }])
    const glows = nextState.field(aiEditGlowField)
    expect(glows).to.have.length(1)
    expect(glows[0]).to.include({ from: 0, to: 5, playing: false })
  })
})
