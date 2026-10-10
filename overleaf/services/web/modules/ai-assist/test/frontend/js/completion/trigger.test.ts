import { expect } from 'chai'
import { waitFor } from '@testing-library/react'
import fetchMock from 'fetch-mock'
import { LanguageSupport } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { autocompletion, completionStatus, startCompletion } from '@codemirror/autocomplete'
import customLocalStorage from '@/infrastructure/local-storage'
import { LaTeXLanguage } from '@/features/source-editor/languages/latex/latex-language'
import {
  cancelSuggestion,
  inlineSuggestionEngine,
  suggestionField,
} from '../../../../frontend/js/features/ai-assist/inline-suggestion/engine'
import {
  inlinePopupExtension,
  inlinePopupField,
} from '../../../../frontend/js/features/ai-assist/inline-suggestion/popup-field'
import {
  forgetInlineSuggestionsPreferences,
  updateInlineSuggestionsPreferences,
} from '../../../../frontend/js/features/ai-assist/inline-suggestion/preferences'
import { completeAtCursor, THINKING_ALLOWANCE } from '../../../../frontend/js/features/ai-assist/completion/trigger'
import { COMPLETION_SYSTEM, CURSOR } from '../../../../frontend/js/features/ai-assist/completion/prompt'
import { resetCompletionRate } from '../../../../frontend/js/features/ai-assist/completion/rate'

const CHAT = '/ai-assist/providers/editor'

function ndjson(...chunks: object[]) {
  return {
    body: [...chunks, { type: 'done' }].map(c => JSON.stringify(c) + '\n').join(''),
    headers: { 'Content-Type': 'application/x-ndjson' },
  }
}

function makeView(doc: string, from: number, to = from) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(from, to),
      extensions: [new LanguageSupport(LaTeXLanguage), inlineSuggestionEngine(), inlinePopupExtension()],
    }),
    parent,
  })
}

function sentBody(url: string) {
  return JSON.parse(String(fetchMock.callHistory.calls(url)[0].options.body))
}

function useFastModel() {
  customLocalStorage.setItem('ai-assist:fast-provider', {
    type: 'ollama',
    baseUrl: 'http://ollama:11434',
    apiKey: '',
    model: 'qwen3:4b',
  })
}

describe('completion: Shift+Space', function () {
  beforeEach(function () {
    document.body.innerHTML = ''
    customLocalStorage.clear()
    forgetInlineSuggestionsPreferences()
    resetCompletionRate()
    customLocalStorage.setItem('ai-assist:provider', {
      type: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'k',
      model: 'claude',
    })
    customLocalStorage.setItem('ai-assist:consent', true)
    fetchMock.removeRoutes().clearHistory()
    fetchMock.put('/ai-assist/preferences', { preferences: null })
    updateInlineSuggestionsPreferences({ completionMode: 'manual' })
  })

  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
    customLocalStorage.clear()
    forgetInlineSuggestionsPreferences()
    resetCompletionRate()
    document.body.innerHTML = ''
  })

  it('does nothing while completion is disabled', function () {
    updateInlineSuggestionsPreferences({ completionMode: 'disabled' })
    const view = makeView('Our method', 10)
    expect(completeAtCursor(view)).to.equal(false)
    view.destroy()
  })

  it('refuses in a comment and with a selection', function () {
    const comment = makeView('Text % note', 11)
    expect(completeAtCursor(comment)).to.equal(false)
    comment.destroy()
    const selected = makeView('Our method', 0, 3)
    expect(completeAtCursor(selected)).to.equal(false)
    selected.destroy()
  })

  it('streams a chat completion at the end of a sentence', async function () {
    fetchMock.post(CHAT, ndjson({ type: 'text', text: 'outperforms the baseline. Then more' }))
    const view = makeView('Our method', 10)
    expect(completeAtCursor(view)).to.equal(true)
    await waitFor(() =>
      expect(view.state.field(suggestionField)).to.include({
        text: ' outperforms the baseline.',
        status: 'ready',
        source: 'completion',
      })
    )
    const body = sentBody(CHAT)
    expect(body.request.system).to.equal(COMPLETION_SYSTEM)
    expect(body.request.messages[0].content).to.include(`<excerpt start="document">\nOur method${CURSOR}\n</excerpt>`)
    expect(body.request.messages[0].content).to.include('<task>')
    // The kind's budget, and room for a reasoning model to think first
    expect(body.request.maxTokens).to.equal(160 + THINKING_ALLOWANCE)
    view.destroy()
  })

  it('types a space where words follow the cursor on its line: no gap is filled', function () {
    fetchMock.post(CHAT, ndjson({ type: 'text', text: 'x' }))
    const view = makeView('Our method works', 4)
    expect(completeAtCursor(view)).to.equal(false)
    expect(fetchMock.callHistory.calls(CHAT)).to.have.length(0)
    view.destroy()
  })

  it('regenerating tells the model which words the author dismissed', async function () {
    fetchMock.post(CHAT, ndjson({ type: 'text', text: 'outperforms it.' }))
    const view = makeView('Our method', 10)
    completeAtCursor(view)
    await waitFor(() => expect(view.state.field(suggestionField)?.status).to.equal('ready'))
    expect(sentBody(CHAT).request.messages[0].content).to.not.include('dismissed')
    completeAtCursor(view)
    await waitFor(() => expect(fetchMock.callHistory.calls(CHAT)).to.have.length(2), { timeout: 3000 })
    const second = JSON.parse(String(fetchMock.callHistory.calls(CHAT)[1].options.body))
    expect(second.request.messages[0].content).to.include(
      'The author dismissed this suggestion; write a different continuation: "outperforms it."'
    )
    view.destroy()
  })

  it('sends fast model as primary and main model as fallback when both are set up', async function () {
    useFastModel()
    fetchMock.post(CHAT, ndjson({ type: 'text', text: 'outperforms it.' }))
    const view = makeView('Our method', 10)
    completeAtCursor(view)
    await waitFor(() => expect(view.state.field(suggestionField)?.status).to.equal('ready'))
    const body = sentBody(CHAT)
    expect(body.providerSettings).to.include({ type: 'ollama', model: 'qwen3:4b' })
    expect(body.fallbackProviderSettings).to.include({ type: 'anthropic', model: 'claude' })
    view.destroy()
  })

  it('sends main model directly when fast model is not configured', async function () {
    fetchMock.post(CHAT, ndjson({ type: 'text', text: 'outperforms it.' }))
    const view = makeView('Our method', 10)
    completeAtCursor(view)
    await waitFor(() => expect(view.state.field(suggestionField)?.status).to.equal('ready'))
    const body = sentBody(CHAT)
    expect(body.providerSettings).to.include({ type: 'anthropic', model: 'claude' })
    expect(body.fallbackProviderSettings).to.be.undefined
    view.destroy()
  })

  it('asks the model again on every press, never reusing the last suggestion', async function () {
    let call = 0
    fetchMock.post(CHAT, () => ndjson({ type: 'text', text: ++call === 1 ? 'outperforms it.' : 'beats it.' }))
    const view = makeView('Our method', 10)
    completeAtCursor(view)
    await waitFor(() =>
      expect(view.state.field(suggestionField)).to.include({ text: ' outperforms it.', status: 'ready' })
    )
    // Again while it shows: replaced, after the 1 s gap
    expect(completeAtCursor(view)).to.equal(true)
    expect(view.state.field(suggestionField)?.text ?? '').to.not.equal(' outperforms it.')
    await waitFor(
      () => expect(view.state.field(suggestionField)).to.include({ text: ' beats it.', status: 'ready' }),
      { timeout: 3000 }
    )
    expect(fetchMock.callHistory.calls(CHAT)).to.have.length(2)
    view.destroy()
  })

  it('regenerates with Shift+Space in Automatic too', async function () {
    updateInlineSuggestionsPreferences({ completionMode: 'automatic' })
    fetchMock.post(CHAT, ndjson({ type: 'text', text: 'outperforms it.' }))
    const view = makeView('Our method', 10)
    expect(completeAtCursor(view)).to.equal(true)
    await waitFor(() =>
      expect(view.state.field(suggestionField)).to.include({ status: 'ready', source: 'completion' })
    )
    view.destroy()
  })

  it('takes over from a LaTeX autocomplete list that is open or still loading', async function () {
    fetchMock.post(CHAT, ndjson({ type: 'text', text: 'outperforms it.' }))
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({
      state: EditorState.create({
        doc: 'Our method',
        selection: EditorSelection.single(10),
        extensions: [
          new LanguageSupport(LaTeXLanguage),
          inlineSuggestionEngine(),
          inlinePopupExtension(),
          // A source that never answers: the list stays "pending"
          autocompletion({ override: [() => new Promise(() => {})], activateOnTypingDelay: 0 }),
        ],
      }),
      parent,
    })
    startCompletion(view)
    expect(completionStatus(view.state)).to.not.equal(null)
    expect(completeAtCursor(view)).to.equal(true)
    expect(completionStatus(view.state)).to.equal(null)
    await waitFor(() =>
      expect(view.state.field(suggestionField)).to.include({ text: ' outperforms it.', status: 'ready' })
    )
    view.destroy()
  })

  it('replaces an error notice at the cursor instead of typing a space', async function () {
    let call = 0
    fetchMock.post(CHAT, () =>
      ++call === 1
        ? { status: 500, body: { error: { code: 'providerError', message: 'Boom' } } }
        : ndjson({ type: 'text', text: 'outperforms it.' })
    )
    const view = makeView('Our method', 10)
    completeAtCursor(view)
    await waitFor(() => expect(view.state.field(inlinePopupField)?.mode).to.equal('notice'))
    expect(completeAtCursor(view)).to.equal(true)
    expect(view.state.field(inlinePopupField)).to.equal(null)
    await waitFor(
      () => expect(view.state.field(suggestionField)).to.include({ text: ' outperforms it.', status: 'ready' }),
      { timeout: 3000 }
    )
    view.destroy()
  })

  it('tells the model where the cursor is, and keeps a table reply inside the table', async function () {
    const doc =
      '\\begin{table}[h]\n  \\centering\n  \\begin{tabular}{|l|c|r|}\n    Name & Size & Time \\\\\n    Ours & '
    const after = '\n  \\end{tabular}\n\\end{table}'
    fetchMock.post(
      CHAT,
      ndjson({
        type: 'text',
        text: '12 & 3 \\\\\n\\begin{table}\n\\begin{tabular}{lll}\na & b & c\n\\end{tabular}\n\\end{table}',
      })
    )
    const view = makeView(doc + after, doc.length)
    expect(completeAtCursor(view)).to.equal(true)
    await waitFor(() => expect(view.state.field(suggestionField)?.status).to.equal('ready'))
    expect(view.state.field(suggestionField)!.text).to.equal('12 & 3 \\\\')
    const message = sentBody(CHAT).request.messages[0].content
    expect(message).to.include('cell 2 of a row of the table \\begin{tabular}{|l|c|r|} (3 columns)')
    expect(message).to.include('Its first row is: Name & Size & Time')
    view.destroy()
  })

  it('starts what follows a heading on the next line', async function () {
    const doc = 'Some text before it.\n\n\\section{Method}'
    fetchMock.post(CHAT, ndjson({ type: 'text', text: '\\begin{itemize}\n\\item First step' }))
    const view = makeView(doc, doc.length)
    completeAtCursor(view)
    await waitFor(() => expect(view.state.field(suggestionField)?.status).to.equal('ready'))
    expect(view.state.field(suggestionField)!.text.startsWith('\n\\begin{itemize}')).to.equal(true)
    expect(sentBody(CHAT).request.messages[0].content).to.include('\\section{Method}')
    view.destroy()
  })

  it('shows the table a sentence announces, on the next lines, whole', async function () {
    const doc =
      '\\documentclass{article}\n\\begin{document}\nI am excited to continue growing as a computer scientist.\n' +
      'Here are the example of table latex code: below is a simple table demonstrating the use of the tabular environment. ' +
      'You can also include vertical bars in the column specification to draw lines between columns, and use ' +
      '\\texttt{\\textbackslash hline} to insert horizontal rules separating rows. This is the example tables: '
    const after = '\n\n\\end{document}'
    const table = [
      '\\begin{table}[h]',
      '    \\centering',
      '    \\begin{tabular}{|l|c|r|}',
      '        \\hline',
      '        Left & Center & Right \\\\',
      '        \\hline',
      '        a & b & c \\\\',
      '        d & e & f \\\\',
      '        \\hline',
      '    \\end{tabular}',
      '    \\caption{An example table.}',
      '    \\label{tab:example}',
      '\\end{table}',
    ].join('\n')
    fetchMock.post(CHAT, ndjson({ type: 'text', text: `${table}\n\nThe table above shows it.` }))
    const view = makeView(doc + after, doc.length)
    expect(completeAtCursor(view)).to.equal(true)
    await waitFor(() => expect(view.state.field(suggestionField)?.status).to.equal('ready'))
    expect(view.state.field(suggestionField)!.text).to.equal(`\n${table}`)
    const body = sentBody(CHAT).request
    expect(body.maxTokens).to.equal(700 + THINKING_ALLOWANCE)
    expect(body.messages[0].content).to.include('announces a table')
    expect(body.messages[0].content).to.not.include('Never open \\begin{table}')
    view.destroy()
  })

  it('asks for consent at the cursor first', function () {
    customLocalStorage.removeItem('ai-assist:consent')
    const view = makeView('Our method', 10)
    expect(completeAtCursor(view)).to.equal(true)
    expect(view.state.field(inlinePopupField)).to.include({ mode: 'notice', pos: 10 })
    expect(view.state.field(inlinePopupField)!.notice).to.deep.equal({ name: 'consent' })
    expect(fetchMock.callHistory.calls(CHAT)).to.have.length(0)
    view.destroy()
  })

  it('says when no provider is set up', function () {
    customLocalStorage.removeItem('ai-assist:provider')
    const view = makeView('Our method', 10)
    expect(completeAtCursor(view)).to.equal(true)
    expect(view.state.field(inlinePopupField)!.notice).to.deep.equal({ name: 'noProvider' })
    view.destroy()
  })

  it('sends fast model directly when main model is not configured', async function () {
    customLocalStorage.removeItem('ai-assist:provider')
    useFastModel()
    fetchMock.post(CHAT, ndjson({ type: 'text', text: 'outperforms it.' }))
    const view = makeView('Our method', 10)
    completeAtCursor(view)
    await waitFor(() => expect(view.state.field(suggestionField)?.status).to.equal('ready'))
    const body = sentBody(CHAT)
    expect(body.providerSettings).to.include({ type: 'ollama', model: 'qwen3:4b' })
    expect(body.fallbackProviderSettings).to.be.undefined
    view.destroy()
  })

  it("shows the provider's error at the cursor", async function () {
    fetchMock.post(CHAT, { status: 500, body: { error: { code: 'providerError', message: 'Boom' } } })
    const view = makeView('Our method', 10)
    completeAtCursor(view)
    await waitFor(() =>
      expect(view.state.field(inlinePopupField)?.notice).to.include({ name: 'error', message: 'Boom' })
    )
    expect(view.state.field(suggestionField)).to.equal(null)
    view.destroy()
  })
})
