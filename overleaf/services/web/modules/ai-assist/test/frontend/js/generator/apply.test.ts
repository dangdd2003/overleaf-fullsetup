import { expect } from 'chai'
import { EditorState, Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { applyGenerated } from '../../../../frontend/js/features/ai-assist/generator/apply'
import { defineGeneratorSession } from '../../../../frontend/js/features/ai-assist/generator/session'

const demo = defineGeneratorSession('demo')

/** A view reviewing `from`–`to`, recording the user event of every edit. */
function reviewing(doc: string, from: number, to: number) {
  const events: Array<string | undefined> = []
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        demo.extension(),
        EditorView.updateListener.of(update => {
          for (const tr of update.transactions) {
            if (tr.docChanged) events.push(tr.annotation(Transaction.userEvent))
          }
        }),
      ],
    }),
    parent,
  })
  view.dispatch({ effects: demo.openDialog.of({ from, to }) })
  view.dispatch({ effects: demo.startReview.of({ from, to }) })
  return { view, events }
}

describe('generator: apply', function () {
  afterEach(function () {
    document.body.innerHTML = ''
  })

  it('inserts at a cursor in one transaction, closes, and leaves the cursor after it', function () {
    const doc = 'Before.\n\nAfter.'
    const at = doc.indexOf('\n\n') + 1
    const { view, events } = reviewing(doc, at, at)
    const passage = view.state.field(demo.field)!.passage!
    const applied = applyGenerated(view, passage, 'X', {
      userEvent: 'input.ai-demo',
      close: demo.close.of(null),
    })
    expect(applied).to.equal(true)
    expect(view.state.doc.toString()).to.equal('Before.\nX\nAfter.')
    expect(events).to.deep.equal(['input.ai-demo'])
    expect(view.state.field(demo.field)).to.equal(null)
    expect(view.state.selection.main.head).to.equal(at + 1)
  })

  it('replaces a selection', function () {
    const doc = 'a,b\n1,2\nEnd.'
    const { view } = reviewing(doc, 0, 7)
    const passage = view.state.field(demo.field)!.passage!
    applyGenerated(view, passage, 'TABLE', {
      userEvent: 'input.ai-demo',
      close: demo.close.of(null),
    })
    expect(view.state.doc.toString()).to.equal('TABLE\nEnd.')
  })
})
