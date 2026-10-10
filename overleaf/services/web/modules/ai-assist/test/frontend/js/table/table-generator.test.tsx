import { expect } from 'chai'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { EditorContext } from '@/shared/context/editor-context'
import {
  CodeMirrorStateContext,
  CodeMirrorViewContext,
} from '@/features/source-editor/components/codemirror-context'
import {
  findTableGenerator,
  TableDropdown,
} from '@/features/source-editor/components/toolbar/table-dropdown'
import tableGenerator from '../../../../frontend/js/features/ai-assist/table/table-generator'
import { tableExtension, tableField } from '../../../../frontend/js/features/ai-assist/table/session'

function setMeta({ enabled = true } = {}) {
  window.metaAttributesCache?.clear()
  document.head.innerHTML = enabled
    ? '<meta name="ol-aiAssistEnabled" data-type="boolean" content="">'
    : ''
}

function makeView(doc: string, from: number, to = from, extensions = [tableExtension()]) {
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
          <TableDropdown />
        </CodeMirrorStateContext.Provider>
      </CodeMirrorViewContext.Provider>
    </EditorContext.Provider>
  )
}

describe('table: generator slot', function () {
  beforeEach(function () {
    document.body.innerHTML = ''
    setMeta()
  })

  it('is available exactly when AI is', function () {
    expect(tableGenerator.isAvailable()).to.equal(true)
    setMeta({ enabled: false })
    expect(tableGenerator.isAvailable()).to.equal(false)
  })

  it('is what upstream finds, only with AI on', function () {
    expect(findTableGenerator()).to.equal(tableGenerator)
    setMeta({ enabled: false })
    expect(findTableGenerator()).to.equal(undefined)
  })

  it('opens the dialog on the selection', function () {
    const view = makeView('a,b\n1,2\n', 0, 7)
    tableGenerator.open(view)
    expect(view.state.field(tableField)).to.include({ phase: 'dialog' })
    expect(view.state.field(tableField)!.anchor).to.deep.equal({ from: 0, to: 7 })
  })

  it('does nothing in a read-only editor or without the extension', function () {
    const readOnly = makeView('Text', 1, 1, [tableExtension(), EditorState.readOnly.of(true)])
    tableGenerator.open(readOnly)
    expect(readOnly.state.field(tableField)).to.equal(null)
    const bare = makeView('Text', 1, 1, [])
    expect(() => tableGenerator.open(bare)).to.not.throw()
  })

  it('adds "From text or image" to the Insert table menu and opens the dialog', async function () {
    const view = makeView('Text here.', 4)
    renderDropdown(view)
    fireEvent.click(screen.getByRole('button', { name: 'Insert table' }))
    fireEvent.click(await screen.findByText('From text or image'))
    await waitFor(() => expect(view.state.field(tableField)).to.include({ phase: 'dialog' }))
  })

  it("keeps Select size inserting upstream's table", async function () {
    const view = makeView('Text here.\n', 11)
    renderDropdown(view)
    fireEvent.click(screen.getByRole('button', { name: 'Insert table' }))
    fireEvent.click(await screen.findByText('Select size'))
    await waitFor(() => expect(document.querySelector('.ol-cm-toolbar-table-cell')).to.not.equal(null))
    fireEvent.mouseUp(document.querySelector('.ol-cm-toolbar-table-cell')!)
    expect(view.state.doc.toString()).to.include('\\begin{tabular}{c}')
  })
})
