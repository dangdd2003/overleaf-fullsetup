import { expect } from 'chai'
import sinon from 'sinon'
import { useState } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import fetchMock from 'fetch-mock'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import customLocalStorage from '@/infrastructure/local-storage'
import {
  CodeMirrorStateContext,
  CodeMirrorViewContext,
} from '@/features/source-editor/components/codemirror-context'
import { SuggestionCard, shortLatex } from '../../../../frontend/js/features/ai-assist/components/language-suggestions/suggestion-card'
import { BlockedSuggestionsModal } from '../../../../frontend/js/features/ai-assist/components/language-suggestions/blocked-suggestions-modal'
import SuggestionCardHost from '../../../../frontend/js/features/ai-assist/components/language-suggestions/suggestion-card-host'
import { editsForRewrite } from '../../../../frontend/js/features/ai-assist/language-suggestions/edits'
import {
  blockSuggestion,
  forgetLanguageSuggestionsPreferences,
} from '../../../../frontend/js/features/ai-assist/language-suggestions/preferences'
import {
  languageSuggestionsField,
  openCard,
  setUnitResults,
  UnitSuggestions,
} from '../../../../frontend/js/features/ai-assist/language-suggestions/state'
import { buildUnits } from '../../../../frontend/js/features/ai-assist/language-suggestions/units'

const SENTENCE = 'The results shows that the accuracy improve today.'
const FIXED = 'The results show that the accuracy improves today.'

function setMeta() {
  window.metaAttributesCache?.clear()
  document.head.innerHTML = '<meta name="ol-aiAssistEnabled" data-type="boolean" content="">'
}

function suggestionsFor(doc: string, rewrite: string): UnitSuggestions {
  const [unit] = buildUnits(doc)
  return {
    hash: unit.hash,
    from: unit.from,
    to: unit.to,
    masked: unit.masked,
    edits: editsForRewrite(unit.masked, rewrite) ?? [],
  }
}

function handlers() {
  return {
    onAccept: sinon.spy(),
    onReject: sinon.spy(),
    onBlock: sinon.spy(),
    onActivate: sinon.spy(),
    onClose: sinon.spy(),
  }
}

describe('language suggestions: card', function () {
  beforeEach(function () {
    setMeta()
    document.body.innerHTML = ''
    customLocalStorage.clear()
    forgetLanguageSuggestionsPreferences()
    fetchMock.removeRoutes().clearHistory()
    fetchMock.put('/ai-assist/preferences', { preferences: null })
  })

  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
    customLocalStorage.clear()
    forgetLanguageSuggestionsPreferences()
  })

  it('shows the sentence with each change struck through and in bold', function () {
    render(<SuggestionCard unit={suggestionsFor(SENTENCE, FIXED)} active={null} {...handlers()} />)
    const card = screen.getByTestId('language-suggestion-card')
    expect([...card.querySelectorAll('del')].map(e => e.textContent)).to.deep.equal(['shows', 'improve'])
    expect([...card.querySelectorAll('ins')].map(e => e.textContent)).to.deep.equal(['show', 'improves'])
  })

  it('toggles each change, then accepts the choices or rejects them all', function () {
    const spies = handlers()
    render(<SuggestionCard unit={suggestionsFor(SENTENCE, FIXED)} active={1} {...spies} />)
    const change = screen.getByRole('button', { name: /Change "improve" to "improves"/ })
    expect(change.getAttribute('title')).to.equal('Click to keep your text')
    fireEvent.click(change)
    expect(change.getAttribute('aria-pressed')).to.equal('false')
    expect(change.getAttribute('title')).to.equal('Click to accept this suggestion')
    expect(spies.onAccept).not.to.have.been.called
    fireEvent.click(screen.getByRole('button', { name: 'Accept 1' }))
    expect(spies.onAccept).to.have.been.calledWith([0], [1])
    fireEvent.click(change)
    fireEvent.click(screen.getByRole('button', { name: 'Accept 2' }))
    expect(spies.onAccept).to.have.been.calledWith([0, 1], [])
    fireEvent.click(screen.getByRole('button', { name: 'Reject 2' }))
    expect(spies.onReject).to.have.been.calledWith([0, 1])
    fireEvent.click(screen.getByRole('button', { name: 'Block this suggestion' }))
    expect(spies.onBlock).to.have.been.calledWith(1)
  })

  it('wraps each change as an inline span, toggled from the keyboard too', function () {
    const spies = handlers()
    render(<SuggestionCard unit={suggestionsFor(SENTENCE, FIXED)} active={null} {...spies} />)
    const change = screen.getByRole('button', { name: /Change "shows" to "show"/ })
    expect(change.tagName).to.equal('SPAN')
    fireEvent.keyDown(change, { key: 'Enter' })
    expect(change.getAttribute('aria-pressed')).to.equal('false')
    fireEvent.keyDown(change, { key: ' ' })
    expect(change.getAttribute('aria-pressed')).to.equal('true')
    expect(spies.onAccept).not.to.have.been.called
  })

  it('previews the sentence as Accept would write it', function () {
    render(<SuggestionCard unit={suggestionsFor(SENTENCE, FIXED)} active={null} {...handlers()} />)
    fireEvent.click(screen.getByRole('button', { name: /Change "shows" to "show"/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Show changes' }))
    expect(screen.getByTestId('language-suggestion-card').textContent).to.contain(
      'The results shows that the accuracy improves today.'
    )
  })

  it('accepts all on Enter and closes on Escape', function () {
    const spies = handlers()
    render(<SuggestionCard unit={suggestionsFor(SENTENCE, FIXED)} active={null} {...spies} />)
    const card = screen.getByTestId('language-suggestion-card')
    fireEvent.keyDown(card, { key: 'Enter' })
    expect(spies.onAccept).to.have.been.calledWith([0, 1], [])
    fireEvent.keyDown(card, { key: 'Escape' })
    expect(spies.onClose).to.have.been.calledOnce
  })

  it('switches between the changes and the clean sentence, and remembers it', function () {
    render(<SuggestionCard unit={suggestionsFor(SENTENCE, FIXED)} active={null} {...handlers()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show changes' }))
    expect(screen.queryByRole('button', { name: /Change "shows"/ })).to.equal(null)
    const card = screen.getByTestId('language-suggestion-card')
    expect(card.querySelectorAll('del')).to.have.length(0)
    expect(card.textContent).to.contain('The results show that the accuracy improves today.')
    expect(customLocalStorage.getItem('ai-assist:writing-tools').showDiff).to.equal(false)
  })

  it('shows a punctuation change with the word it sticks to', function () {
    const doc = 'First we test it here.'
    render(
      <SuggestionCard
        unit={suggestionsFor(doc, 'First, we test it here.')}
        active={null}
        {...handlers()}
      />
    )
    const card = screen.getByTestId('language-suggestion-card')
    expect(card.querySelector('del')?.textContent).to.equal('First')
    expect(card.querySelector('ins')?.textContent).to.equal('First,')
    expect(card.querySelector('.ai-language-suggestion-card-text')?.textContent).to.equal('FirstFirst, we test it here.')
  })

  it('allows pinning and unpinning the card', function () {
    render(<SuggestionCard unit={suggestionsFor(SENTENCE, FIXED)} active={null} {...handlers()} />)
    const card = screen.getByTestId('language-suggestion-card')
    expect(card.classList.contains('ai-language-suggestion-card-pinned')).to.be.false
    const pinBtn = screen.getByRole('button', { name: 'Pin the card' })
    fireEvent.click(pinBtn)
    expect(card.classList.contains('ai-language-suggestion-card-pinned')).to.be.true
    expect(screen.getByRole('button', { name: 'Unpin the card' })).to.exist
    fireEvent.click(screen.getByRole('button', { name: 'Unpin the card' }))
    expect(card.classList.contains('ai-language-suggestion-card-pinned')).to.be.false
  })

  it('shows the LaTeX behind each placeholder, shortened', function () {
    const doc = 'As shown by \\citet{smith2020deep} the method is fast.'
    render(
      <SuggestionCard
        unit={suggestionsFor(doc, 'As shown by [[C1]] the method is quick.')}
        active={null}
        {...handlers()}
      />
    )
    expect(screen.getByTestId('language-suggestion-card').querySelector('code')?.textContent).to.equal(
      '\\citet{…}'
    )
    expect(shortLatex('$x$')).to.equal('$x$')
    expect(shortLatex('$a + b + c + d + e + f$')).to.equal('$…$')
  })

  it('lists blocked suggestions, newest first, and removes one', async function () {
    blockSuggestion('data is', 'data are', 1)
    blockSuggestion('plans,', 'planning,', 2)
    render(<BlockedSuggestionsModal show onHide={() => {}} />)
    expect(await screen.findByText('Blocked Language Suggestions')).to.exist
    const rows = screen.getAllByRole('row').slice(1)
    expect(
      rows.map(row => [...row.querySelectorAll('td')].slice(0, 2).map(td => td.textContent))
    ).to.deep.equal([
      ['plans,', 'planning,'],
      ['data is', 'data are'],
    ])
    fireEvent.click(within(rows[0]).getByRole('button', { name: /Remove "plans,"/ }))
    await waitFor(() => expect(screen.getAllByRole('row')).to.have.length(2))
  })

  it('explains blocking, with an interactive unblurred preview card, when nothing is blocked', async function () {
    render(<BlockedSuggestionsModal show onHide={() => {}} />)
    expect(await screen.findByText(/You can block a suggestion from appearing again/)).to.exist
    const preview = screen.getByTestId('language-suggestion-preview')
    expect(preview.getAttribute('aria-hidden')).to.equal('true')
    expect(preview.querySelector('del')?.textContent).to.equal('plans,')
    expect(preview.querySelector('ins')?.textContent).to.equal('planning,')
    expect(preview.querySelector('.ai-language-suggestion-plain-text')).to.exist
    const change = preview.querySelector('.ai-language-suggestion-change')
    expect(change).to.exist
    expect(change?.getAttribute('aria-disabled')).to.be.null

    // The user can interact with the change words in the preview box
    expect(within(preview).getByRole('button', { name: /Accept 1/, hidden: true })).to.exist
    fireEvent.click(change!)
    expect(within(preview).getByRole('button', { name: /Accept 0/, hidden: true })).to.exist
    fireEvent.click(change!)
    expect(within(preview).getByRole('button', { name: /Accept 1/, hidden: true })).to.exist

    // Diff view can be toggled in preview
    const diffBtn = within(preview).getByRole('button', { name: 'Show changes', hidden: true })
    fireEvent.click(diffBtn)
    expect(preview.textContent).to.contain('planning,')
  })

  it('opens in the editor under the clicked sentence and applies Accept', async function () {
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
            <SuggestionCardHost />
          </CodeMirrorStateContext.Provider>
        </CodeMirrorViewContext.Provider>
      )
    }
    render(<Harness />)
    const unit = suggestionsFor(SENTENCE, FIXED)
    view.dispatch({ effects: setUnitResults.of([unit]) })
    view.dispatch({ effects: openCard.of({ hash: unit.hash, from: unit.from, edit: 0 }) })

    fireEvent.click(await screen.findByRole('button', { name: 'Accept 2' }))
    expect(view.state.doc.toString()).to.equal(FIXED)
    view.destroy()
  })

  it('pins card in SuggestionCardHost and keeps it holding when clicking elsewhere', async function () {
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
            <SuggestionCardHost />
          </CodeMirrorStateContext.Provider>
        </CodeMirrorViewContext.Provider>
      )
    }
    render(<Harness />)
    const unit = suggestionsFor(SENTENCE, FIXED)
    view.dispatch({ effects: setUnitResults.of([unit]) })
    view.dispatch({ effects: openCard.of({ hash: unit.hash, from: unit.from, edit: 0 }) })

    const pinBtn = await screen.findByRole('button', { name: 'Pin the card' })
    fireEvent.click(pinBtn)

    expect(screen.getByRole('button', { name: 'Unpin the card' })).to.exist

    // Click outside on document body
    fireEvent.mouseDown(document.body)

    // The pinned card is STILL holding on screen!
    expect(screen.getByTestId('language-suggestion-card')).to.exist
    expect(screen.getByRole('button', { name: 'Unpin the card' })).to.exist

    view.destroy()
  })
})
