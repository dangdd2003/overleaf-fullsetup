import { expect } from 'chai'
import { LanguageSupport } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { LaTeXLanguage } from '@/features/source-editor/languages/latex/latex-language'
import {
  blockRange,
  selectionKind,
  tableWhere,
} from '../../../../frontend/js/features/ai-assist/table/context'

const stateOf = (doc: string) =>
  EditorState.create({ doc, extensions: new LanguageSupport(LaTeXLanguage) })

/** `tableWhere` at `‸`, or over `⟦…⟧`. */
function whereAt(marked: string) {
  if (marked.includes('‸')) {
    const at = marked.indexOf('‸')
    return tableWhere(stateOf(marked.replace('‸', '')), { from: at, to: at })
  }
  const from = marked.indexOf('⟦')
  const to = marked.indexOf('⟧') - 1
  return tableWhere(stateOf(marked.replace('⟦', '').replace('⟧', '')), { from, to })
}

const DOC = (body: string) =>
  `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}`

describe('table: context', function () {
  it('puts a float in prose and in list items', function () {
    expect(whereAt(DOC('Some text.\n‸\nMore text.'))).to.deep.equal({ kind: 'float' })
    expect(whereAt(DOC('\\begin{itemize}\n\\item One ‸\n\\end{itemize}'))).to.deep.equal({
      kind: 'float',
    })
  })

  it('puts only the tabular inside a float or a box', function () {
    expect(whereAt(DOC('\\begin{table}[h]\n\\centering\n‸\n\\end{table}'))).to.deep.equal({
      kind: 'inner',
      hasCaption: false,
    })
    expect(whereAt(DOC('\\begin{table}\n\\caption{X}\n‸\n\\end{table}'))).to.deep.equal({
      kind: 'inner',
      hasCaption: true,
    })
    // \caption needs a float: a bare minipage gets the tabular alone
    expect(whereAt(DOC('\\begin{minipage}{0.5\\linewidth}\n‸\n\\end{minipage}'))).to.deep.equal({
      kind: 'inner',
      hasCaption: true,
    })
  })

  it('refuses inside a table, math, captions, arguments and comments', function () {
    const refused = (reason: string) => ({ kind: 'refused', reason })
    expect(whereAt(DOC('\\begin{tabular}{ll}\na & ‸b \\\\\n\\end{tabular}'))).to.deep.equal(
      refused('table')
    )
    expect(whereAt(DOC('Mass $m‸$ here.'))).to.deep.equal(refused('here'))
    expect(whereAt(DOC('\\begin{figure}\n\\caption{A ‸ b}\n\\end{figure}'))).to.deep.equal(
      refused('here')
    )
    expect(whereAt(DOC('A \\textbf{bold ‸ text}.'))).to.deep.equal(refused('here'))
    expect(whereAt(DOC('Text % note ‸'))).to.deep.equal(refused('here'))
  })

  it('accepts a selection of a whole table and refuses one that cuts an environment', function () {
    expect(
      whereAt(
        DOC('Intro.\n⟦\\begin{table}\n\\begin{tabular}{l}\na \\\\\n\\end{tabular}\n\\end{table}⟧\nEnd.')
      )
    ).to.deep.equal({ kind: 'float' })
    expect(
      whereAt(
        DOC('\\begin{table}\n\\caption{T}\n⟦\\begin{tabular}{l}\na \\\\\n\\end{tabular}⟧\n\\end{table}')
      )
    ).to.deep.equal({ kind: 'inner', hasCaption: true })
    expect(whereAt(DOC('⟦Text\n\\begin{itemize}\n\\item a⟧\n\\end{itemize}'))).to.deep.equal({
      kind: 'refused',
      reason: 'selection',
    })
  })

  it('names what a selection holds', function () {
    expect(selectionKind('\\begin{tabular}{ll}\na & b\n\\end{tabular}')).to.equal('table')
    expect(selectionKind('a\tb\n1\t2')).to.equal('data')
    expect(selectionKind('Just a sentence.')).to.equal('text')
  })

  it('widens a cut over its spaces and reads the line around it', function () {
    const doc = '  Some text here.'
    const at = doc.indexOf(' here')
    expect(blockRange(doc, { from: at, to: at })).to.deep.equal({
      from: at,
      to: at + 1,
      lineBefore: '  Some text',
      lineAfter: ' here.',
      indent: '  ',
    })
    const empty = 'A.\n    \nB.'
    const cursor = empty.indexOf('    ') + 4
    expect(blockRange(empty, { from: cursor, to: cursor })).to.deep.equal({
      from: cursor,
      to: cursor,
      lineBefore: '    ',
      lineAfter: '',
      indent: '    ',
    })
  })
})
