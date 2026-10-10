import { expect } from 'chai'
import { EditorState, Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { applyEquation } from '../../../../frontend/js/features/ai-assist/equation/apply'
import {
  equationExtension,
  equationField,
  openEquationDialog,
  startEquationReview,
} from '../../../../frontend/js/features/ai-assist/equation/session'

/** A view reviewing `from`–`to`, recording the user event of every edit. */
function reviewing(doc: string, from: number, to: number) {
  const events: Array<string | undefined> = []
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        equationExtension(),
        EditorView.updateListener.of(update => {
          for (const tr of update.transactions) {
            if (tr.docChanged) events.push(tr.annotation(Transaction.userEvent))
          }
        }),
      ],
    }),
    parent,
  })
  view.dispatch({ effects: openEquationDialog.of({ from, to: from }) })
  view.dispatch({ effects: startEquationReview.of({ from, to }) })
  return { view, events }
}

describe('equation: apply', function () {
  afterEach(function () {
    document.body.innerHTML = ''
  })

  it('writes the new passage as minimal edits, in one transaction, and closes', function () {
    const doc = 'Intro. It is given by where a is it. End.'
    const { view, events } = reviewing(doc, doc.indexOf('It is'), doc.indexOf(' End'))
    const passage = view.state.field(equationField)!.passage!
    expect(applyEquation(view, passage, 'It is given by $x$ where $a$ is it.')).to.equal(true)
    expect(view.state.doc.toString()).to.equal('Intro. It is given by $x$ where $a$ is it. End.')
    expect(events).to.deep.equal(['input.ai-equation'])
    expect(view.state.field(equationField)).to.equal(null)
  })

  it('writes nothing when the passage changed', function () {
    const { view } = reviewing('Intro. It is here. End.', 7, 18)
    view.dispatch({ changes: { from: 8, to: 9, insert: 'T' } })
    const passage = view.state.field(equationField)!.passage!
    expect(applyEquation(view, passage, 'It is $x$ here.')).to.equal(false)
    expect(view.state.doc.toString()).to.equal('Intro. IT is here. End.')
  })

  it('adds the \\usepackage lines in the same transaction', function () {
    const doc =
      '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\nIt is here.\n\\end{document}'
    const from = doc.indexOf('It is')
    const { view, events } = reviewing(doc, from, from + 'It is here.'.length)
    const passage = view.state.field(equationField)!.passage!
    expect(
      applyEquation(view, passage, 'It is $\\SI{3}{m}$ here.', { packages: ['siunitx'] })
    ).to.equal(true)
    expect(view.state.doc.toString()).to.equal(
      '\\documentclass{article}\n\\usepackage{amsmath}\n\\usepackage{siunitx}\n\\begin{document}\nIt is $\\SI{3}{m}$ here.\n\\end{document}'
    )
    expect(events).to.have.length(1)
  })

  it('puts the cursor after the equation', function () {
    const doc = 'It is here.'
    const { view } = reviewing(doc, 0, doc.length)
    const passage = view.state.field(equationField)!.passage!
    const text = 'It is $x$ here.'
    applyEquation(view, passage, text, { cursorOffset: text.indexOf('$x$') + 3 })
    expect(view.state.selection.main.head).to.equal('It is $x$'.length)
  })
})
