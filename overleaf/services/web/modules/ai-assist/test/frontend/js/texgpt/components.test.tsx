import { expect } from 'chai'
import { ReactNode, useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import fetchMock from 'fetch-mock'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import customLocalStorage from '@/infrastructure/local-storage'
import {
  CodeMirrorStateContext,
  CodeMirrorViewContext,
} from '@/features/source-editor/components/codemirror-context'
import TexGptButton from '../../../../frontend/js/features/ai-assist/components/texgpt/texgpt-button'
import {
  texGptExtension,
  texGptField,
} from '../../../../frontend/js/features/ai-assist/texgpt/target'
import {
  writingSessionField,
  writingToolsExtension,
} from '../../../../frontend/js/features/ai-assist/writing-tools/extension'
import {
  clearSelectionHistory,
  saveTexGptHistory,
  saveWritingToolHistory,
} from '../../../../frontend/js/features/ai-assist/writing-tools/history-cache'

const CHAT = '/ai-assist/providers/editor'

function setMeta({ enabled = true } = {}) {
  window.metaAttributesCache?.clear()
  document.head.innerHTML = enabled
    ? '<meta name="ol-aiAssistEnabled" data-type="boolean" content="">'
    : ''
}

function ndjson(...chunks: object[]) {
  return {
    body: [...chunks, { type: 'done' }]
      .map(c => JSON.stringify(c) + '\n')
      .join(''),
    headers: { 'Content-Type': 'application/x-ndjson' },
  }
}

function reply(text: string) {
  return ndjson({ type: 'text', text })
}

/** A real EditorView whose state reaches React the way the editor does it. */
function renderEditor(
  doc: string,
  selection: { from: number; to: number },
  ui: ReactNode
) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  let publish: (state: EditorState) => void = () => {}
  const view: EditorView = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(selection.from, selection.to),
      extensions: [writingToolsExtension(), texGptExtension()],
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
        <CodeMirrorStateContext.Provider value={state}>
          {ui}
        </CodeMirrorStateContext.Provider>
      </CodeMirrorViewContext.Provider>
    )
  }

  render(<Harness />)
  return view
}

function openPopup() {
  fireEvent.click(screen.getByRole('button', { name: 'TeXGPT' }))
}

function send(text: string) {
  const input = screen.getByPlaceholderText(/^Ask/)
  fireEvent.change(input, { target: { value: text } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

async function enabled(name: string | RegExp) {
  const button = (await screen.findByRole('button', { name })) as HTMLButtonElement
  await waitFor(() => expect(button.disabled).to.equal(false))
  return button
}

function requestBody(call = 0) {
  return JSON.parse(String(fetchMock.callHistory.calls(CHAT)[call].options.body))
}

describe('texgpt: components', function () {
  beforeEach(function () {
    clearSelectionHistory()
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
    clearSelectionHistory()
    fetchMock.removeRoutes().clearHistory()
    customLocalStorage.clear()
  })

  it('shows no button when AI is off', function () {
    setMeta({ enabled: false })
    renderEditor('Text', { from: 0, to: 0 }, <TexGptButton />)
    expect(screen.queryByRole('button', { name: 'TeXGPT' })).to.equal(null)
  })

  it('renders the smart_toy icon and updated tooltip for TeXGPT', async function () {
    renderEditor('Text', { from: 0, to: 0 }, <TexGptButton />)
    const button = screen.getByRole('button', { name: 'TeXGPT' })
    expect(button).to.exist
    const icon = button.querySelector('.material-symbols')
    expect(icon?.textContent).to.equal('smart_toy')
    fireEvent.mouseEnter(button)
    await waitFor(() => {
      expect(screen.getByText('The AI that has done LaTex writing for you and more')).to.exist
    })
  })

  it('offers the generators under the prompt bar when nothing is selected', function () {
    const view = renderEditor('Text', { from: 2, to: 2 }, <TexGptButton />)
    openPopup()
    expect(screen.getByPlaceholderText('Ask TeXGPT for help with anything')).to.exist
    expect(
      screen
        .getAllByRole('menuitem')
        .map(item => item.querySelector('.ai-texgpt-menu-item-label')?.textContent)
    ).to.deep.equal([
      'Title Generator',
      'Abstract Generator',
      'Keywords Generator',
      'Custom prompt',
    ])
    expect(view.state.field(texGptField)!.target).to.deep.equal({
      mode: 'insert',
      pos: 2,
    })
  })

  it('offers the writing tools when text is selected and hands over to their card', function () {
    const view = renderEditor('We saw a quick result.', { from: 9, to: 14 }, <TexGptButton />)
    openPopup()
    expect(screen.getByPlaceholderText('Ask TeXGPT to edit the selection…')).to.exist
    expect(
      screen
        .getAllByRole('menuitem')
        .map(item => item.querySelector('.ai-texgpt-menu-item-label')?.textContent)
    ).to.deep.equal(['Synonyms', 'Translate', 'Custom prompt'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Synonyms' }))
    expect(screen.getByRole('dialog', { name: 'Synonyms' })).to.exist
  })

  it('generates code from a prompt and inserts it on its own lines', async function () {
    fetchMock.post(CHAT, reply('<latex>\\begin{itemize}\n\\item A\n\\end{itemize}</latex>'))
    const view = renderEditor('Intro text.\n\nEnd.', { from: 12, to: 12 }, <TexGptButton />)
    openPopup()
    send('Make a list')
    const insert = await enabled(/^Insert/)
    const content = requestBody().request.messages[0].content
    expect(content).to.include('<where region="body" line="empty" />')
    expect(content).to.include('<context>\nIntro text.\n<cursor/>\nEnd.\n</context>')
    expect(content).to.include('<request>\nMake a list\n</request>')
    expect(requestBody().providerSettings.thinking).to.equal(false)
    fireEvent.click(insert)
    expect(view.state.doc.toString()).to.equal(
      'Intro text.\n\\begin{itemize}\n\\item A\n\\end{itemize}\nEnd.'
    )
    expect(view.state.field(texGptField)).to.equal(null)
  })

  it('transforms a selection: Replace, or Insert below', async function () {
    fetchMock.post(CHAT, reply('<latex>the result</latex>'))
    const view = renderEditor('See teh result here.', { from: 4, to: 14 }, <TexGptButton />)
    openPopup()
    send('Fix the typo')
    const replace = await enabled(/^Replace/)
    expect(screen.getByRole('button', { name: 'Insert below' })).to.exist
    expect(requestBody().request.messages[0].content).to.include(
      '<context>\nSee <selection>teh result</selection> here.\n</context>'
    )
    fireEvent.click(replace)
    expect(view.state.doc.toString()).to.equal('See the result here.')
  })

  it('keeps the whitespace around a selection outside the markers', async function () {
    fetchMock.post(CHAT, reply('<latex>the result</latex>'))
    const view = renderEditor('See teh result here.', { from: 4, to: 15 }, <TexGptButton />)
    openPopup()
    send('Fix the typo')
    const replace = await enabled(/^Replace/)
    expect(requestBody().request.messages[0].content).to.include(
      '<context>\nSee <selection>teh result</selection> here.\n</context>'
    )
    fireEvent.click(replace)
    expect(view.state.doc.toString()).to.equal('See the result here.')
  })

  it('shows an answer without offering to insert it', async function () {
    fetchMock.post(CHAT, reply('<answer>Use the **twocolumn** option.</answer>'))
    renderEditor('Text', { from: 0, to: 0 }, <TexGptButton />)
    openPopup()
    send('How do I make two columns?')
    await screen.findByText('twocolumn')
    // Insert exists (disabled) while streaming; the finished answer has none
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /^Insert/ })).to.equal(null)
    )
    expect(screen.getByRole('button', { name: /Copy/ })).to.exist
  })

  it('suggests titles and replaces the existing one with the chosen title', async function () {
    fetchMock.post(CHAT, reply('<titles><t>First Title</t><t>Second Title</t></titles>'))
    const doc =
      '\\documentclass{article}\n\\title{Old}\n\\begin{document}\nBody text.\n\\end{document}'
    const view = renderEditor(doc, { from: doc.length, to: doc.length }, <TexGptButton />)
    openPopup()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Title Generator' }))
    const replace = await enabled('Replace title')
    expect(requestBody().request.messages[0].content).to.include('<paper>')
    expect(requestBody().request.messages[0].content).to.include('Body text.')
    fireEvent.click(screen.getByRole('radio', { name: 'Second Title' }))
    fireEvent.click(replace)
    expect(view.state.doc.toString()).to.equal(
      doc.replace('\\title{Old}', '\\title{Second Title}')
    )
  })

  it('refines the result with a follow-up', async function () {
    fetchMock.post(CHAT, reply('<latex>\\textbf{A}</latex>'))
    renderEditor('Text', { from: 0, to: 0 }, <TexGptButton />)
    openPopup()
    send('Bold A')
    await enabled(/^Insert/)

    fetchMock.removeRoutes().clearHistory()
    fetchMock.post(CHAT, reply('<latex>\\textit{A}</latex>'))
    fetchMock.put('/ai-assist/preferences', { preferences: null })
    expect(screen.getByPlaceholderText('Ask for changes, e.g. add a caption')).to.exist
    send('italic instead')
    await screen.findByText('2/2')
    expect(
      requestBody().request.messages.map((message: any) => message.role)
    ).to.deep.equal(['user', 'assistant', 'user'])
    expect(requestBody().request.messages[2].content).to.include('italic instead')
  })

  it('warns about a missing package and adds it to the preamble on Insert', async function () {
    fetchMock.post(CHAT, reply('<latex>\\toprule</latex>'))
    const doc = '\\documentclass{article}\n\\begin{document}\n\n\\end{document}'
    const pos = doc.indexOf('\n\n') + 1
    const view = renderEditor(doc, { from: pos, to: pos }, <TexGptButton />)
    openPopup()
    send('rule')
    await screen.findByText('Uses booktabs, which this project does not load')
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).to.equal(true)
    fireEvent.click(await enabled(/^Insert/))
    expect(view.state.doc.toString()).to.equal(
      '\\documentclass{article}\n\\usepackage{booktabs}\n\\begin{document}\n\\toprule\n\\end{document}'
    )
  })

  it('asks for a provider before sending anything', async function () {
    customLocalStorage.removeItem('ai-assist:provider')
    renderEditor('Text', { from: 0, to: 0 }, <TexGptButton />)
    openPopup()
    send('x')
    await screen.findByText('Set up an AI provider')
    expect(fetchMock.callHistory.calls(CHAT)).to.have.length(0)
  })

  it('asks for consent first when it was never given', async function () {
    customLocalStorage.removeItem('ai-assist:consent')
    fetchMock.post(CHAT, reply('<latex>x</latex>'))
    renderEditor('Text', { from: 0, to: 0 }, <TexGptButton />)
    openPopup()
    send('x')
    fireEvent.click(await screen.findByRole('button', { name: 'Allow and continue' }))
    await waitFor(() =>
      expect(fetchMock.callHistory.calls(CHAT)).to.have.length(1)
    )
  })

  it('closes on Escape from the menu', function () {
    const view = renderEditor('Text', { from: 0, to: 0 }, <TexGptButton />)
    openPopup()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(view.state.field(texGptField)).to.equal(null)
  })

  it('directly shows previous Writing Tools generation when opened on cached text', async function () {
    const doc = 'The results show positive trends.'
    const from = 4
    const to = 11
    saveWritingToolHistory({
      kind: 'writing-tool',
      originalText: 'results',
      action: 'synonyms',
      history: { versions: [], index: 0 },
      synonyms: ['findings', 'outcomes'],
      durationMs: 150,
      timestamp: Date.now(),
    })

    renderEditor(doc, { from, to }, <TexGptButton />)
    openPopup()
    expect(await screen.findByText('findings')).to.exist
    expect(fetchMock.callHistory.calls(CHAT)).to.have.length(0)
  })

  it('directly shows previous TeXGPT generation when opened on cached text', async function () {
    const doc = 'Important conclusions.'
    const from = 0
    const to = doc.length
    saveTexGptHistory({
      kind: 'texgpt',
      originalText: doc,
      run: {
        title: 'make bold',
        prompt: 'make bold',
        generator: null,
      },
      versions: [
        {
          kind: 'latex',
          text: '\\textbf{Important conclusions.}',
          packages: [],
          warnings: [],
          raw: '\\textbf{Important conclusions.}',
          messages: [],
        },
      ],
      index: 0,
      choice: 0,
      durationMs: 200,
      showDiff: true,
      addPackages: false,
      timestamp: Date.now(),
    })

    renderEditor(doc, { from, to }, <TexGptButton />)
    openPopup()
    expect(await screen.findByText(/make bold/)).to.exist
    expect(fetchMock.callHistory.calls(CHAT)).to.have.length(0)
  })
})
