import { expect } from 'chai'
import { ReactNode, useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
import InlinePopupHost from '../../../../frontend/js/features/ai-assist/components/inline-suggestion/inline-popup'
import {
  inlineSuggestionEngine,
  suggestionField,
} from '../../../../frontend/js/features/ai-assist/inline-suggestion/engine'
import {
  inlinePopupExtension,
  inlinePopupField,
  openInlinePopup,
} from '../../../../frontend/js/features/ai-assist/inline-suggestion/popup-field'
import { resetCompletionRate } from '../../../../frontend/js/features/ai-assist/completion/rate'

const CHAT = '/ai-assist/providers/editor'
const PLACEHOLDER = 'Ask TeXGPT for help with anything'
// "Intro.\n\nMore.": the empty line starts at 7
const DOC = 'Intro.\n\nMore.'

function setMeta({ enabled = true } = {}) {
  window.metaAttributesCache?.clear()
  document.head.innerHTML = enabled
    ? '<meta name="ol-aiAssistEnabled" data-type="boolean" content="">'
    : ''
}

function reply(text: string) {
  return {
    body: [{ type: 'text', text }, { type: 'done' }].map(c => JSON.stringify(c) + '\n').join(''),
    headers: { 'Content-Type': 'application/x-ndjson' },
  }
}

/** A real EditorView whose state reaches React the way the editor does it. */
function renderEditor(doc: string, cursor: number, ui: ReactNode = <InlinePopupHost />) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  let publish: (state: EditorState) => void = () => {}
  const view: EditorView = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(cursor),
      extensions: [new LanguageSupport(LaTeXLanguage), inlineSuggestionEngine(), inlinePopupExtension()],
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

function openBar(view: EditorView, pos = 7) {
  view.dispatch({ effects: openInlinePopup.of({ pos, mode: 'prompt' }) })
}

function send(text: string) {
  const input = screen.getByPlaceholderText(PLACEHOLDER)
  fireEvent.change(input, { target: { value: text } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

describe('inline suggestions: popup', function () {
  beforeEach(function () {
    resetCompletionRate()
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
    fetchMock.removeRoutes().clearHistory()
    customLocalStorage.clear()
  })

  it('renders nothing with AI off', function () {
    setMeta({ enabled: false })
    const view = renderEditor(DOC, 7)
    openBar(view)
    expect(screen.queryByPlaceholderText(PLACEHOLDER)).to.equal(null)
  })

  it('is the TeXGPT bar, in the TeXGPT popup classes', async function () {
    const view = renderEditor(DOC, 7)
    openBar(view)
    await screen.findByPlaceholderText(PLACEHOLDER)
    expect(document.querySelector('.ai-texgpt-popup.ai-inline-popup > .ai-texgpt-bar')).to.not.equal(null)
    expect(document.querySelector('.ai-texgpt-popup.has-result')).to.equal(null)
  })

  it('Space on an empty bar closes it and types one space', async function () {
    const view = renderEditor(DOC, 7)
    openBar(view)
    const input = await screen.findByPlaceholderText(PLACEHOLDER)
    fireEvent.keyDown(input, { key: ' ' })
    expect(view.state.field(inlinePopupField)).to.equal(null)
    expect(view.state.doc.toString()).to.equal('Intro.\n \nMore.')
    expect(view.state.selection.main.head).to.equal(8)
  })

  it('Backspace or Esc on an empty bar closes it and types nothing', async function () {
    const view = renderEditor(DOC, 7)
    openBar(view)
    fireEvent.keyDown(await screen.findByPlaceholderText(PLACEHOLDER), { key: 'Backspace' })
    expect(view.state.field(inlinePopupField)).to.equal(null)
    openBar(view)
    fireEvent.keyDown(await screen.findByPlaceholderText(PLACEHOLDER), { key: 'Escape' })
    expect(view.state.field(inlinePopupField)).to.equal(null)
    expect(view.state.doc.toString()).to.equal(DOC)
  })

  it('sends the prompt and streams the LaTeX in as ghost text; the bar closes', async function () {
    fetchMock.post(CHAT, reply('<latex>\\section{Symbols}</latex>'))
    const view = renderEditor(DOC, 7)
    openBar(view)
    await screen.findByPlaceholderText(PLACEHOLDER)
    send('add a section on symbols')
    await waitFor(() =>
      expect(view.state.field(suggestionField)).to.include({ text: '\\section{Symbols}', status: 'ready' })
    )
    expect(view.state.field(inlinePopupField)).to.equal(null)
    const body = JSON.parse(String(fetchMock.callHistory.calls(CHAT)[0].options.body))
    expect(body.request.messages[0].content).to.include('line="empty"')
    expect(body.request.messages[0].content).to.include('<request>\nadd a section on symbols\n</request>')
    expect(body.request.system).to.include('You are TeXGPT')
    view.destroy()
  })

  it('sends fast model as primary and main model as fallback when both are set up', async function () {
    customLocalStorage.setItem('ai-assist:fast-provider', {
      type: 'ollama',
      baseUrl: 'http://ollama:11434',
      apiKey: '',
      model: 'qwen3:4b',
    })
    fetchMock.post(CHAT, reply('<latex>\\section{Symbols}</latex>'))
    const view = renderEditor(DOC, 7)
    openBar(view)
    await screen.findByPlaceholderText(PLACEHOLDER)
    send('add a section on symbols')
    await waitFor(() =>
      expect(view.state.field(suggestionField)).to.include({ text: '\\section{Symbols}', status: 'ready' })
    )
    const body = JSON.parse(String(fetchMock.callHistory.calls(CHAT)[0].options.body))
    expect(body.providerSettings).to.include({ type: 'ollama', model: 'qwen3:4b' })
    expect(body.fallbackProviderSettings).to.include({ type: 'anthropic', model: 'claude' })
    view.destroy()
  })

  it('sends fast model directly when main model is not configured', async function () {
    customLocalStorage.removeItem('ai-assist:provider')
    customLocalStorage.setItem('ai-assist:fast-provider', {
      type: 'ollama',
      baseUrl: 'http://ollama:11434',
      apiKey: '',
      model: 'qwen3:4b',
    })
    fetchMock.post(CHAT, reply('<latex>\\section{Symbols}</latex>'))
    const view = renderEditor(DOC, 7)
    openBar(view)
    await screen.findByPlaceholderText(PLACEHOLDER)
    send('add a section on symbols')
    await waitFor(() =>
      expect(view.state.field(suggestionField)).to.include({ text: '\\section{Symbols}', status: 'ready' })
    )
    const body = JSON.parse(String(fetchMock.callHistory.calls(CHAT)[0].options.body))
    expect(body.providerSettings).to.include({ type: 'ollama', model: 'qwen3:4b' })
    expect(body.fallbackProviderSettings).to.be.undefined
    view.destroy()
  })

  it('says when no provider is set up', async function () {
    customLocalStorage.removeItem('ai-assist:provider')
    const view = renderEditor(DOC, 7)
    openBar(view)
    await screen.findByPlaceholderText(PLACEHOLDER)
    send('a table')
    expect(await screen.findByText('TeXGPT uses your AI provider. Set one up in your account settings.')).to.exist
    expect(document.querySelector('.ai-texgpt-popup.has-result .ai-texgpt-result-body')).to.not.equal(null)
  })

  it('asks for consent, then sends on Allow and continue', async function () {
    customLocalStorage.removeItem('ai-assist:consent')
    fetchMock.post(CHAT, reply('<latex>x</latex>'))
    const view = renderEditor(DOC, 7)
    openBar(view)
    await screen.findByPlaceholderText(PLACEHOLDER)
    send('a table')
    fireEvent.click(await screen.findByRole('button', { name: 'Allow and continue' }))
    await waitFor(() => expect(fetchMock.callHistory.calls(CHAT)).to.have.length(1))
    await waitFor(() => expect(view.state.field(suggestionField)?.text).to.equal('x'))
  })

  it('reopens with the prompt and the reason when TeXGPT cannot help', async function () {
    fetchMock.post(CHAT, reply('<cannot>Not possible here.</cannot>'))
    const view = renderEditor(DOC, 7)
    openBar(view)
    await screen.findByPlaceholderText(PLACEHOLDER)
    send('make coffee')
    expect(await screen.findByText('Not possible here.')).to.exist
    expect((screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement).value).to.equal('make coffee')
    expect(view.state.field(suggestionField)).to.equal(null)
  })

  it('shows the provider error under the bar', async function () {
    fetchMock.post(CHAT, { status: 500, body: { error: { code: 'providerError', message: 'Boom' } } })
    const view = renderEditor(DOC, 7)
    openBar(view)
    await screen.findByPlaceholderText(PLACEHOLDER)
    send('a table')
    expect((await screen.findByRole('alert')).textContent).to.include('Boom')
    expect(view.state.field(suggestionField)).to.equal(null)
  })

  it('a consent notice from Shift+Space runs the completion after Allow', async function () {
    customLocalStorage.removeItem('ai-assist:consent')
    fetchMock.post(CHAT, reply('outperforms it. More'))
    const view = renderEditor('Our method', 10)
    view.dispatch({ effects: openInlinePopup.of({ pos: 10, mode: 'notice', notice: { name: 'consent' } }) })
    expect(screen.queryByPlaceholderText(PLACEHOLDER)).to.equal(null)
    fireEvent.click(await screen.findByRole('button', { name: 'Allow and continue' }))
    await waitFor(() => expect(view.state.field(suggestionField)?.text).to.equal(' outperforms it.'))
    expect(view.state.field(inlinePopupField)).to.equal(null)
  })
})
