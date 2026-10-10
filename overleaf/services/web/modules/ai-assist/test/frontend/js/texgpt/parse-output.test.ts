import { expect } from 'chai'
import { parseReply } from '../../../../frontend/js/features/ai-assist/texgpt/parse-output'

describe('texgpt: reading replies', function () {
  it('reads a latex block and the packages it needs', function () {
    expect(
      parseReply(
        '<latex>\n\\toprule\n</latex>\n<packages>booktabs, multirow</packages>',
        true
      )
    ).to.deep.equal({
      kind: 'latex',
      text: '\\toprule',
      packages: ['booktabs', 'multirow'],
      complete: true,
    })
  })

  it('holds back a half-written closing tag while streaming', function () {
    expect(parseReply('<latex>\\item A</la', false)).to.deep.include({
      kind: 'latex',
      text: '\\item A',
      complete: false,
    })
  })

  it('takes a reply without tags whole, minus a preface and fences', function () {
    expect(
      parseReply('Here is the LaTeX code:\n```latex\n\\section{A}\n```', true)
    ).to.deep.include({ kind: 'latex', text: '\\section{A}' })
  })

  it('keeps only the code when the model wraps it in prose', function () {
    const reply =
      'You can use a table:\n```latex\n\\begin{tabular}{ll}\n\\end{tabular}\n```\nIt needs booktabs.'
    expect(parseReply(reply, true)).to.deep.include({
      kind: 'latex',
      text: '\\begin{tabular}{ll}\n\\end{tabular}',
    })
  })

  it('reads an answer and a refusal', function () {
    expect(parseReply('<answer>Use **twocolumn**.</answer>', true)).to.deep.equal({
      kind: 'answer',
      text: 'Use **twocolumn**.',
      complete: true,
    })
    expect(parseReply('<cannot>No.</cannot>', true)).to.deep.equal({
      kind: 'cannot',
      reason: 'No.',
      complete: true,
    })
  })

  it('reads title and keyword options, cleaned and deduplicated', function () {
    expect(
      parseReply(
        '<titles><t>"Fast Graphs"</t><t>Slow Trees.</t><t>fast graphs</t></titles>',
        true,
        'titles'
      )
    ).to.deep.equal({
      kind: 'options',
      options: ['Fast Graphs', 'Slow Trees'],
      complete: true,
    })
    expect(
      parseReply('<keywords><k>graphs</k><k>trees</k></keywords>', true, 'keywords')
    ).to.deep.include({ options: ['graphs', 'trees'] })
  })

  it('falls back to one option per line when the tags are missing', function () {
    expect(
      parseReply('Here are 3 titles:\n1. Fast Graphs\n2. Slow Trees', true, 'titles')
    ).to.deep.include({ kind: 'options', options: ['Fast Graphs', 'Slow Trees'] })
  })

  it('ignores reasoning and waits while a tag may be opening', function () {
    expect(parseReply('<think>plan</think><latex>x</latex>', true)).to.deep.include({
      text: 'x',
    })
    expect(parseReply('<think>still thinking', false)).to.deep.include({ text: '' })
    expect(parseReply('<lat', false)).to.deep.include({ kind: 'latex', text: '' })
  })
})
