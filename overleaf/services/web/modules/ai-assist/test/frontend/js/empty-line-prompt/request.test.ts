import { expect } from 'chai'
import {
  buildEmptyLineRequest,
  noticeForEmpty,
  shapeLatex,
} from '../../../../frontend/js/features/ai-assist/empty-line-prompt/request'

const DOC = '\\documentclass{article}\n\\usepackage{booktabs}\n\\begin{document}\nIntro.\n\n\\end{document}\n'
const POS = DOC.indexOf('\n\n\\end') + 1

describe('empty-line prompt: request', function () {
  it("is TeXGPT's insert request at the empty line", function () {
    const message = buildEmptyLineRequest({
      doc: DOC,
      pos: POS,
      prompt: 'add a table of symbols',
      source: { docs: { 'main.tex': DOC }, rootPath: 'main.tex', openPath: 'main.tex', complete: true },
    })
    expect(message).to.include('class="article"')
    expect(message).to.include('packages="booktabs"')
    expect(message).to.include('line="empty"')
    expect(message).to.include('Intro.\n<cursor/>\n\\end{document}')
    expect(message).to.match(/<request>\nadd a table of symbols\n<\/request>$/)
  })

  it('shows only LaTeX', function () {
    expect(shapeLatex('<latex>\\section{Symbols}</latex>', true)).to.deep.equal({ text: '\\section{Symbols}' })
    expect(shapeLatex('<answer>Use booktabs.</answer>', true)).to.deep.equal({ text: '' })
    expect(shapeLatex('<cannot>No.</cannot>', true)).to.deep.equal({ text: '' })
  })

  it('names the notice for a reply with no LaTeX', function () {
    expect(noticeForEmpty('<cannot>Not possible here.</cannot>')).to.deep.equal({
      name: 'cannot',
      reason: 'Not possible here.',
    })
    expect(noticeForEmpty('<answer>Use booktabs.</answer>')).to.deep.equal({ name: 'empty' })
    expect(noticeForEmpty('')).to.deep.equal({ name: 'empty' })
  })
})
