import { expect } from 'chai'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { EditorContext } from '@/shared/context/editor-context'
import {
  CodeMirrorStateContext,
  CodeMirrorViewContext,
} from '@/features/source-editor/components/codemirror-context'
import { MathDropdown } from '@/features/source-editor/components/toolbar/math-dropdown'
import mathGenerator from '../../../../frontend/js/features/ai-assist/equation/math-generator'
import {
  equationExtension,
  equationField,
} from '../../../../frontend/js/features/ai-assist/equation/session'

function setMeta({ enabled = true } = {}) {
  window.metaAttributesCache?.clear()
  document.head.innerHTML = enabled
    ? '<meta name="ol-aiAssistEnabled" data-type="boolean" content="">'
    : ''
}

function makeView(doc: string, from: number, to = from, extensions = [equationExtension()]) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    state: EditorState.create({ doc, selection: EditorSelection.single(from, to), extensions }),
    parent,
  })
}

function renderDropdown(view: EditorView) {
  render(
    <EditorContext.Provider value={{ writefullInstance: null } as any}>
      <CodeMirrorViewContext.Provider value={view}>
        <CodeMirrorStateContext.Provider value={view.state}>
          <MathDropdown />
        </CodeMirrorStateContext.Provider>
      </CodeMirrorViewContext.Provider>
    </EditorContext.Provider>
  )
}

describe('equation: math generator slot', function () {
  beforeEach(function () {
    document.body.innerHTML = ''
    setMeta()
  })

  it('is available exactly when AI is', function () {
    expect(mathGenerator.isAvailable()).to.equal(true)
    setMeta({ enabled: false })
    expect(mathGenerator.isAvailable()).to.equal(false)
  })

  it('opens the dialog on the selection', function () {
    const view = makeView('Energy E = mc2 here.', 7, 14)
    mathGenerator.open(view)
    expect(view.state.field(equationField)).to.include({ phase: 'dialog' })
    expect(view.state.field(equationField)!.anchor).to.deep.equal({ from: 7, to: 14 })
  })

  it('does nothing in a read-only editor or without the extension', function () {
    const readOnly = makeView('Text', 1, 1, [equationExtension(), EditorState.readOnly.of(true)])
    mathGenerator.open(readOnly)
    expect(readOnly.state.field(equationField)).to.equal(null)
    const bare = makeView('Text', 1, 1, [])
    expect(() => mathGenerator.open(bare)).to.not.throw()
  })

  it('adds "From text or image" to the Insert math menu and opens the dialog', async function () {
    const view = makeView('Text here.', 4)
    renderDropdown(view)
    fireEvent.click(screen.getByRole('button', { name: 'Insert math' }))
    const item = await screen.findByText('From text or image')
    fireEvent.click(item)
    await waitFor(() => expect(view.state.field(equationField)).to.include({ phase: 'dialog' }))
  })

  it('leaves the menu as upstream with AI off', async function () {
    setMeta({ enabled: false })
    const view = makeView('Text here.', 4)
    renderDropdown(view)
    fireEvent.click(screen.getByRole('button', { name: 'Insert math' }))
    await screen.findByText('Inline')
    expect(screen.queryByText('From text or image')).to.equal(null)
  })
})
