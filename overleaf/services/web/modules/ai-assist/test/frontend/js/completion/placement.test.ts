import { expect } from 'chai'
import {
  countColumns,
  announcedBlock,
  describeCursor,
  endsWithStructureLine,
} from '../../../../frontend/js/features/ai-assist/completion/placement'
import type { CompletionKind } from '../../../../frontend/js/features/ai-assist/completion/detect'

/** The situation at the `|` in `text`. */
function at(text: string, kind: CompletionKind = 'prose', inMath = false) {
  const pos = text.lastIndexOf('|')
  return describeCursor(text.slice(0, pos) + text.slice(pos + 1), pos, kind, inMath)
}

const TABLE = '\\begin{table}[h]\n  \\centering\n  \\begin{tabular}{|l|c|r|}\n    \\hline\n    Name & Size & Time \\\\\n'

describe('completion: where the cursor is', function () {
  it('counts the columns of a column spec', function () {
    expect(countColumns('|l|c|r|')).to.equal(3)
    expect(countColumns('lp{3cm}X')).to.equal(3)
    expect(countColumns('*{4}{c}|l')).to.equal(5)
    expect(countColumns('@{}lS[table-format=2.1]@{}')).to.equal(2)
    expect(countColumns('>{\\bfseries}l<{\\,}c')).to.equal(2)
  })

  it('knows the table, its columns and the cell inside a row', function () {
    const s = at(`${TABLE}    Ours & 12 & |\n  \\end{tabular}\n\\end{table}`)
    expect(s.envs.map(env => env.name)).to.deep.equal(['table', 'tabular'])
    expect(s.rows).to.deep.equal({ columns: 3, separatorsBefore: 2, atRowStart: false, header: 'Name & Size & Time' })
    expect(s.forbidBegin).to.include.members(['tabular', 'table', 'figure'])
    expect(s.forbidEnd).to.deep.equal(['table', 'tabular'])
    expect(s.instruction).to.include('3 columns')
    expect(s.instruction).to.include('cell 3')
    expect(s.instruction).to.include('no more cells')
    expect(s.instruction).to.include('Its first row is: Name & Size & Time')
    expect(s.instruction).to.include('End the row with \\\\.')
    expect(s.instruction).to.include('Never open')
    expect(s.rowEndAfter).to.equal(false)
  })

  it('a cell whose row end is already written: the reply stops before it', function () {
    const s = at(`${TABLE}    Ours & |\\\\\n  \\end{tabular}\n\\end{table}`)
    expect(s.rowEndAfter).to.equal(true)
    expect(s.instruction).to.include('already after the cursor: do not write it')
  })

  it('a row that just ended: the next row goes on a new line', function () {
    const s = at(`${TABLE}    Ours & 12 & 3 \\\\|\n  \\end{tabular}\n\\end{table}`, 'block')
    expect(s.newLine).to.equal(true)
    expect(s.rows!.atRowStart).to.equal(true)
    expect(s.indent).to.equal('    ')
    expect(s.instruction).to.include('exactly 3 cells')
  })

  it('reads the columns of aligned math from the rows above', function () {
    const s = at('\\begin{align}\n  a &= b \\\\\n  c &= |\n\\end{align}', 'math', true)
    expect(s.rows).to.include({ columns: 2, separatorsBefore: 1, atRowStart: false })
    expect(s.forbidBegin).to.include('align')
    expect(s.instruction).to.include('aligned formula')
    expect(s.instruction).to.include('math only')
  })

  it('after \\section{…} at the end of its line: a new line, never right next to it', function () {
    const s = at('\\section{Method}|\n', 'block')
    expect(s.newLine).to.equal(true)
    expect(s.sameLine).to.equal(false)
    expect(s.instruction).to.include('line break')
    expect(endsWithStructureLine('\\section{Method}', '')).to.equal(true)
    expect(endsWithStructureLine('  \\end{itemize}', '')).to.equal(true)
    expect(endsWithStructureLine('\\label{fig:a} % note', '')).to.equal(true)
    expect(endsWithStructureLine('We use \\textbf{this}', '')).to.equal(false)
    expect(endsWithStructureLine('\\item', '')).to.equal(false)
  })

  it('inside a heading: the title only', function () {
    const s = at('\\section{Results on |}\n')
    expect(s.argumentOf).to.equal('section')
    expect(s.argumentClosed).to.equal(true)
    expect(s.instruction).to.include('the title of this \\section')
    expect(s.instruction).to.include('stop before it')
    const open = at('\\caption{Accuracy of |\n')
    expect(open.argumentClosed).to.equal(false)
    expect(open.instruction).to.include('Close it with }')
  })

  it('mid-sentence: this line only', function () {
    const s = at('We trained the model on |')
    expect(s.sameLine).to.equal(true)
    expect(s.newLine).to.equal(false)
    expect(at('We trained the model. |').sameLine).to.equal(false)
  })

  it('in a list, a figure, math, code and a drawing', function () {
    expect(at('\\begin{itemize}\n  \\item One.\n  |\n\\end{itemize}', 'block').instruction).to.include('\\item')
    expect(at('\\begin{figure}\n  \\centering\n  |\n\\end{figure}', 'block').forbidBegin).to.include('figure')
    expect(at('\\begin{equation}\n  E = |\n\\end{equation}', 'math', true).forbidBegin).to.include('equation')
    expect(at('\\begin{tikzpicture}\n  \\draw (0,0) -- (1,1);\n  |\n\\end{tikzpicture}', 'code').instruction).to.include('ending with ;')
    // Lists may nest
    expect(at('\\begin{itemize}\n  \\item One |\n\\end{itemize}').forbidBegin).to.not.include('itemize')
  })

  it('detects when suffix immediately starts with an environment and forbids it', function () {
    const s = at('environments.|\n\n\\begin{table}\n\\centering\n\\begin{tabular}{llr}')
    expect(s.forbidBegin).to.include.members(['table', 'tabular', 'tabularx'])
    expect(s.instruction).to.include('\\begin{table} already follows the cursor: do not write it.')
  })

  it('forbids all table and tabular environments while inside a table (no loop tables)', function () {
    const s = at('\\begin{table}[h]\n\\begin{tabular}{ll}\n  Alpha & 10 \\\\\n  |\n\\end{tabular}\n\\end{table}', 'block')
    expect(s.forbidBegin).to.include.members([
      'table', 'table*', 'tabular', 'tabular*', 'tabularx', 'longtable', 'tblr'
    ])
    expect(s.instruction).to.include('Never open \\begin{table}')
  })

  it('never forbids a table or figure in running text: only where one is open or follows', function () {
    expect(at('\\section{Method}|\n', 'block').forbidBegin).to.not.include.members(['table', 'figure', 'tabular'])
    expect(at('We define the following method.|', 'prose').forbidBegin).to.not.include.members(['table', 'figure', 'tabular'])
  })

  it('a sentence announcing a table: the whole table goes on the next lines', function () {
    const doc = '\\begin{document}\nYou can use \\texttt{\\textbackslash hline} to insert rules. This is the example tables: |\n\n\\end{document}'
    const s = at(doc, 'block')
    expect(s.announces).to.equal('table')
    expect(s.newLine).to.equal(true)
    expect(s.sameLine).to.equal(false)
    expect(s.forbidBegin).to.not.include('table')
    expect(s.instruction).to.include('announces a table')
    expect(s.instruction).to.include('Start with a line break, then write a complete table')
  })

  it('names the block a sentence announces by the word nearest its end', function () {
    expect(announcedBlock('Here is some latex code: below is a simple table:')).to.equal('table')
    expect(announcedBlock('The pipeline is shown in the following figure:')).to.equal('figure')
    expect(announcedBlock('The loss is given by')).to.equal('equation')
    expect(announcedBlock('We proceed in the following steps:')).to.equal('list')
    expect(announcedBlock('The training loop is the following algorithm:')).to.equal('algorithm')
    expect(announcedBlock('A minimal Python snippet:')).to.equal('code')
    // Nothing named, or nothing announced
    expect(announcedBlock('Note:')).to.equal(null)
    expect(announcedBlock('The table shows our results.')).to.equal(null)
    // `\\item` is a command, not the word "item"
    expect(announcedBlock('\\item Results:')).to.equal(null)
  })
  it('a sentence that announces a formula or list: the display goes on the next lines', function () {
    const colon = at('The update rule reads as follows:|')
    expect(colon.introducesDisplay).to.equal(true)
    expect(colon.instruction).to.include('start with a line break')
    expect(at('The stiffness is given by|').introducesDisplay).to.equal(true)
    expect(at('We trained the model|').introducesDisplay).to.equal(false)
    expect(at('\\begin{equation}\n  a:|', 'math', true).introducesDisplay).to.equal(false)
    expect(at('We trained the|').instruction).to.include('never on this one')
  })

  it('mid-sentence before a full stop the author already typed', function () {
    const s = at('We trained the model on|.')
    expect(s.sameLine).to.equal(true)
    expect(s.instruction).to.include('The line goes on with "." right after your text')
  })

  it('the preamble, a list being opened, the code language', function () {
    expect(at('\\documentclass{article}\n|\n\\begin{document}\n\\end{document}', 'block').region).to.equal('preamble')
    expect(at('\\documentclass{article}\n|\n\\begin{document}\n\\end{document}', 'block').instruction).to.include('preamble')
    expect(at('Text.\n\\begin{document}\nWe |\n\\end{document}').region).to.equal('body')
    const list = at('\\begin{enumerate}|\n\\end{enumerate}', 'block')
    expect(list.newLine).to.equal(true)
    expect(list.instruction).to.include('Start with a line break, then write the next item')
    expect(at('\\begin{lstlisting}[language=Python]\nx = 1\n|\n\\end{lstlisting}', 'code').instruction).to.include('in Python')
    expect(at('\\begin{minted}{rust}\nfn main() {}\n|\n\\end{minted}', 'code').instruction).to.include('in rust')
  })
})
