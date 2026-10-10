import { expect } from 'chai'
import {
  alignEdges,
  editStats,
  guardPassage,
  keysIn,
  normalizeSlots,
} from '../../../../frontend/js/features/ai-assist/equation/checks'

describe('equation: checks', function () {
  it('normalises the slot spelling', function () {
    expect(normalizeSlots('a<equation />b<equation/>')).to.equal('a<equation/>b<equation/>')
  })

  it('reads every key of cite, ref and label commands', function () {
    expect([...keysIn('see \\cite{a, b} and \\eqref{eq:x}, \\label{sec:y}')]).to.deep.equal([
      'a',
      'b',
      'eq:x',
      'sec:y',
    ])
  })

  it('drops a newline the model put at an edge', function () {
    expect(alignEdges('\nby<equation/> x.\n', 'by<equation/> x.')).to.equal('by<equation/> x.')
    expect(alignEdges('\nby<equation/>', '\nby<equation/>')).to.equal('\nby<equation/>')
  })

  it('counts edits as runs of changed words', function () {
    expect(editStats('where a is', 'where $a$ is')).to.deep.equal({ hunks: 1, words: 2 })
    expect(editStats('a b c d', 'a B c D')).to.deep.equal({ hunks: 2, words: 4 })
    expect(editStats('same', 'same')).to.deep.equal({ hunks: 0, words: 0 })
  })

  it('accepts a passage with one slot and every key', function () {
    expect(
      guardPassage(
        { before: 'As \\cite{k} shows, it is', after: ' where a is.' },
        'As \\cite{k} shows, it is<equation/> where $a$ is.'
      )
    ).to.deep.equal({ ok: true, editCount: 1, changedWords: 2 })
  })

  it('rejects a missing or doubled slot', function () {
    const result = guardPassage({ before: 'a', after: 'b' }, 'ab')
    expect(result.ok).to.equal(false)
    expect(guardPassage({ before: 'a', after: 'b' }, 'a<equation/><equation/>b').ok).to.equal(false)
  })

  it('rejects a passage that lost a key', function () {
    const result = guardPassage({ before: 'As \\cite{k} shows', after: '.' }, 'As shown<equation/>.')
    expect(result).to.deep.equal({ ok: false, problems: ['Keep these keys: k.'] })
  })

  it('refuses more than 12 changed words around the equation', function () {
    const after = ' one two three four five six seven.'
    const rewritten = ' uno dos tres cuatro cinco seis siete.'
    const result = guardPassage({ before: 'It is', after }, `It is<equation/>${rewritten}`)
    expect(result).to.deep.equal({
      ok: false,
      problems: ['Change at most 12 words around the equation.'],
    })
  })

  it('refuses broken braces, new environments, comments and blank lines', function () {
    const original = { before: 'As \\emph{shown} it is', after: ' clear.' }
    for (const reply of [
      'As \\emph{shown it is<equation/> clear.',
      'As \\emph{shown} it is<equation/> \\begin{itemize} clear.',
      'As \\emph{shown} it is<equation/> clear. % note',
      'As \\emph{shown} it is\n\n<equation/> clear.',
    ]) {
      expect(guardPassage(original, reply).ok, reply).to.equal(false)
    }
  })

  it('still accepts small edits that keep the structure', function () {
    expect(
      guardPassage(
        { before: 'The energy is given by\n', after: '\nwhere m is the mass.' },
        'The energy is given by\n<equation/>\nwhere $m$ is the mass.'
      )
    ).to.deep.equal({ ok: true, editCount: 1, changedWords: 2 })
  })
})
