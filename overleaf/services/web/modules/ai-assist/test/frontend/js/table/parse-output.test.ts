import { expect } from 'chai'
import { parseTableReply } from '../../../../frontend/js/features/ai-assist/table/parse-output'

const REPLY = [
  '<table env="tabular" spec="l r" label="tab:acc" wide="false" float="true">',
  '<caption>Accuracy of the models.</caption>',
  '<body>',
  '\\toprule',
  'Model & Acc. \\\\',
  '\\midrule',
  'A & 0.91 \\\\',
  '\\bottomrule',
  '</body>',
  '</table>',
  '<packages>booktabs</packages>',
  '<notes>Row 2: read 0.91.</notes>',
].join('\n')

describe('table: parse-output', function () {
  it('reads a complete reply', function () {
    const parsed = parseTableReply(REPLY, true)
    expect(parsed).to.deep.include({
      kind: 'table',
      env: 'tabular',
      spec: 'l r',
      label: 'tab:acc',
      wide: false,
      float: true,
      caption: 'Accuracy of the models.',
      bodyComplete: true,
      packages: ['booktabs'],
      notes: 'Row 2: read 0.91.',
      tagged: true,
    })
    expect((parsed as { body: string }).body).to.equal(
      '\\toprule\nModel & Acc. \\\\\n\\midrule\nA & 0.91 \\\\\n\\bottomrule'
    )
  })

  it('streams the rows as they come, without a half-written closing tag', function () {
    const cut = REPLY.slice(0, REPLY.indexOf('</body>') + 4)
    const parsed = parseTableReply(cut, false)
    expect(parsed).to.deep.include({ kind: 'table', bodyComplete: false })
    expect((parsed as { body: string }).body.trimEnd().endsWith('\\bottomrule')).to.equal(true)
  })

  it('cleans the label and reads wide, float and a missing caption', function () {
    const parsed = parseTableReply(
      '<table env="tabularx" spec="lX" label="tab: my label!" wide="true" float="false"><body>a & b \\\\</body></table>',
      true
    )
    expect(parsed).to.deep.include({
      env: 'tabularx',
      label: 'tab:mylabel',
      wide: true,
      float: false,
      caption: null,
      body: 'a & b \\\\',
    })
  })

  it('reads a refusal and a missing image', function () {
    expect(parseTableReply('<cannot>This image has no table.</cannot>', true)).to.deep.equal({
      kind: 'cannot',
      reason: 'This image has no table.',
      complete: true,
    })
    expect(parseTableReply('<cannot>no-image</cannot>', true)).to.deep.include({
      kind: 'cannot',
      reason: 'no-image',
    })
  })

  it('reads raw LaTeX from a model that ignored the tags', function () {
    const raw =
      'Here is the table:\n```latex\n\\begin{table}[h]\n\\centering\n\\caption{Results}\n\\label{tab:res}\n\\begin{tabular}{|l|c|}\n\\hline\na & b \\\\\n\\hline\n\\end{tabular}\n\\end{table}\n```'
    expect(parseTableReply(raw, true)).to.deep.include({
      kind: 'table',
      env: 'tabular',
      spec: '|l|c|',
      caption: 'Results',
      label: 'tab:res',
      tagged: false,
      body: '\\hline\na & b \\\\\n\\hline',
    })
  })

  it('gives an empty body when there is nothing to read', function () {
    expect(parseTableReply('Sorry, I am not sure.', true)).to.deep.include({
      kind: 'table',
      body: '',
      tagged: true,
    })
  })
})
