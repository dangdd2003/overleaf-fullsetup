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
import EquationHost, {
  EquationHostView,
} from '../../../../frontend/js/features/ai-assist/components/equation/equation-host'
import mathGenerator from '../../../../frontend/js/features/ai-assist/equation/math-generator'
import {
  GeneratorImage,
  ImageReadError,
} from '../../../../frontend/js/features/ai-assist/generator/image'
import {
  equationExtension,
  equationField,
} from '../../../../frontend/js/features/ai-assist/equation/session'
import { texGptExtension } from '../../../../frontend/js/features/ai-assist/texgpt/target'
import { writingToolsExtension } from '../../../../frontend/js/features/ai-assist/writing-tools/extension'

const CHAT = '/ai-assist/providers/editor'
const DOC = 'The energy of a body at rest is given by where m is its mass.'
const CURSOR = DOC.indexOf(' where')
const REPLY =
  '<equation form="equation" label="eq:energy">E = mc^2</equation>' +
  '<passage>The energy of a body at rest is given by<equation/> where $m$ is its mass.</passage>'
const WRAPPED = '\\begin{equation}\n  E = mc^2\n  \\label{eq:energy}\n\\end{equation}'

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
        equationExtension(),
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

function openDialog(view: EditorView) {
  act(() => mathGenerator.open(view))
}

function generate(prompt: string) {
  fireEvent.change(screen.getByPlaceholderText('Example: provide the Friedmann Equations'), {
    target: { value: prompt },
  })
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

describe('equation: host', function () {
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
    const view = renderEditor(DOC, { from: CURSOR, to: CURSOR }, <EquationHost />)
    openDialog(view)
    expect(screen.queryByText('Generate equation')).to.equal(null)
  })

  it('opens the dialog with the selected text as the prompt', async function () {
    const doc = 'The value is E = mc2 in units.'
    const from = doc.indexOf('E =')
    const view = renderEditor(doc, { from, to: doc.indexOf(' in') }, <EquationHost />)
    openDialog(view)
    expect(await screen.findByText('Generate equation')).to.exist
    expect(
      (screen.getByPlaceholderText('Example: provide the Friedmann Equations') as HTMLTextAreaElement).value
    ).to.equal('E = mc2')
  })

  it('generates, shows the change and inserts it in one step', async function () {
    fetchMock.post(CHAT, reply(REPLY))
    const view = renderEditor(DOC, { from: CURSOR, to: CURSOR }, <EquationHost />)
    openDialog(view)
    generate('mass-energy')
    const insert = await enabled(/^Insert/)
    const content = requestBody().request.messages[0].content
    expect(content).to.include(
      '<passage>The energy of a body at rest is given by<cursor/> where m is its mass.</passage>'
    )
    expect(content).to.include('<request>\nmass-energy\n</request>')
    expect(requestBody().providerSettings.thinking).to.equal(false)
    expect(screen.getByLabelText('Also apply 1 small edit around it')).to.exist
    fireEvent.click(insert)
    expect(view.state.doc.toString()).to.equal(
      `The energy of a body at rest is given by\n${WRAPPED}\nwhere $m$ is its mass.`
    )
    expect(view.state.field(equationField)).to.equal(null)
  })

  it('inserts the equation alone when the edits are unticked', async function () {
    fetchMock.post(CHAT, reply(REPLY))
    const view = renderEditor(DOC, { from: CURSOR, to: CURSOR }, <EquationHost />)
    openDialog(view)
    generate('mass-energy')
    const insert = await enabled(/^Insert/)
    fireEvent.click(screen.getByLabelText('Also apply 1 small edit around it'))
    fireEvent.click(insert)
    expect(view.state.doc.toString()).to.equal(
      `The energy of a body at rest is given by\n${WRAPPED}\nwhere m is its mass.`
    )
  })

  it('refuses to generate inside a comment', async function () {
    const doc = 'Text % a note here'
    const view = renderEditor(doc, { from: doc.indexOf('here'), to: doc.indexOf('here') }, <EquationHost />)
    openDialog(view)
    generate('x')
    expect(await screen.findByText("Can't insert math here")).to.exist
    expect(fetchMock.callHistory.calls(CHAT)).to.have.length(0)
    expect(view.state.field(equationField)).to.include({ phase: 'dialog' })
  })

  it('asks for consent before the first request', async function () {
    customLocalStorage.removeItem('ai-assist:consent')
    fetchMock.post(CHAT, reply(REPLY))
    const view = renderEditor(DOC, { from: CURSOR, to: CURSOR }, <EquationHost />)
    openDialog(view)
    generate('mass-energy')
    fireEvent.click(await screen.findByRole('button', { name: 'Allow and continue' }))
    await enabled(/^Insert/)
    expect(fetchMock.callHistory.calls(CHAT)).to.have.length(1)
  })

  it('discards without touching the text', async function () {
    fetchMock.post(CHAT, reply(REPLY))
    const view = renderEditor(DOC, { from: CURSOR, to: CURSOR }, <EquationHost />)
    openDialog(view)
    generate('mass-energy')
    await enabled(/^Insert/)
    fireEvent.click(screen.getAllByRole('button', { name: 'Discard' })[0])
    expect(view.state.field(equationField)).to.equal(null)
    expect(view.state.doc.toString()).to.equal(DOC)
  })

  it('reopens the dialog with the prompt on Edit prompt', async function () {
    fetchMock.post(CHAT, reply(REPLY))
    const view = renderEditor(DOC, { from: CURSOR, to: CURSOR }, <EquationHost />)
    openDialog(view)
    generate('mass-energy')
    await enabled(/^Insert/)
    fireEvent.click(screen.getByRole('button', { name: /Edit prompt/ }))
    expect(await screen.findByText('Generate equation')).to.exist
    expect(
      (screen.getByPlaceholderText('Example: provide the Friedmann Equations') as HTMLTextAreaElement).value
    ).to.equal('mass-energy')
  })

  it('will not insert over text that changed', async function () {
    fetchMock.post(CHAT, reply(REPLY))
    const view = renderEditor(DOC, { from: CURSOR, to: CURSOR }, <EquationHost />)
    openDialog(view)
    generate('mass-energy')
    const insert = await enabled(/^Insert/)
    act(() => view.dispatch({ changes: { from: 4, to: 10, insert: 'ENERGY' } }))
    await waitFor(() => expect(insert.disabled).to.equal(true))
    expect(
      screen.getByText('The text changed since this was written. Retry to work on the current text.')
    ).to.exist
  })
})

describe('equation: host with images', function () {
  const IMAGE: GeneratorImage = {
    mediaType: 'image/png',
    data: 'iVBORw0KGgo=',
    name: 'friedmann.png',
    size: 2048,
    width: 800,
    height: 200,
  }

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

  async function dropImage() {
    fireEvent.drop(screen.getByText('Drop an image of the equation here'), {
      dataTransfer: { files: [new File(['x'], 'friedmann.png', { type: 'image/png' })] },
    })
    expect(await screen.findByText('friedmann.png')).to.exist
  }

  it('sends the image with the first request, even without words', async function () {
    fetchMock.post(CHAT, reply(REPLY))
    const view = renderEditor(
      DOC,
      { from: CURSOR, to: CURSOR },
      <EquationHostView normalize={async () => IMAGE} />
    )
    openDialog(view)
    await dropImage()
    fireEvent.click(screen.getByRole('button', { name: /^Generate$/ }))
    await enabled(/^Insert/)
    const message = requestBody().request.messages[0]
    expect(message.images).to.deep.equal([{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }])
    expect(message.content).to.include('<image attached="true" />\n\n<request>\n\n</request>')
    expect(screen.getByText('From image')).to.exist
  })

  it('says why an image could not be used', async function () {
    const view = renderEditor(
      DOC,
      { from: CURSOR, to: CURSOR },
      <EquationHostView
        normalize={async () => {
          throw new ImageReadError('size')
        }}
      />
    )
    openDialog(view)
    fireEvent.drop(screen.getByText('Drop an image of the equation here'), {
      dataTransfer: { files: [new File(['x'], 'huge.png', { type: 'image/png' })] },
    })
    expect(await screen.findByText("Images over 20 MB can't be used")).to.exist
  })

  it('explains a model that refuses images', async function () {
    fetchMock.post(
      CHAT,
      ndjson({ type: 'error', error: { code: 'imageUnsupported', message: "This model can't read images." } })
    )
    const view = renderEditor(
      DOC,
      { from: CURSOR, to: CURSOR },
      <EquationHostView normalize={async () => IMAGE} />
    )
    openDialog(view)
    await dropImage()
    fireEvent.click(screen.getByRole('button', { name: /^Generate$/ }))
    expect(
      await screen.findByText(
        "This model can't read images. Choose a vision-capable model in AI settings, or describe the equation in words."
      )
    ).to.exist
  })

  it('treats a model that cannot see the announced image the same way', async function () {
    fetchMock.post(CHAT, reply('<cannot>no-image</cannot>'))
    const view = renderEditor(
      DOC,
      { from: CURSOR, to: CURSOR },
      <EquationHostView normalize={async () => IMAGE} />
    )
    openDialog(view)
    await dropImage()
    fireEvent.click(screen.getByRole('button', { name: /^Generate$/ }))
    expect(await screen.findByText(/This model can't read images/)).to.exist
  })
})
