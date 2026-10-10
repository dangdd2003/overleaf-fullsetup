import { expect } from 'chai'
import sinon from 'sinon'
import fetchMock from 'fetch-mock'
import { LanguageSupport } from '@codemirror/language'
import { EditorSelection, EditorState, Extension, Transaction } from '@codemirror/state'
import { autocompletion, completionStatus, startCompletion } from '@codemirror/autocomplete'
import { EditorView } from '@codemirror/view'
import customLocalStorage from '@/infrastructure/local-storage'
import { LaTeXLanguage } from '@/features/source-editor/languages/latex/latex-language'
import {
  inlineSuggestionEngine,
  suggestionField,
} from '../../../../frontend/js/features/ai-assist/inline-suggestion/engine'
import { openPromptOnSpace } from '../../../../frontend/js/features/ai-assist/empty-line-prompt/trigger'
import {
  inlinePopupExtension,
  inlinePopupField,
} from '../../../../frontend/js/features/ai-assist/inline-suggestion/popup-field'
import {
  forgetInlineSuggestionsPreferences,
  updateInlineSuggestionsPreferences,
} from '../../../../frontend/js/features/ai-assist/inline-suggestion/preferences'
import {
  autoCompletion,
  autoDelay,
  resetAutoCompletion,
} from '../../../../frontend/js/features/ai-assist/completion/auto'
import { resetCompletionRate } from '../../../../frontend/js/features/ai-assist/completion/rate'

const CHAT = '/ai-assist/providers/editor'

function makeView(doc: string, extra: Extension[] = []) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(doc.length),
      extensions: [
        new LanguageSupport(LaTeXLanguage),
        inlineSuggestionEngine(),
        inlinePopupExtension(),
        autoCompletion,
        ...extra,
      ],
    }),
    parent,
  })
}

function type(view: EditorView, insert: string) {
  const at = view.state.selection.main.head
  view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length }, userEvent: 'input.type' })
}

const requests = () => fetchMock.callHistory.calls(CHAT).length

/** Enough text to continue from, cursor at its end. */
const TEXT = 'Our method improves accuracy on every benchmark'

describe('completion: Automatic', function () {
  let clock: sinon.SinonFakeTimers

  beforeEach(function () {
    clock = sinon.useFakeTimers()
    ;(clock as any).tickAsync = async (ms: number) => {
      for (let i = 0; i < 10; i++) await Promise.resolve()
      clock.tick(ms)
      for (let i = 0; i < 10; i++) await Promise.resolve()
      clock.tick(0)
      for (let i = 0; i < 10; i++) await Promise.resolve()
    }
    document.body.innerHTML = ''
    customLocalStorage.clear()
    forgetInlineSuggestionsPreferences()
    resetCompletionRate()
    resetAutoCompletion()
    customLocalStorage.setItem('ai-assist:provider', {
      type: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'k',
      model: 'claude',
    })
    customLocalStorage.setItem('ai-assist:consent', true)
    fetchMock.removeRoutes().clearHistory()
    fetchMock.put('/ai-assist/preferences', { preferences: null })
    fetchMock.post(CHAT, {
      body: [{ type: 'text', text: 'works.' }, { type: 'done' }].map(c => JSON.stringify(c) + '\n').join(''),
      headers: { 'Content-Type': 'application/x-ndjson' },
    })
    updateInlineSuggestionsPreferences({ completionMode: 'automatic', completionDelayMs: 300 })
  })

  afterEach(function () {
    window.dispatchEvent(new Event('focus'))
    clock.restore()
    fetchMock.removeRoutes().clearHistory()
    customLocalStorage.clear()
    forgetInlineSuggestionsPreferences()
    resetCompletionRate()
    document.body.innerHTML = ''
  })

  it('asks once the author has stopped typing for the delay', async function () {
    const view = makeView(TEXT)
    type(view, ' ')
    await clock.tickAsync(299)
    expect(requests()).to.equal(0)
    await clock.tickAsync(1)
    expect(requests()).to.equal(1)
    view.destroy()
  })

  it('has no gap between requests: each pause in typing asks at once', async function () {
    const view = makeView(TEXT)
    type(view, ' ')
    await clock.tickAsync(300)
    expect(requests()).to.equal(1)
    type(view, '.')
    await clock.tickAsync(300)
    expect(requests()).to.equal(2)
    view.destroy()
  })

  it('restarts the wait on every keystroke', async function () {
    const view = makeView(TEXT)
    type(view, ',')
    await clock.tickAsync(200)
    type(view, ' ')
    await clock.tickAsync(200)
    expect(requests()).to.equal(0)
    await clock.tickAsync(100)
    expect(requests()).to.equal(1)
    view.destroy()
  })

  it('does nothing in Manual mode', async function () {
    updateInlineSuggestionsPreferences({ completionMode: 'manual' })
    const view = makeView(TEXT)
    type(view, ' ')
    await clock.tickAsync(1000)
    expect(requests()).to.equal(0)
    view.destroy()
  })

  it("ignores a collaborator's edit", async function () {
    const view = makeView('Our method')
    view.dispatch({ changes: { from: 0, insert: 'So ' }, annotations: Transaction.remote.of(true) })
    await clock.tickAsync(1000)
    expect(requests()).to.equal(0)
    view.destroy()
  })

  it('drops the wait when the cursor moves', async function () {
    const view = makeView(TEXT)
    type(view, ' ')
    await clock.tickAsync(100)
    view.dispatch({ selection: { anchor: 0 } })
    await clock.tickAsync(1000)
    expect(requests()).to.equal(0)
    view.destroy()
  })

  it('sends nothing for typing in a comment', async function () {
    const view = makeView('Text % not')
    type(view, 'e')
    await clock.tickAsync(1000)
    expect(requests()).to.equal(0)
    view.destroy()
  })

  it('stays silent when no model is set up', async function () {
    customLocalStorage.removeItem('ai-assist:provider')
    const view = makeView(TEXT)
    type(view, ' ')
    await clock.tickAsync(1000)
    expect(view.state.field(inlinePopupField)).to.equal(null)
    view.destroy()
  })

  it('sends nothing for pasting, dropping, cutting or undo', async function () {
    const view = makeView('Our method works on every benchmark')
    view.dispatch({ changes: { from: 35, insert: ' well' }, selection: { anchor: 40 }, userEvent: 'input.paste' })
    await clock.tickAsync(1000)
    view.dispatch({ changes: { from: 35, to: 40 }, selection: { anchor: 35 }, userEvent: 'delete.cut' })
    await clock.tickAsync(1000)
    view.dispatch({ changes: { from: 35, insert: ' x' }, selection: { anchor: 37 }, userEvent: 'undo' })
    await clock.tickAsync(1000)
    expect(requests()).to.equal(0)
    view.destroy()
  })

  it('asks after Backspace', async function () {
    const view = makeView(`${TEXT} wrng`)
    const end = view.state.doc.length
    view.dispatch({ changes: { from: end - 4, to: end }, selection: { anchor: end - 4 }, userEvent: 'delete.backward' })
    await clock.tickAsync(300)
    expect(requests()).to.equal(1)
    view.destroy()
  })

  it('asks on a new line after Enter, inside an item too', async function () {
    const doc = `\\begin{itemize}\n  \\item ${TEXT}`
    const view = makeView(doc)
    view.dispatch({
      changes: { from: doc.length, insert: '\n  ' },
      selection: { anchor: doc.length + 3 },
      userEvent: 'input',
    })
    await clock.tickAsync(300)
    expect(requests()).to.equal(1)
    view.destroy()
  })

  it('leaves an empty line to the Space prompt while that shortcut is on', async function () {
    updateInlineSuggestionsPreferences({ completionMode: 'automatic', completionDelayMs: 300, emptyLineShortcut: true })
    const view = makeView(TEXT)
    const end = view.state.doc.length
    view.dispatch({ changes: { from: end, insert: '\n' }, selection: { anchor: end + 1 }, userEvent: 'input' })
    await clock.tickAsync(1000)
    expect(requests()).to.equal(0)
    expect(view.state.field(suggestionField)).to.equal(null)
    // Space still opens the prompt there
    expect(openPromptOnSpace(view)).to.equal(true)
    view.destroy()
  })

  it('stays quiet at column 0 after a blank line: a new block starts', async function () {
    const view = makeView(`${TEXT}\n`)
    const end = view.state.doc.length
    view.dispatch({ changes: { from: end, insert: '\n' }, selection: { anchor: end + 1 }, userEvent: 'input' })
    await clock.tickAsync(1000)
    expect(requests()).to.equal(0)
    view.destroy()
  })

  it('asks at column 0 right after a line of the paragraph when the Space shortcut is off', async function () {
    const view = makeView(TEXT)
    const end = view.state.doc.length
    view.dispatch({ changes: { from: end, insert: '\n' }, selection: { anchor: end + 1 }, userEvent: 'input' })
    await clock.tickAsync(300)
    expect(requests()).to.equal(1)
    view.destroy()
  })

  it('asks at column 0 inside a list when the Space shortcut is off', async function () {
    const doc = `\\begin{itemize}\n\\item ${TEXT}`
    const view = makeView(doc)
    view.dispatch({ changes: { from: doc.length, insert: '\n' }, selection: { anchor: doc.length + 1 }, userEvent: 'input' })
    await clock.tickAsync(300)
    expect(requests()).to.equal(1)
    view.destroy()
  })

  it('asks after an autocomplete pick, not after a language-suggestion fix', async function () {
    const view = makeView(TEXT)
    view.dispatch({ changes: { from: 0, insert: 'So ' }, userEvent: 'input.language-suggestion' })
    await clock.tickAsync(1000)
    expect(requests()).to.equal(0)
    const end = view.state.doc.length
    view.dispatch({
      changes: { from: end, insert: ' \\item ' },
      selection: { anchor: end + 7 },
      userEvent: 'input.complete',
    })
    await clock.tickAsync(300)
    expect(requests()).to.equal(1)
    view.destroy()
  })

  it('sends nothing for typing inside a word', async function () {
    const view = makeView('Our metod works.')
    view.dispatch({ selection: { anchor: 7 } })
    type(view, 'h')
    await clock.tickAsync(1000)
    expect(requests()).to.equal(0)
    view.destroy()
  })

  it('asks after a word too: the model finishes it', async function () {
    const view = makeView(TEXT + ' and')
    type(view, 'r')
    await clock.tickAsync(300)
    expect(requests()).to.equal(1)
    view.destroy()
  })

  it('leaves citation keys and command names to LaTeX autocomplete', async function () {
    const cite = makeView(TEXT + ' \\cite{smith')
    type(cite, ',')
    await clock.tickAsync(1000)
    cite.destroy()
    const command = makeView(TEXT + ' \\')
    type(command, 'e')
    await clock.tickAsync(1000)
    command.destroy()
    expect(requests()).to.equal(0)
  })

  it('sends nothing while the author is away from the page', async function () {
    const view = makeView(TEXT)
    window.dispatchEvent(new Event('blur'))
    await clock.tickAsync(0)
    type(view, ',')
    await clock.tickAsync(1000)
    expect(requests()).to.equal(0)
    window.dispatchEvent(new Event('focus'))
    type(view, ' ')
    await clock.tickAsync(300)
    expect(requests()).to.equal(1)
    view.destroy()
  })

  it('closes a LaTeX autocomplete list left open where no command is typed, and asks', async function () {
    const list = autocompletion({
      override: [context => ({ from: context.pos, options: [{ label: '\\usepackage' }], filter: false })],
    })
    const view = makeView(`\\begin{document}\n${TEXT} where I\\documentclass{article}`, [list])
    type(view, ' ')
    startCompletion(view)
    await clock.tickAsync(50)
    expect(completionStatus(view.state)).to.not.equal(null)
    await clock.tickAsync(300)
    expect(completionStatus(view.state)).to.equal(null)
    expect(requests()).to.equal(1)
    view.destroy()
  })

  it('leaves the list to a command name being typed', async function () {
    const list = autocompletion({
      override: [context => ({ from: context.pos, options: [{ label: '\\itemsep' }], filter: false })],
    })
    const view = makeView(`${TEXT}\n\\ite`, [list])
    type(view, 'm')
    startCompletion(view)
    await clock.tickAsync(1000)
    expect(completionStatus(view.state)).to.not.equal(null)
    expect(requests()).to.equal(0)
    view.destroy()
  })

  it('waits longer while suggestions keep being ignored, up to 2 s', function () {
    expect([0, 1, 2, 3, 4, 9].map(ignored => autoDelay(300, ignored))).to.deep.equal([
      300, 300, 600, 1200, 2000, 2000,
    ])
    expect(autoDelay(1000, 9)).to.equal(2000)
  })
})
