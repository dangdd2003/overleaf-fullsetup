import { expect } from 'chai'
import { render, screen } from '@testing-library/react'
import { EditorState } from '@codemirror/state'
import {
  documentDefinitions,
  mathProblemsFromMml,
  previewTex,
} from '../../../../frontend/js/features/ai-assist/equation/math-render'
import { MathPreview } from '../../../../frontend/js/features/ai-assist/components/equation/math-preview'

describe('equation: math-render', function () {
  it('gives MathJax the body, in a form it can show without numbering', function () {
    expect(previewTex('inline', 'x')).to.deep.equal({ tex: 'x', display: false })
    expect(previewTex('display', 'x')).to.deep.equal({ tex: 'x', display: true })
    expect(previewTex('equation', 'x')).to.deep.equal({ tex: 'x', display: true })
    expect(previewTex('align*', 'a &= b')).to.deep.equal({
      tex: '\\begin{aligned}a &= b\\end{aligned}',
      display: true,
    })
    expect(previewTex('gather', 'a \\\\ b').tex).to.equal('\\begin{gathered}a \\\\ b\\end{gathered}')
    expect(previewTex('body', 'x', 'inline')).to.deep.equal({ tex: 'x', display: false })
    expect(previewTex('body', 'a &= b', 'align').tex).to.equal('\\begin{aligned}a &= b\\end{aligned}')
  })

  it('reads errors and undefined macros from MathJax MathML', function () {
    const mml =
      '<math><merror data-mjx-error="Missing close brace"><mtext>Missing close brace</mtext></merror>' +
      '<mtext mathcolor="red">\\foo</mtext><mtext mathcolor="red">\\foo</mtext></math>'
    expect(mathProblemsFromMml(mml)).to.deep.equal({
      errors: ['Missing close brace'],
      undefinedMacros: ['\\foo'],
    })
    expect(mathProblemsFromMml('<math><mi>x</mi></math>')).to.deep.equal({
      errors: [],
      undefinedMacros: [],
    })
    expect(
      mathProblemsFromMml('<merror data-mjx-error="Extra &amp; in &quot;x&quot;"></merror>').errors
    ).to.deep.equal(['Extra & in "x"'])
  })

  it('has no definitions outside the LaTeX editor', function () {
    expect(documentDefinitions(EditorState.create({ doc: '\\newcommand{\\R}{x}' }))).to.equal('')
  })

  it('says so when MathJax is unavailable', async function () {
    render(<MathPreview tex="x" display definitions="" />)
    expect(await screen.findByText('The preview is unavailable. Check the LaTeX below.')).to.exist
  })
})
