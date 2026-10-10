import { expect } from 'chai'
import {
  cursorContext,
  lineState,
} from '../../../../frontend/js/features/ai-assist/inline-context/cursor-context'

/** The text with `|` removed, and where it was. */
function at(source: string): [string, number] {
  const pos = source.indexOf('|')
  return [source.slice(0, pos) + source.slice(pos + 1), pos]
}

const context = (source: string) => cursorContext(...at(source))

describe('inline context: cursor context', function () {
  it('tells the preamble from the body', function () {
    expect(
      context('\\documentclass{article}\n|\n\\begin{document}\nText\n\\end{document}').region
    ).to.equal('preamble')
    expect(
      context('\\documentclass{article}\n\\begin{document}\nTe|xt\n\\end{document}').region
    ).to.equal('body')
  })

  it('reads a file without \\begin{document} as body, unless it loads packages', function () {
    expect(context('Some text|').region).to.equal('body')
    expect(context('\\usepackage{amsmath}\n|').region).to.equal('preamble')
  })

  it('gives the heading path above the cursor', function () {
    expect(
      context('\\section{Intro}\nA\n\\section{Method}\n\\subsection*{Training\n  data}\nB|').section
    ).to.equal('Method / Training data')
    expect(context('\\chapter{One}\n\\section{A}\n\\chapter{Two}\nx|').section).to.equal('Two')
    expect(context('No heading|').section).to.equal('')
  })

  it('lists the open environments, innermost last', function () {
    expect(
      context('\\begin{document}\n\\begin{figure}\n\\begin{center}\n|').envs
    ).to.deep.equal(['figure', 'center'])
    expect(context('\\begin{itemize}\n\\item a\n\\end{itemize}\n|').envs).to.deep.equal([])
    expect(context('\\begin{verbatim}\n|').envs).to.deep.equal(['verbatim'])
  })

  it('names the container around the cursor', function () {
    expect(context('\\caption{Decay with rate |}').container).to.equal('caption')
    expect(context('\\section{Re|sults}').container).to.equal('heading')
    expect(context('See\\footnote{More in \\textbf{|}}').container).to.equal('footnote')
    expect(context('\\begin{itemize}\n\\item |').container).to.equal('item')
    expect(context('\\begin{abstract}\nWe |').container).to.equal('abstract')
    expect(context('Plain \\textbf{bold |} text').container).to.equal('text')
  })

  it('ignores escaped braces and comments', function () {
    expect(context('\\caption{A set \\{x\\} and |}').container).to.equal('caption')
    expect(context('\\caption{Done} \\} text |').container).to.equal('text')
    expect(
      context('% \\section{Old}\n\\section{New}\n% \\begin{figure}\nx|').section
    ).to.equal('New')
    expect(context('% \\begin{figure}\nx|').envs).to.deep.equal([])
  })
})

describe('inline context: line state', function () {
  it('says what is around the cursor on its line', function () {
    expect(lineState(...at('a\n|\nb'))).to.equal('empty')
    expect(lineState(...at('a\n  |  \nb'))).to.equal('empty')
    expect(lineState(...at('a\n|text'))).to.equal('start')
    expect(lineState(...at('te|xt'))).to.equal('middle')
    expect(lineState(...at('text|\nmore'))).to.equal('end')
  })
})
