import { expect } from 'chai'
import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import customLocalStorage from '@/infrastructure/local-storage'
import {
  CodeMirrorStateContext,
  CodeMirrorViewContext,
} from '@/features/source-editor/components/codemirror-context'
import LanguageSuggestionsToolbarControl from '../../../../frontend/js/features/ai-assist/components/language-suggestions/toolbar-control'
import { editsForRewrite } from '../../../../frontend/js/features/ai-assist/language-suggestions/edits'
import { forgetLanguageSuggestionsPreferences } from '../../../../frontend/js/features/ai-assist/language-suggestions/preferences'
import {
  languageSuggestionsField,
  setStatus,
  setUnitResults,
} from '../../../../frontend/js/features/ai-assist/language-suggestions/state'
import { buildUnits } from '../../../../frontend/js/features/ai-assist/language-suggestions/units'

const SENTENCE = 'The results shows that the accuracy improve today.'
const FIXED = 'The results show that the accuracy improves today.'

function setMeta() {
  window.metaAttributesCache?.clear()
  document.head.innerHTML = '<meta name="ol-aiAssistEnabled" data-type="boolean" content="">'
}

function renderToolbar() {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  let publish: (state: EditorState) => void = () => {}
  const view: EditorView = new EditorView({
    state: EditorState.create({ doc: SENTENCE, extensions: [languageSuggestionsField] }),
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
          <LanguageSuggestionsToolbarControl />
        </CodeMirrorStateContext.Provider>
      </CodeMirrorViewContext.Provider>
    )
  }
  const result = render(<Harness />)
  const [unit] = buildUnits(SENTENCE)
  view.dispatch({
    effects: setUnitResults.of([
      {
        hash: unit.hash,
        from: unit.from,
        to: unit.to,
        masked: unit.masked,
        edits: editsForRewrite(unit.masked, FIXED) ?? [],
      },
    ]),
  })
  return { view, ...result }
}

describe('language suggestions: toolbar control', function () {
  beforeEach(function () {
    setMeta()
    document.body.innerHTML = ''
    customLocalStorage.clear()
    forgetLanguageSuggestionsPreferences()
    customLocalStorage.setItem('ai-assist:provider', { type: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'k', model: 'claude' })
    customLocalStorage.setItem('ai-assist:fast-provider', {
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'k',
      model: 'gpt-mini',
    })
    customLocalStorage.setItem('ai-assist:consent', true)
    customLocalStorage.setItem('ai-assist:language-suggestions', { enabled: true })
  })

  afterEach(function () {
    customLocalStorage.clear()
    forgetLanguageSuggestionsPreferences()
  })

  it('is hidden while suggestions are turned off', function () {
    customLocalStorage.setItem('ai-assist:language-suggestions', { enabled: false })
    forgetLanguageSuggestionsPreferences()
    const { container, view } = renderToolbar()
    expect(container.textContent).to.equal('')
    view.destroy()
  })

  it('counts the suggestions and steps through them, opening each card', async function () {
    const { view } = renderToolbar()
    fireEvent.click(await screen.findByRole('button', { name: '2 language suggestions' }))
    expect(view.state.selection.main.head).to.equal(SENTENCE.indexOf('shows'))
    expect(view.state.field(languageSuggestionsField).card?.edit).to.equal(0)

    fireEvent.click(screen.getByRole('button', { name: 'Next suggestion' }))
    expect(view.state.selection.main.head).to.equal(SENTENCE.indexOf('improve'))
    expect(view.state.field(languageSuggestionsField).card?.edit).to.equal(1)

    fireEvent.click(screen.getByRole('button', { name: 'Previous suggestion' }))
    expect(view.state.field(languageSuggestionsField).card?.edit).to.equal(0)
    view.destroy()
  })

  it('shows that a check is running', async function () {
    const { view } = renderToolbar()
    view.dispatch({ effects: setStatus.of({ kind: 'checking' }) })
    expect(await screen.findByRole('button', { name: /Checking…/ })).to.exist
    view.destroy()
  })

  it('shows a failure and opens the settings at the toggle', async function () {
    const { view } = renderToolbar()
    view.dispatch({
      effects: setStatus.of({ kind: 'error', message: 'Upstream down. Retrying in 5 s.' }),
    })
    const events: string[] = []
    const onToggle = (event: Event) => events.push(`toggle:${(event as CustomEvent).detail}`)
    const onFocus = (event: Event) => events.push(`focus:${(event as CustomEvent).detail}`)
    window.addEventListener('ui.toggle-settings', onToggle)
    window.addEventListener('ui.focus-setting', onFocus)
    try {
      fireEvent.click(await screen.findByRole('button', { name: 'Upstream down. Retrying in 5 s.' }))
    } finally {
      window.removeEventListener('ui.toggle-settings', onToggle)
      window.removeEventListener('ui.focus-setting', onFocus)
    }
    expect(events).to.deep.equal(['toggle:true', 'focus:aiLanguageSuggestions'])
    view.destroy()
  })
})
