import { expect } from 'chai'
import { ReactNode, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import fetchMock from 'fetch-mock'
import { LanguageSupport } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import customLocalStorage from '@/infrastructure/local-storage'
import { LaTeXLanguage } from '@/features/source-editor/languages/latex/latex-language'
import {
  CodeMirrorStateContext,
  CodeMirrorViewContext,
} from '@/features/source-editor/components/codemirror-context'
import TableHost, {
  TableHostView,
} from '../../../../frontend/js/features/ai-assist/components/table/table-host'
import tableGenerator from '../../../../frontend/js/features/ai-assist/table/table-generator'
import { tableExtension, tableField } from '../../../../frontend/js/features/ai-assist/table/session'
import { GeneratorImage } from '../../../../frontend/js/features/ai-assist/generator/image'
import { texGptExtension } from '../../../../frontend/js/features/ai-assist/texgpt/target'
import { writingToolsExtension } from '../../../../frontend/js/features/ai-assist/writing-tools/extension'

const CHAT = '/ai-assist/providers/editor'
const PLACEHOLDER =
  'Example: create a table with 6 rows and 6 columns, centered, with a horizontal line after the heading'
const DOC = 'We trained two models.\n\nThe results follow.'
const CURSOR = DOC.indexOf('\n\n') + 1
const REPLY = [
  '<table env="tabular" spec="l r" label="tab:acc">',
  '<caption>Accuracy.</caption>',
  '<body>',
  'Model & Acc. \\\\',
  '\\hline',
  'A & 0.91 \\\\',
  '</body>',
  '</table>',
].join('\n')
const WRAPPED = [
  '\\begin{table}[htbp]',
  '  \\centering',
  '  \\caption{Accuracy.}',
  '  \\label{tab:acc}',
  '  \\begin{tabular}{l r}',
  '    Model & Acc. \\\\',
  '    \\hline',
  '    A & 0.91 \\\\',
  '  \\end{tabular}',
  '\\end{table}',
].join('\n')

function setMeta({ enabled = true } = {}) {
  window.metaAttributesCache?.clear()
  document.head.innerHTML = enabled
    ? '<meta name="ol-aiAssistEnabled" data-type="boolean" content="">'
    : ''
}

function ndjson(...chunks: object[]) {
  return {
    body: [...chunks, { type: 'done' }].map(c => JSON.stringify(c) + '\n').join(''),
    headers: { 'Content-Type': 'application/x-ndjson' },
  }
}

const reply = (text: string) => ndjson({ type: 'text', text })

/** A real EditorView whose state reaches React the way the editor does it. */
function renderEditor(doc: string, selection: { from: number; to: number }, ui: ReactNode) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  let publish: (state: EditorState) => void = () => {}
  const view: EditorView = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(selection.from, selection.to),
      extensions: [
        new LanguageSupport(LaTeXLanguage),
        writingToolsExtension(),
        texGptExtension(),
        tableExtension(),
      ],
    }),
    parent,
    dispatchTransactions: transactions => {
      view.update(transactions)
      publish(view.state)
    },
  })

  function Harness() {
    const [state, setState] = useState(view.state)
    publish = setState
    return (
      <CodeMirrorViewContext.Provider value={view}>
        <CodeMirrorStateContext.Provider value={state}>{ui}</CodeMirrorStateContext.Provider>
      </CodeMirrorViewContext.Provider>
    )
  }

  render(<Harness />)
  return view
}

const openDialog = (view: EditorView) => act(() => tableGenerator.open(view))

function generate(prompt: string) {
  fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), { target: { value: prompt } })
  fireEvent.click(screen.getByRole('button', { name: /^Generate$/ }))
}

async function enabled(name: string | RegExp) {
  const button = (await screen.findByRole('button', { name })) as HTMLButtonElement
  await waitFor(() => expect(button.disabled).to.equal(false))
  return button
}

function requestBody(call = 0) {
  return JSON.parse(String(fetchMock.callHistory.calls(CHAT)[call].options.body))
}

describe('table: host', function () {
  beforeEach(function () {
    setMeta()
    document.body.innerHTML = ''
    customLocalStorage.clear()
    customLocalStorage.setItem('ai-assist:provider', {
      type: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'k',
      model: 'claude',
    })
    customLocalStorage.setItem('ai-assist:consent', true)
    fetchMock.removeRoutes().clearHistory()
    fetchMock.put('/ai-assist/preferences', { preferences: null })
  })

  afterEach(function () {
    cleanup()
    fetchMock.removeRoutes().clearHistory()
    customLocalStorage.clear()
  })

  it('renders nothing with AI off', function () {
    setMeta({ enabled: false })
    const view = renderEditor(DOC, { from: CURSOR, to: CURSOR }, <TableHost />)
    openDialog(view)
    expect(screen.queryByText('Generate table')).to.equal(null)
  })

  it("generates at a cursor in the document's style and inserts it in one step", async function () {
    fetchMock.post(CHAT, reply(REPLY))
    const view = renderEditor(DOC, { from: CURSOR, to: CURSOR }, <TableHost />)
    openDialog(view)
    generate('accuracy of the two models')
    const insert = await enabled(/^Insert/)
    const body = requestBody()
    expect(body.request.messages[0].content).to.include('<where kind="float" />')
    expect(body.request.messages[0].content).to.include('rules="hline"')
    expect(body.request.messages[0].content).to.include('<request>\naccuracy of the two models\n</request>')
    expect(body.request.system).to.include('Keep every given value exactly')
    expect(body.providerSettings.thinking).to.equal(false)
    fireEvent.click(insert)
    expect(view.state.doc.toString()).to.equal(`We trained two models.\n${WRAPPED}\nThe results follow.`)
    expect(view.state.field(tableField)).to.equal(null)
  })

  it('sends a selection as data and replaces it', async function () {
    const doc = 'Results:\na\tb\n1\t2\nEnd.'
    const from = doc.indexOf('a\tb')
    const to = doc.indexOf('\nEnd.')
    fetchMock.post(
      CHAT,
      reply(
        '<table env="tabular" spec="l l" label="tab:ab"><caption>Values.</caption><body>a & b \\\\\n1 & 2 \\\\</body></table>'
      )
    )
    const view = renderEditor(doc, { from, to }, <TableHost />)
    openDialog(view)
    expect(await screen.findByText('Uses the selected text (2 lines)')).to.exist
    fireEvent.click(screen.getByRole('button', { name: /^Generate$/ }))
    const insert = await enabled(/^Insert/)
    expect(requestBody().request.messages[0].content).to.include(
      '<selection kind="data">\na\tb\n1\t2\n</selection>'
    )
    expect(screen.getByText('From selection')).to.exist
    expect(screen.getByText('Changes')).to.exist
    fireEvent.click(insert)
    expect(view.state.doc.toString()).to.equal(
      [
        'Results:',
        '\\begin{table}[htbp]',
        '  \\centering',
        '  \\caption{Values.}',
        '  \\label{tab:ab}',
        '  \\begin{tabular}{l l}',
        '    a & b \\\\',
        '    1 & 2 \\\\',
        '  \\end{tabular}',
        '\\end{table}',
        'End.',
      ].join('\n')
    )
  })

  it('refuses inside a tabular, and says how to rewrite one', async function () {
    const doc = '\\begin{tabular}{ll}\na & b \\\\\n\\end{tabular}'
    const at = doc.indexOf('b \\\\')
    const view = renderEditor(doc, { from: at, to: at }, <TableHost />)
    openDialog(view)
    generate('x')
    expect(
      await screen.findByText("Can't insert a table inside a table. Select the whole table to rewrite it.")
    ).to.exist
    expect(fetchMock.callHistory.calls(CHAT)).to.have.length(0)
    expect(view.state.field(tableField)).to.include({ phase: 'dialog' })
  })

  it('explains a reply cut off at the output limit', async function () {
    fetchMock.post(
      CHAT,
      ndjson(
        { type: 'text', text: '<table env="tabular" spec="l"><body>a \\\\' },
        { type: 'stop', reason: 'max_tokens' }
      )
    )
    const view = renderEditor(DOC, { from: CURSOR, to: CURSOR }, <TableHost />)
    openDialog(view)
    generate('all 300 rows')
    expect(
      await screen.findByText(
        'The table is too long for one reply. Ask for part of it, or choose a model with a larger output limit.'
      )
    ).to.exist
  })

  it('sends the image with the first request, even without words', async function () {
    const IMAGE: GeneratorImage = {
      mediaType: 'image/png',
      data: 'iVBORw0KGgo=',
      name: 'results.png',
      size: 2048,
      width: 800,
      height: 400,
    }
    fetchMock.post(CHAT, reply(REPLY))
    const view = renderEditor(
      DOC,
      { from: CURSOR, to: CURSOR },
      <TableHostView normalize={async () => IMAGE} />
    )
    openDialog(view)
    fireEvent.drop(screen.getByText('Drop an image of the table here'), {
      dataTransfer: { files: [new File(['x'], 'results.png', { type: 'image/png' })] },
    })
    expect(await screen.findByText('results.png')).to.exist
    fireEvent.click(screen.getByRole('button', { name: /^Generate$/ }))
    await enabled(/^Insert/)
    const message = requestBody().request.messages[0]
    expect(message.images).to.deep.equal([{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }])
    expect(message.content).to.include('<image attached="true" />\n\n<request>\n\n</request>')
    expect(screen.getByText('From image')).to.exist
  })

  it('reopens the dialog with the prompt on Edit prompt, and Cancel leaves the text', async function () {
    fetchMock.post(CHAT, reply(REPLY))
    const view = renderEditor(DOC, { from: CURSOR, to: CURSOR }, <TableHost />)
    openDialog(view)
    generate('accuracy')
    await enabled(/^Insert/)
    fireEvent.click(screen.getByRole('button', { name: /Edit prompt/ }))
    expect(await screen.findByText('Generate table')).to.exist
    expect((screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement).value).to.equal('accuracy')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(view.state.field(tableField)).to.equal(null)
    expect(view.state.doc.toString()).to.equal(DOC)
  })
})
