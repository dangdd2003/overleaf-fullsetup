import { expect } from 'chai'
import { EditorState } from '@codemirror/state'
import {
  composeText,
  diffSegments,
  minimalChanges,
  planReplace,
  TextChange,
} from '../../../../frontend/js/features/ai-assist/writing-tools/apply'

function applyChanges(text: string, changes: TextChange[]): string {
  let out = text
  for (const change of [...changes].reverse()) {
    out = out.slice(0, change.from) + change.insert + out.slice(change.to)
  }
  return out
}

describe('writing tools: minimal-diff apply', function () {
  const pairs: [string, string][] = [
    ['The quick brown fox', 'The slow brown fox'],
    ['Once you are familiar with it', 'After you get comfortable with it'],
    ['a b c', 'a b c d'],
    ['first second', 'second'],
    ['Text with \\cite{a}.', 'Text, with \\cite{a}, here.'],
    ['', 'new'],
  ]

  for (const [original, result] of pairs) {
    it(`turns "${original}" into "${result}"`, function () {
      const prefix = 'PREFIX '
      const doc = prefix + original + ' SUFFIX'
      const changes = minimalChanges(original, result, prefix.length)
      expect(applyChanges(doc, changes)).to.equal(prefix + result + ' SUFFIX')
    })
  }

  it('rewrites only the changed word', function () {
    expect(minimalChanges('The quick brown fox', 'The slow brown fox', 10)).to.deep.equal(
      [{ from: 14, to: 19, insert: 'slow' }]
    )
  })

  it('makes no changes for an identical result', function () {
    expect(minimalChanges('same text', 'same text', 0)).to.deep.equal([])
  })

  it('refuses to apply when the target text changed', function () {
    const state = EditorState.create({ doc: 'Hello brave world' })
    const target = { from: 6, to: 11, original: 'brave' }
    expect(planReplace(state, target, 'bold').ok).to.equal(true)
    expect(
      planReplace(state, { ...target, original: 'bravo' }, 'bold')
    ).to.deep.equal({ ok: false, reason: 'stale' })
  })
})

describe('writing tools: per-phrase keep or take', function () {
  const original = 'To begin, upload the image. Next, insert it into the document.'
  const result = 'First, upload the image. Then place it in the document.'

  it('groups changes split only by a space into one phrase', function () {
    const changes = diffSegments(original, result).filter(
      segment => segment.kind === 'change'
    )
    expect(changes.map(c => [c.original, c.insert])).to.deep.equal([
      ['To begin', 'First'],
      ['Next, insert', 'Then place'],
      ['into', 'in'],
    ])
  })

  it('composes the result, the original, and any mix of the two', function () {
    const segments = diffSegments(original, result)
    expect(composeText(segments, new Set())).to.equal(result)
    expect(composeText(segments, new Set([0, 1, 2]))).to.equal(original)
    expect(composeText(segments, new Set([0]))).to.equal(
      'To begin, upload the image. Then place it in the document.'
    )
  })
  it('groups every change in a sentence as one in sentence units', function () {
    const segments = diffSegments(original, result, 'sentence')
    const groups = new Set(
      segments.flatMap(s => (s.kind === 'change' ? [s.group] : []))
    )
    expect([...groups]).to.deep.equal([0, 1])
    expect(composeText(segments, new Set([1]))).to.equal(
      'First, upload the image. Next, insert it into the document.'
    )
    expect(composeText(segments, new Set([0, 1]))).to.equal(original)
  })

  it('keeps sentences joined across a boundary as one group', function () {
    const segments = diffSegments(
      'We train it. It is fast. Results follow.',
      'We train it, and it is fast. Results follow.',
      'sentence'
    )
    expect(
      segments.filter(s => s.kind === 'change').map(s => s.group)
    ).to.deep.equal([0])
  })
})
