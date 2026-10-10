import { expect } from 'chai'
import { TableHabits } from '../../../../frontend/js/features/ai-assist/table/hints'
import {
  spliceBlock,
  TableShape,
  wrapTable,
} from '../../../../frontend/js/features/ai-assist/table/wrap'

const HABITS: TableHabits = {
  rules: 'booktabs',
  vlines: false,
  caption: 'top',
  placement: 'htbp',
  centering: 'centering',
  size: null,
  labelStyle: 'tab:',
  envs: '',
  twoColumn: false,
  indent: '  ',
  columnTypes: new Set(),
}

const SHAPE: TableShape = {
  env: 'tabular',
  spec: 'l r',
  body: '\\toprule\nA & 1 \\\\\n\\bottomrule',
  caption: 'Results.',
  label: 'tab:res',
  wide: false,
  float: true,
}

const FLOAT = { kind: 'float' } as const

describe('table: wrap', function () {
  it('writes the float in the default style', function () {
    expect(wrapTable(SHAPE, HABITS, FLOAT)).to.equal(
      [
        '\\begin{table}[htbp]',
        '  \\centering',
        '  \\caption{Results.}',
        '  \\label{tab:res}',
        '  \\begin{tabular}{l r}',
        '    \\toprule',
        '    A & 1 \\\\',
        '    \\bottomrule',
        '  \\end{tabular}',
        '\\end{table}',
      ].join('\n')
    )
  })

  it("follows the document: caption below, no placement, a size, tabs", function () {
    const habits = { ...HABITS, caption: 'bottom' as const, placement: null, size: '\\small', indent: '\t' }
    expect(wrapTable(SHAPE, habits, FLOAT)).to.equal(
      [
        '\\begin{table}',
        '\t\\centering',
        '\t\\small',
        '\t\\begin{tabular}{l r}',
        '\t\t\\toprule',
        '\t\tA & 1 \\\\',
        '\t\t\\bottomrule',
        '\t\\end{tabular}',
        '\t\\caption{Results.}',
        '\t\\label{tab:res}',
        '\\end{table}',
      ].join('\n')
    )
  })

  it('uses a center environment when the document does', function () {
    expect(wrapTable(SHAPE, { ...HABITS, centering: 'center' }, FLOAT)).to.equal(
      [
        '\\begin{table}[htbp]',
        '  \\caption{Results.}',
        '  \\label{tab:res}',
        '  \\begin{center}',
        '    \\begin{tabular}{l r}',
        '      \\toprule',
        '      A & 1 \\\\',
        '      \\bottomrule',
        '    \\end{tabular}',
        '  \\end{center}',
        '\\end{table}',
      ].join('\n')
    )
  })

  it('spans the page only in two-column documents', function () {
    const wide: TableShape = { ...SHAPE, env: 'tabularx', spec: 'lX', wide: true }
    const twoColumn = wrapTable(wide, { ...HABITS, twoColumn: true }, FLOAT)
    expect(twoColumn.startsWith('\\begin{table*}[htbp]')).to.equal(true)
    expect(twoColumn).to.include('  \\begin{tabularx}{\\textwidth}{lX}')
    expect(twoColumn.endsWith('\\end{table*}')).to.equal(true)
    const oneColumn = wrapTable(wide, HABITS, FLOAT)
    expect(oneColumn.startsWith('\\begin{table}[htbp]')).to.equal(true)
    expect(oneColumn).to.include('  \\begin{tabularx}{\\linewidth}{lX}')
  })

  it('writes only the tabular inside a float, and a bare tabular when asked', function () {
    const tabular = ['\\begin{tabular}{l r}', '  \\toprule', '  A & 1 \\\\', '  \\bottomrule', '\\end{tabular}']
    expect(wrapTable(SHAPE, HABITS, { kind: 'inner', hasCaption: false })).to.equal(
      ['\\caption{Results.}', '\\label{tab:res}', ...tabular].join('\n')
    )
    expect(wrapTable(SHAPE, HABITS, { kind: 'inner', hasCaption: true })).to.equal(tabular.join('\n'))
    expect(wrapTable({ ...SHAPE, float: false }, HABITS, FLOAT)).to.equal(tabular.join('\n'))
  })

  it('puts the block on its own lines, indented like the anchor', function () {
    expect(spliceBlock('A\nB', { lineBefore: '', lineAfter: '', indent: '' })).to.deep.equal({
      text: 'A\nB',
      blockEnd: 3,
    })
    expect(spliceBlock('A\nB', { lineBefore: '    ', lineAfter: '', indent: '    ' })).to.deep.equal({
      text: 'A\n    B',
      blockEnd: 7,
    })
    expect(spliceBlock('A\nB', { lineBefore: '  Text', lineAfter: ' more', indent: '  ' })).to.deep.equal({
      text: '\n  A\n  B\n  ',
      blockEnd: 8,
    })
  })
})
