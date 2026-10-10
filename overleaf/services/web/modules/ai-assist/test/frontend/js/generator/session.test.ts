import { expect } from 'chai'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView, runScopeHandlers } from '@codemirror/view'
import { defineGeneratorSession } from '../../../../frontend/js/features/ai-assist/generator/session'
import {
  openTexGpt,
  texGptExtension,
  texGptField,
} from '../../../../frontend/js/features/ai-assist/texgpt/target'

const alpha = defineGeneratorSession('alpha')
const beta = defineGeneratorSession('beta')

function makeView(doc: string, from: number, to = from) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(from, to),
      extensions: [texGptExtension(), alpha.extension(), beta.extension()],
    }),
    parent,
  })
}

describe('generator: session', function () {
  afterEach(function () {
    document.body.innerHTML = ''
  })

  it('opening one generator closes the other, and TeXGPT', function () {
    const view = makeView('Some text here.', 5)
    view.dispatch({ effects: openTexGpt.of({ from: 5, to: 5 }) })
    alpha.open(view)
    expect(view.state.field(alpha.field)).to.include({ phase: 'dialog' })
    beta.open(view)
    expect(view.state.field(alpha.field)).to.equal(null)
    expect(view.state.field(beta.field)).to.include({ phase: 'dialog' })
    expect(view.state.field(texGptField)).to.equal(null)
    view.destroy()
  })

  it('names its marks after the generator', function () {
    const view = makeView('The energy is here.', 13)
    beta.open(view)
    view.dispatch({ effects: beta.startReview.of({ from: 4, to: 18 }) })
    expect(view.dom.querySelector('.ai-beta-target.ai-generator-target')).to.not.equal(null)
    expect(view.dom.querySelector('.ai-beta-caret')).to.not.equal(null)
    expect(view.dom.querySelector('.ai-alpha-target')).to.equal(null)
    view.destroy()
  })

  it('reviews an empty passage at a cursor with only the caret', function () {
    const view = makeView('Text here.', 4)
    alpha.open(view)
    view.dispatch({ effects: alpha.startReview.of({ from: 4, to: 4 }) })
    expect(view.state.field(alpha.field)!.passage).to.deep.equal({ from: 4, to: 4, original: '' })
    expect(view.dom.querySelector('.ai-alpha-target')).to.equal(null)
    expect(view.dom.querySelector('.ai-alpha-caret')).to.not.equal(null)
    view.destroy()
  })

  it('Escape closes only the open generator', function () {
    const view = makeView('Text', 1)
    beta.open(view)
    const escape = () =>
      runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'Escape' }), 'editor')
    expect(escape()).to.equal(true)
    expect(view.state.field(beta.field)).to.equal(null)
    expect(escape()).to.equal(false)
    view.destroy()
  })
})
