import { expect } from 'chai'
import { isTwoColumn, tableHabits } from '../../../../frontend/js/features/ai-assist/table/hints'

const BOOKTABS_DOC = [
  '\\documentclass{article}',
  '\\begin{document}',
  '\\begin{table}[h]',
  '  \\centering',
  '  \\small',
  '  \\caption{First}',
  '  \\begin{tabular}{lrr}',
  '    \\toprule',
  '    a & 1 & 2 \\\\',
  '    \\bottomrule',
  '  \\end{tabular}',
  '\\end{table}',
  '\\begin{table}[h]',
  '  \\centering',
  '  \\small',
  '  \\begin{tabularx}{\\linewidth}{lX}',
  '    a & b \\\\',
  '  \\end{tabularx}',
  '  \\caption{Second}',
  '\\end{table}',
  '\\begin{table}[t]',
  '  \\centering',
  '  \\begin{tabular}{l|r}',
  '    a & b \\\\',
  '  \\end{tabular}',
  '  \\caption{Third}',
  '\\end{table}',
  '\\end{document}',
].join('\n')

const HLINE_DOC = [
  '\\begin{table}',
  '\\begin{center}',
  '\\begin{tabular}{|l|r|}',
  '\\hline',
  'a & 1 \\\\',
  '\\hline',
  '\\end{tabular}',
  '\\end{center}',
  '\\caption{One}',
  '\\end{table}',
  '\\begin{table}',
  '\\caption{Two}',
  '\\begin{center}',
  '\\begin{tabular}{|c|c|}',
  'x & y \\\\',
  '\\end{tabular}',
  '\\end{center}',
  '\\end{table}',
].join('\n')

describe('table: hints', function () {
  it('falls back to the defaults in a document without tables', function () {
    const habits = tableHabits('\\documentclass{article}\n\\begin{document}\nText.\n\\end{document}', [], new Set())
    expect(habits).to.deep.include({
      rules: 'hline',
      vlines: false,
      caption: 'top',
      placement: 'htbp',
      centering: 'centering',
      size: null,
      labelStyle: 'tab:',
      envs: '',
      twoColumn: false,
      indent: '  ',
    })
    expect([...habits.columnTypes]).to.deep.equal([])
  })

  it('uses booktabs when the package is loaded, even before the first table', function () {
    expect(tableHabits('Text.', [], new Set(['booktabs'])).rules).to.equal('booktabs')
  })

  it('follows the tables the document has', function () {
    const habits = tableHabits(BOOKTABS_DOC, ['tab:a', 'tab:b', 'table:c'], new Set(['booktabs']))
    expect(habits).to.deep.include({
      rules: 'booktabs',
      vlines: false,
      caption: 'bottom',
      placement: 'h',
      centering: 'centering',
      size: '\\small',
      labelStyle: 'tab:',
      envs: 'tabular:2 tabularx:1',
    })
  })

  it('reads \\hline tables with vertical lines, a center environment and no placement', function () {
    expect(tableHabits(HLINE_DOC, [], new Set())).to.deep.include({
      rules: 'hline',
      vlines: true,
      centering: 'center',
      placement: null,
      caption: 'top',
    })
  })

  it('knows two-column classes', function () {
    expect(isTwoColumn('\\documentclass[twocolumn]{article}')).to.equal(true)
    expect(isTwoColumn('\\documentclass[conference]{IEEEtran}')).to.equal(true)
    expect(isTwoColumn('\\documentclass[onecolumn]{IEEEtran}')).to.equal(false)
    expect(isTwoColumn('\\documentclass[sigconf]{acmart}')).to.equal(true)
    expect(isTwoColumn('\\documentclass{article}')).to.equal(false)
  })

  it('reads the indentation, the label style and custom column types', function () {
    const doc =
      '\\newcolumntype{Y}{>{\\centering\\arraybackslash}X}\n\\begin{itemize}\n\t\\item a\n\t\\item b\n\\end{itemize}'
    const habits = tableHabits(doc, ['table:x', 'table:y', 'tab:z'], new Set())
    expect(habits.indent).to.equal('\t')
    expect(habits.labelStyle).to.equal('table:')
    expect([...habits.columnTypes]).to.deep.equal(['Y'])
  })
})
