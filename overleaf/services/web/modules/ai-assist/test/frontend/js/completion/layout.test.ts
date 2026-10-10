import { expect } from 'chai'
import { indentUnit, layoutLatex } from '../../../../frontend/js/features/ai-assist/completion/layout'

const ctx = (before: string, extra = {}) => ({ before, envs: [] as string[], indent: '', unit: '  ', ...extra })

describe('completion: LaTeX layout of a reply', function () {
  it('guesses the indentation the document uses', function () {
    expect(indentUnit('\\begin{itemize}\n  \\item a\n\\end{itemize}')).to.equal('  ')
    expect(indentUnit('a\n\tb')).to.equal('\t')
    expect(indentUnit('plain text')).to.equal('    ')
  })

  it('leaves plain text as it is', function () {
    expect(layoutLatex(' and so on, see $x_1$ and \\cref{fig:a}.', ctx('It works'))).to.equal(
      ' and so on, see $x_1$ and \\cref{fig:a}.'
    )
  })

  it('breaks a display out of the sentence, and the text after it', function () {
    expect(layoutLatex(' as \\[ a = b \\] where $a$ is', ctx('It reads'))).to.equal(' as\n\\[\n  a = b\n\\]\nwhere $a$ is')
  })

  it('keeps a label on its \\begin line and the body below it', function () {
    expect(layoutLatex('\\begin{equation}\\label{eq:a} x = 1 \\end{equation}', ctx(''))).to.equal(
      '\\begin{equation}\\label{eq:a}\n  x = 1\n\\end{equation}'
    )
  })

  it('separates a float from a finished sentence with a blank line, only where the reply starts', function () {
    expect(layoutLatex('\\begin{figure} \\centering \\end{figure}', ctx('As shown.'))).to.equal(
      '\n\n\\begin{figure}\n  \\centering\n\\end{figure}'
    )
  })

  it('keeps code exactly as written', function () {
    const code = '\\begin{verbatim}\nx  =  1\n\\end{verbatim}'
    expect(layoutLatex(code, ctx(''))).to.equal(code)
  })

  it('closes an environment opened before the cursor one level out', function () {
    expect(layoutLatex('done. \\end{itemize}', ctx('  \\item it is', { envs: ['itemize'], indent: '  ' }))).to.equal(
      'done.\n\\end{itemize}'
    )
  })
})
