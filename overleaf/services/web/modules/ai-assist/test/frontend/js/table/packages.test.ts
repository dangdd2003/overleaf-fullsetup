import { expect } from 'chai'
import {
  colorTableReady,
  tablePackages,
} from '../../../../frontend/js/features/ai-assist/table/packages'

describe('table: packages', function () {
  it("adds the packages a table's columns and commands need", function () {
    const spec = 'l S X >{\\raggedleft\\arraybackslash}p{2cm}'
    const latex = [
      '\\begin{table}',
      `\\begin{tabularx}{\\linewidth}{${spec}}`,
      '\\toprule',
      '\\multirow{2}{*}{a} & \\makecell{b} & c & d \\\\',
      '\\bottomrule',
      '\\end{tabularx}',
      '\\end{table}',
    ].join('\n')
    expect(tablePackages(latex, spec, [], new Set(), 'article', false).sort()).to.deep.equal([
      'array',
      'booktabs',
      'makecell',
      'multirow',
      'siunitx',
      'tabularx',
    ])
  })

  it('asks for colortbl, not xcolor, for coloured rows, unless xcolor has the table option', function () {
    const latex = '\\begin{tabular}{ll}\n\\rowcolor{gray} a & b \\\\\n\\end{tabular}'
    expect(tablePackages(latex, 'll', ['xcolor'], new Set(), 'article', false)).to.deep.equal(['colortbl'])
    expect(tablePackages(latex, 'll', [], new Set(['xcolor']), 'article', true)).to.deep.equal([])
    expect(colorTableReady('\\usepackage[table,dvipsnames]{xcolor}', new Set(['xcolor']))).to.equal(true)
    expect(colorTableReady('\\usepackage{xcolor}', new Set(['xcolor']))).to.equal(false)
  })

  it('leaves out what the project or its class already loads', function () {
    const latex = '\\begin{tabular}{ll}\n\\toprule\na & b \\\\\n\\bottomrule\n\\end{tabular}'
    expect(tablePackages(latex, 'll', [], new Set(['booktabs']), 'article', false)).to.deep.equal([])
    expect(tablePackages(latex, 'll', [], new Set(), 'acmart', false)).to.deep.equal([])
  })
})
