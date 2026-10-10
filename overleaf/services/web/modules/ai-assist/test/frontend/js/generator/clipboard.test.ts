import { expect } from 'chai'
import {
  onlyTabular,
  spreadsheetText,
  tabularCells,
  tabularFormat,
} from '../../../../frontend/js/features/ai-assist/generator/clipboard'

/** Clipboard data as a paste event gives it. */
function clipboard(data: Record<string, string>) {
  return { getData: (type: string) => data[type] ?? '' }
}

describe('generator: clipboard', function () {
  it('reads tab-separated cells, as Excel and Google Sheets copy them', function () {
    const text = 'Model\tAcc.\nA\t0.91\nB\t0.88'
    expect(tabularFormat(text)).to.equal('tsv')
    expect(tabularCells(text)).to.deep.equal(['Model', 'Acc.', 'A', '0.91', 'B', '0.88'])
  })

  it('reads Markdown tables without their rule row', function () {
    const text = '| a | b |\n|---|:-:|\n| 1 | 2 |'
    expect(tabularFormat(text)).to.equal('markdown')
    expect(tabularCells(text)).to.deep.equal(['a', 'b', '1', '2'])
  })

  it('reads CSV with quoted commas as one value', function () {
    const text = 'City,Population,Area\n"Paris, FR","2,102,650",105\nLyon,522250,48'
    expect(tabularFormat(text)).to.equal('csv')
    expect(tabularCells(text)).to.deep.equal([
      'City',
      'Population',
      'Area',
      'Paris, FR',
      '2,102,650',
      '105',
      'Lyon',
      '522250',
      '48',
    ])
  })

  it('finds the cells inside instructions, and only them', function () {
    const text = 'Make a table of these:\nA\t1\nB\t2\nUse bold headers.'
    expect(tabularCells(text)).to.deep.equal(['A', '1', 'B', '2'])
    expect(onlyTabular(text)).to.equal(false)
    expect(onlyTabular('A\t1\nB\t2')).to.equal(true)
  })

  it('does not take prose for data', function () {
    expect(tabularFormat('We compare A, B, and C.\nThen D, E, and F.')).to.equal(null)
    expect(tabularFormat('one line\twith a tab')).to.equal(null)
  })

  it('prefers the text of copied cells over their image', function () {
    expect(
      spreadsheetText(
        clipboard({
          'text/plain': 'a\tb\n1\t2',
          'text/html': '<table><tr><td>a</td></tr></table>',
        })
      )
    ).to.equal('a\tb\n1\t2')
    expect(spreadsheetText(clipboard({ 'text/plain': 'x\ty\n3\t4' }))).to.equal('x\ty\n3\t4')
  })

  it('leaves ordinary text and images alone', function () {
    expect(spreadsheetText(clipboard({ 'text/plain': 'just words' }))).to.equal(null)
    expect(spreadsheetText(clipboard({}))).to.equal(null)
    expect(spreadsheetText(null)).to.equal(null)
  })
})
