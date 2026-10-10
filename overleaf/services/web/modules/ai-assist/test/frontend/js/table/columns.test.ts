import { expect } from 'chai'
import {
  bodyProblems,
  countColumns,
  findTabulars,
  splitBody,
} from '../../../../frontend/js/features/ai-assist/table/columns'

describe('table: columns', function () {
  it('counts plain, paragraph and package columns', function () {
    expect(countColumns('lcr')).to.deep.equal({ count: 3, problems: [] })
    expect(countColumns('|l|c|r|')).to.deep.equal({ count: 3, problems: [] })
    expect(countColumns('l p{3cm} m{2em} b{1in}').count).to.equal(4)
    expect(countColumns('l X X').count).to.equal(3)
    expect(countColumns('l S[table-format=2.1] s').count).to.equal(3)
    expect(countColumns('w{c}{2cm} W{l}{1cm}').count).to.equal(2)
  })

  it('skips decorations and expands repeats', function () {
    expect(
      countColumns('@{}l>{\\centering\\arraybackslash}p{2cm}<{\\hfill}r!{\\vrule}c@{}').count
    ).to.equal(4)
    expect(countColumns('*{3}{c|}l').count).to.equal(4)
    expect(countColumns('*{2}{*{2}{c}}').count).to.equal(4)
  })

  it("knows the document's own column types and flags unknown ones", function () {
    expect(countColumns('lY', new Set(['Y'])).count).to.equal(2)
    expect(countColumns('lQ')).to.deep.equal({
      count: 1,
      problems: ['Unknown column type "Q" in the spec "lQ".'],
    })
  })

  it('splits rows at \\\\ and cells at &, but not inside braces or when escaped', function () {
    const { rows } = splitBody('\\makecell{a\\\\b} & R\\&D & c \\\\\nx & \\textbf{y} & 50\\% \\\\')
    expect(rows.map(row => row.cells)).to.deep.equal([
      ['\\makecell{a\\\\b}', 'R\\&D', 'c'],
      ['x', '\\textbf{y}', '50\\%'],
    ])
    expect(rows.map(row => row.span)).to.deep.equal([3, 3])
    expect(bodyProblems('\\makecell{a\\\\b} & R\\&D & c \\\\', 3)).to.deep.equal([])
  })

  it('sets rules apart and counts multicolumn spans', function () {
    const { rows, trailingRules } = splitBody(
      '\\toprule\n\\multicolumn{2}{c}{Group} & C \\\\\n\\cmidrule(lr){1-2}\na & b & c \\\\\n\\bottomrule'
    )
    expect(rows.map(row => ({ rules: row.rules, span: row.span }))).to.deep.equal([
      { rules: ['\\toprule'], span: 3 },
      { rules: ['\\cmidrule(lr){1-2}'], span: 3 },
    ])
    expect(trailingRules).to.deep.equal(['\\bottomrule'])
  })

  it('accepts a last row without \\\\ and skips the [length] after \\\\', function () {
    const { rows } = splitBody('a & b \\\\[2pt]\nc & d')
    expect(rows.map(row => row.cells)).to.deep.equal([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('finds what would not compile', function () {
    const problems = bodyProblems(
      'a & b & c \\\\\n\\cmidrule{2-4}\nx & 5% & y_1 \\\\\n$z & w \\bottomrule',
      2
    )
    expect(problems).to.deep.equal([
      'Row 1 has 3 cells but the spec has 2 columns.',
      'Row 2 has 3 cells but the spec has 2 columns.',
      '\\cmidrule{2-4} before row 2 goes past the 2 columns.',
      'Row 2: unescaped % (write \\%).',
      'Row 2: _ or ^ outside math in "y_1" (write \\_ or use $…$).',
      'Row 3: a rule command follows the cells; end the row with \\\\ first.',
      'Row 3: unbalanced $ in "$z".',
    ])
  })

  it('reports a table without rows', function () {
    expect(bodyProblems('\\toprule\n\\bottomrule', 2)).to.deep.equal(['The table has no rows.'])
  })

  it('finds tabulars in a document, with their spec and body', function () {
    const found = findTabulars(
      'x \\begin{tabularx}{\\linewidth}{lX} a & b \\end{tabularx} y \\begin{tabular}[t]{l@{}r} c & d \\end{tabular}'
    )
    expect(found.map(({ env, spec, body }) => ({ env, spec, body: body.trim() }))).to.deep.equal([
      { env: 'tabularx', spec: 'lX', body: 'a & b' },
      { env: 'tabular', spec: 'l@{}r', body: 'c & d' },
    ])
  })
})
