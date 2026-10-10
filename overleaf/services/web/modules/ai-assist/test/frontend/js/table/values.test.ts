import { expect } from 'chai'
import {
  givenValues,
  missingValues,
  plainValue,
  valuesWarning,
} from '../../../../frontend/js/features/ai-assist/table/values'

describe('table: values', function () {
  it('compares values without their LaTeX markup', function () {
    expect(plainValue('\\textbf{Model A}')).to.equal('Model A')
    expect(plainValue('$-0.5$')).to.equal('-0.5')
    expect(plainValue('50\\%')).to.equal('50%')
    expect(plainValue('R\\&D')).to.equal('R&D')
    expect(plainValue('\u22120.5')).to.equal('-0.5')
    expect(plainValue('1\\,000')).to.equal('1 000')
  })

  it('collects the values of pasted cells, data selections and selected tables', function () {
    expect(givenValues('Make a table:\nA\t1.5\nB\t-2', null)).to.deep.equal(['A', '1.5', 'B', '-2'])
    expect(givenValues('', { kind: 'data', text: 'x,y,z\n1,2,3\n4,5,6' })).to.deep.equal([
      'x', 'y', 'z', '1', '2', '3', '4', '5', '6',
    ])
    expect(
      givenValues('use booktabs', {
        kind: 'table',
        text: '\\begin{tabular}{ll}\n\\hline\nName & \\multicolumn{1}{c}{Score} \\\\\nAl & 50\\% \\\\\n\\end{tabular}',
      })
    ).to.deep.equal(['Name', 'Score', 'Al', '50%'])
    expect(givenValues('a nice table about cats', { kind: 'text', text: 'Cats are great.' })).to.deep.equal([])
  })

  it('warns about given values the table lacks', function () {
    const body = '\\toprule\nA & 1.5 \\\\\nB & $-2$ \\\\\n\\bottomrule'
    expect(missingValues(['A', '1.5', 'B', '-2', 'C'], body)).to.deep.equal(['C'])
    expect(valuesWarning(['C'])).to.equal('1 value from your data is not in the table: C')
    expect(valuesWarning(['a', 'b', 'c', 'd', 'e', 'f'])).to.equal(
      '6 values from your data are not in the table: a, b, c, d, e…'
    )
    expect(valuesWarning([])).to.equal(null)
  })
})
