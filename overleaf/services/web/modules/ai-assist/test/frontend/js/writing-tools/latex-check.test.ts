import { expect } from 'chai'
import { checkLatex } from '../../../../frontend/js/features/ai-assist/writing-tools/latex-check'

describe('writing tools: LaTeX check', function () {
  it('finds nothing when the LaTeX survived', function () {
    expect(
      checkLatex(
        'As shown in \\cite{a} and Eq.~\\eqref{e1}, $x+y$ holds.',
        'Eq.~\\eqref{e1} and \\cite{a} show that $x + y$ holds.'
      )
    ).to.deep.equal([])
  })

  it('reports a dropped citation key', function () {
    expect(checkLatex('as in \\cite{a,b}.', 'as in \\cite{a}.')).to.deep.equal([
      { kind: 'droppedKey', message: '\\cite{b} was dropped' },
    ])
  })

  it('reports an added reference', function () {
    expect(checkLatex('See the figure.', 'See Figure~\\ref{fig:1}.')).to.deep.equal(
      [{ kind: 'addedKey', message: '\\ref{fig:1} was added' }]
    )
  })

  it('treats \\citep and \\citet of one key as the same citation', function () {
    expect(checkLatex('\\citep{a} found', '\\citet{a} found')).to.deep.equal([])
  })

  it('reports changed math', function () {
    expect(checkLatex('Let $x^2$ be.', 'Let $x^3$ be.')).to.deep.equal([
      { kind: 'math', message: 'A math expression was changed' },
    ])
  })

  it('allows translated \\text inside math only for Translate', function () {
    const original = '$f(x) \\text{ if } x > 0$'
    const translated = '$f(x) \\text{ nếu } x > 0$'
    expect(checkLatex(original, translated, { translate: true })).to.deep.equal([])
    expect(checkLatex(original, translated)).to.have.length(1)
  })

  it('reports a broken environment and unbalanced braces', function () {
    const warnings = checkLatex(
      '\\begin{itemize}\\item \\emph{a}\\end{itemize}',
      '\\begin{itemize}\\item \\emph{a'
    )
    expect(warnings.map(w => w.kind)).to.deep.equal(['environment', 'braces'])
  })

  it('ignores escaped braces', function () {
    expect(checkLatex('a \\{ b', 'a \\{ c')).to.deep.equal([])
  })
})
