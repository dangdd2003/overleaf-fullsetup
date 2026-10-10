import { expect } from 'chai'
import { EditorState } from '@codemirror/state'
import {
  insertBelowChange,
  insertChange,
  isBlock,
  preambleChange,
} from '../../../../frontend/js/features/ai-assist/texgpt/insert'
import { TextChange } from '../../../../frontend/js/features/ai-assist/writing-tools/apply'

const state = (doc: string) => EditorState.create({ doc })

function apply(doc: string, change: TextChange) {
  return doc.slice(0, change.from) + change.insert + doc.slice(change.to)
}

describe('texgpt: insert', function () {
  it('tells blocks from inline snippets', function () {
    expect(isBlock('$\\alpha$')).to.equal(false)
    expect(isBlock('\\textbf{x}')).to.equal(false)
    expect(isBlock('\\section{Intro}')).to.equal(true)
    expect(isBlock('\\begin{table}x\\end{table}')).to.equal(true)
    expect(isBlock('a\nb')).to.equal(true)
  })

  it('inserts inline code as is, mid-line', function () {
    const doc = 'Let  be.'
    expect(apply(doc, insertChange(state(doc), 4, ' $x$ '))).to.equal(
      'Let $x$ be.'
    )
  })

  it('puts a block on its own lines', function () {
    const block = '\\begin{itemize}\n\\item A\n\\end{itemize}\n'
    const doc = 'Before after.'
    expect(apply(doc, insertChange(state(doc), 7, block))).to.equal(
      'Before \n\\begin{itemize}\n\\item A\n\\end{itemize}\nafter.'
    )
    const empty = 'A\n\nB'
    expect(apply(empty, insertChange(state(empty), 2, block))).to.equal(
      'A\n\\begin{itemize}\n\\item A\n\\end{itemize}\nB'
    )
  })

  it('puts a generator block on its own line even when it is one line', function () {
    const doc = 'Text here'
    expect(
      apply(doc, insertChange(state(doc), 9, '\\title{T}', { block: true }))
    ).to.equal('Text here\n\\title{T}')
  })

  it('inserts below the last selected line, even when the selection ends at a line start', function () {
    const doc = 'one\ntwo\nthree'
    expect(apply(doc, insertBelowChange(state(doc), 4, 7, 'X'))).to.equal(
      'one\ntwo\nX\nthree'
    )
    expect(apply(doc, insertBelowChange(state(doc), 4, 8, 'X'))).to.equal(
      'one\ntwo\nX\nthree'
    )
  })

  it('adds packages after the last one the preamble loads', function () {
    const doc = [
      '\\documentclass{article}',
      '\\usepackage[',
      '  margin=1in',
      ']{geometry}',
      '% \\usepackage{old}',
      '\\begin{document}',
      'Hi',
      '\\end{document}',
    ].join('\n')
    expect(apply(doc, preambleChange(doc, ['booktabs', 'multirow'])!)).to.equal(
      [
        '\\documentclass{article}',
        '\\usepackage[',
        '  margin=1in',
        ']{geometry}',
        '\\usepackage{booktabs}',
        '\\usepackage{multirow}',
        '% \\usepackage{old}',
        '\\begin{document}',
        'Hi',
        '\\end{document}',
      ].join('\n')
    )
  })

  it('adds packages before \\begin{document} when none are loaded', function () {
    const doc = '\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}'
    expect(apply(doc, preambleChange(doc, ['booktabs'])!)).to.equal(
      '\\documentclass{article}\n\\usepackage{booktabs}\n\\begin{document}\nHi\n\\end{document}'
    )
  })

  it('offers nothing when the preamble is in another file', function () {
    expect(preambleChange('\\section{Intro}\nText', ['booktabs'])).to.equal(null)
    expect(preambleChange('\\begin{document}x', ['booktabs'])).to.equal(null)
    expect(
      preambleChange('\\documentclass{article}\n\\begin{document}', [])
    ).to.equal(null)
  })
})
