import { expect } from 'chai'
import {
  diffStatsForCall,
  sumDiffStats,
} from '../../../../../frontend/js/features/ai-assist/components/agent/diff-stats'

describe('diffStatsForCall', function () {
  it('returns null for tools other than edit_file/create_file', function () {
    expect(
      diffStatsForCall({ id: '1', name: 'read_file', args: {}, result: {} })
    ).to.equal(null)
  })

  it('returns null while the call is still running', function () {
    expect(
      diffStatsForCall({ id: '1', name: 'edit_file', args: {} })
    ).to.equal(null)
  })

  it('returns null when the call errored', function () {
    expect(
      diffStatsForCall({
        id: '1',
        name: 'edit_file',
        args: {},
        result: { error: 'nope' },
        isError: true,
      })
    ).to.equal(null)
  })

  it('returns null when the edit was rejected rather than applied', function () {
    expect(
      diffStatsForCall({
        id: '1',
        name: 'edit_file',
        args: { path: 'main.tex', oldText: 'a', newText: 'b' },
        result: { status: 'rejected' },
      })
    ).to.equal(null)
  })

  it('counts added and removed lines for an applied edit_file', function () {
    const stats = diffStatsForCall({
      id: '1',
      name: 'edit_file',
      args: {
        path: 'main.tex',
        oldText: 'line one\nline two',
        newText: 'line one\nline two\nline three\nline four',
      },
      result: { status: 'applied' },
    })
    expect(stats).to.deep.equal({ added: 2, removed: 0 })
  })

  it('counts every line as added for an applied create_file', function () {
    const stats = diffStatsForCall({
      id: '1',
      name: 'create_file',
      args: { path: 'new.tex', content: 'a\nb\nc' },
      result: { status: 'applied' },
    })
    expect(stats).to.deep.equal({ added: 3, removed: 0 })
  })

  it('counts both sides of a replacement', function () {
    const stats = diffStatsForCall({
      id: '1',
      name: 'edit_file',
      args: {
        path: 'main.tex',
        oldText: 'old line one\nold line two',
        newText: 'new line one',
      },
      result: { status: 'applied' },
    })
    expect(stats!.removed).to.be.greaterThan(0)
  })
})

describe('sumDiffStats', function () {
  it('returns null when no calls contributed a diff', function () {
    expect(
      sumDiffStats([{ id: '1', name: 'read_file', args: {}, result: {} }])
    ).to.equal(null)
  })

  it('aggregates added/removed across multiple applied edits', function () {
    const calls = [
      {
        id: '1',
        name: 'edit_file',
        args: { path: 'a.tex', oldText: 'x', newText: 'x\ny' },
        result: { status: 'applied' },
      },
      {
        id: '2',
        name: 'create_file',
        args: { path: 'b.tex', content: 'p\nq' },
        result: { status: 'applied' },
      },
    ]
    expect(sumDiffStats(calls)).to.deep.equal({ added: 3, removed: 0 })
  })
})
