import { expect } from 'chai'
import { EditorState } from '@codemirror/state'
import {
  closeWritingSession,
  openWritingSession,
  writingSessionField,
  writingToolsExtension,
} from '../../../../frontend/js/features/ai-assist/writing-tools/extension'
import { orderLanguages } from '../../../../frontend/js/features/ai-assist/writing-tools/languages'

function open(doc: string, from: number, to: number) {
  const state = EditorState.create({ doc, extensions: writingToolsExtension() })
  return state.update({
    effects: openWritingSession.of({ from, to, action: 'rephrase' }),
  }).state
}

describe('writing tools: editor session', function () {
  it('opens on the selected range and remembers its text', function () {
    const state = open('Hello brave world', 6, 11)
    const session = state.field(writingSessionField)!
    expect(session).to.include({ from: 6, to: 11, original: 'brave' })
    expect(session.action).to.equal('rephrase')
  })

  it('follows edits made before and inside the range', function () {
    let state = open('Hello brave world', 6, 11)
    state = state.update({ changes: { from: 0, insert: '>> ' } }).state
    expect(state.field(writingSessionField)).to.include({ from: 9, to: 14 })
    state = state.update({ changes: { from: 11, insert: 'XX' } }).state
    expect(state.field(writingSessionField)).to.include({ from: 9, to: 16 })
  })

  it('keeps text typed at either edge outside the range', function () {
    let state = open('Hello brave world', 6, 11)
    state = state.update({ changes: [{ from: 6, insert: 'A' }, { from: 11, insert: 'B' }] }).state
    const session = state.field(writingSessionField)!
    expect(state.sliceDoc(session.from, session.to)).to.equal('brave')
  })

  it('reuses one card container across re-anchoring', function () {
    let state = open('Hello brave world', 6, 11)
    const first = state.field(writingSessionField)!.tooltip
    state = state.update({ changes: { from: 0, insert: '>> ' } }).state
    const second = state.field(writingSessionField)!.tooltip
    expect(second).not.to.equal(first)
    expect(second.create).to.equal(first.create)
    expect(second.pos).to.equal(first.pos + 3)
  })

  it('closes when the target text is deleted, or on request', function () {
    let state = open('Hello brave world', 6, 11)
    expect(
      state.update({ changes: { from: 5, to: 12 } }).state.field(writingSessionField)
    ).to.equal(null)
    state = state.update({ effects: closeWritingSession.of(null) }).state
    expect(state.field(writingSessionField)).to.equal(null)
  })

  it('gives every session a new id', function () {
    const a = open('Hello brave world', 6, 11).field(writingSessionField)!
    const b = open('Hello brave world', 6, 11).field(writingSessionField)!
    expect(b.id).not.to.equal(a.id)
  })
})

describe('writing tools: Translate list', function () {
  it('puts recent languages first and leaves them out of the rest', function () {
    const { recent, others } = orderLanguages(['Vietnamese', 'French'], '')
    expect(recent).to.deep.equal(['Vietnamese', 'French'])
    expect(others).not.to.include('Vietnamese')
    expect(others[0]).to.equal('Albanian')
  })

  it('filters both lists, ignoring case and accents', function () {
    expect(orderLanguages(['Vietnamese'], 'CHIN')).to.deep.equal({
      recent: [],
      others: ['Chinese (Simplified)', 'Chinese (Traditional)'],
    })
    expect(orderLanguages([], 'portugues').others).to.deep.equal([
      'Portuguese',
      'Portuguese (Brazil)',
    ])
  })
})
