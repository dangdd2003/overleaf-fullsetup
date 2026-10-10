import { expect } from 'chai'
import { fireEvent, render, screen } from '@testing-library/react'
import fetchMock from 'fetch-mock'
import customLocalStorage from '@/infrastructure/local-storage'
import useLanguageSuggestionsSection, {
  NO_PROVIDER_TEXT,
} from '../../../../frontend/js/features/ai-assist/components/language-suggestions/language-suggestions-section'
import {
  forgetLanguageSuggestionsPreferences,
  readLanguageSuggestionsPreferences,
} from '../../../../frontend/js/features/ai-assist/language-suggestions/preferences'

const MAIN = {
  type: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'k',
  model: 'claude-opus-5-5',
  modelName: 'Claude Opus 5.5',
}

const FAST = {
  type: 'ollama',
  baseUrl: 'http://ollama:11434/v1',
  apiKey: '',
  model: 'qwen3:4b',
  modelName: 'Qwen3 4B',
}

function setMeta({ enabled = true } = {}) {
  window.metaAttributesCache?.clear()
  document.head.innerHTML = enabled
    ? '<meta name="ol-aiAssistEnabled" data-type="boolean" content="">'
    : ''
}

/** The dropdown's trigger, by the id its row's label points at. */
function trigger(id: string) {
  return document.getElementById(id) as HTMLInputElement
}

function Section() {
  const section = useLanguageSuggestionsSection()
  if (!section) return null
  return (
    <div>
      <h2>{section.title}</h2>
      {section.settings.map(setting => (
        <div key={setting.key}>{setting.component}</div>
      ))}
    </div>
  )
}

describe('language suggestions: settings section', function () {
  beforeEach(function () {
    setMeta()
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

  it('adds nothing with AI off', function () {
    setMeta({ enabled: false })
    const { container } = render(<Section />)
    expect(container.textContent).to.equal('')
  })

  it('shows only the toggle, with no description, while it is off', function () {
    customLocalStorage.setItem('ai-assist:provider', MAIN)
    customLocalStorage.setItem('ai-assist:consent', true)
    const { container } = render(<Section />)
    expect(screen.getByRole('heading', { name: 'Language suggestions' })).to.exist
    expect(screen.getByLabelText('AI language suggestions')).to.exist
    expect(container.querySelector('.ide-setting-description')).to.equal(null)
    expect(document.getElementById('aiLanguageSuggestionsTypes')).to.equal(null)
    expect(document.getElementById('aiLanguageSuggestionsModel')).to.equal(null)
    expect(screen.queryByText('Blocked language suggestions')).to.equal(null)
  })

  it('shows the rows in order once it is turned on', function () {
    customLocalStorage.setItem('ai-assist:provider', MAIN)
    customLocalStorage.setItem('ai-assist:consent', true)
    const { container } = render(<Section />)
    fireEvent.click(screen.getByLabelText('AI language suggestions'))
    expect(
      Array.from(container.querySelectorAll('.ide-setting-title')).map(
        label => label.textContent
      )
    ).to.deep.equal([
      'AI language suggestions',
      'Suggestion options',
      'English preference for AI suggestions',
      'Model',
      'Blocked language suggestions',
    ])
    expect(container.querySelector('.ide-setting-description')).to.equal(null)

    fireEvent.click(screen.getByLabelText('AI language suggestions'))
    expect(document.getElementById('aiLanguageSuggestionsModel')).to.equal(null)
  })

  it('needs a provider before it can be turned on', function () {
    render(<Section />)
    expect((screen.getByLabelText('AI language suggestions') as HTMLInputElement).disabled).to.equal(true)
    expect(screen.getByText(NO_PROVIDER_TEXT)).to.exist
  })

  it('asks for AI consent the first time it is turned on', function () {
    customLocalStorage.setItem('ai-assist:provider', MAIN)
    render(<Section />)
    fireEvent.click(screen.getByLabelText('AI language suggestions'))
    expect(screen.getByText(/send the text of the open file to/)).to.exist
    expect(screen.getByText('api.anthropic.com')).to.exist
    expect(readLanguageSuggestionsPreferences().enabled).to.equal(false)

    fireEvent.click(screen.getByRole('button', { name: 'Allow and continue' }))
    expect(customLocalStorage.getItem('ai-assist:consent')).to.equal(true)
    expect(readLanguageSuggestionsPreferences().enabled).to.equal(true)
    expect((screen.getByLabelText('AI language suggestions') as HTMLInputElement).checked).to.equal(true)
  })

  it('turns on at once when consent was already given', function () {
    customLocalStorage.setItem('ai-assist:provider', MAIN)
    customLocalStorage.setItem('ai-assist:consent', true)
    render(<Section />)
    fireEvent.click(screen.getByLabelText('AI language suggestions'))
    expect(readLanguageSuggestionsPreferences().enabled).to.equal(true)
  })

  it('offers the two models with a short description, and saves the choice', function () {
    customLocalStorage.setItem('ai-assist:provider', MAIN)
    customLocalStorage.setItem('ai-assist:fast-provider', FAST)
    customLocalStorage.setItem('ai-assist:language-suggestions', { enabled: true })
    render(<Section />)
    const select = trigger('aiLanguageSuggestionsModel')
    expect(select.value).to.equal('Fast model')
    fireEvent.click(select)
    const options = screen.getAllByRole('option')
    expect(options.map(option => option.textContent)).to.deep.equal([
      'Main modelClaude Opus 5.5 (Anthropic). More thorough, but slower and costlier.',
      'Fast modelQwen3 4B (Ollama). Quick and low-cost.check',
    ])
    fireEvent.click(screen.getByRole('option', { name: /Main model/ }))
    expect(readLanguageSuggestionsPreferences().model).to.equal('main')
    expect(select.value).to.equal('Main model')
  })

  it('cannot choose a model that is not set up', function () {
    customLocalStorage.setItem('ai-assist:provider', MAIN)
    customLocalStorage.setItem('ai-assist:language-suggestions', { enabled: true })
    render(<Section />)
    fireEvent.click(trigger('aiLanguageSuggestionsModel'))
    const fast = screen.getByRole('option', { name: /Fast model/ })
    expect(fast.textContent).to.contain('Not set up.')
    expect(fast.getAttribute('aria-disabled')).to.equal('true')
    fireEvent.click(fast)
    expect(readLanguageSuggestionsPreferences().model).to.equal(null)
  })

  it('offers All, Grammar and Style as suggestion options, and saves the choice', function () {
    customLocalStorage.setItem('ai-assist:provider', MAIN)
    customLocalStorage.setItem('ai-assist:language-suggestions', { enabled: true })
    render(<Section />)
    const select = trigger('aiLanguageSuggestionsTypes')
    expect(select.value).to.equal('All')
    fireEvent.click(select)
    expect(screen.getAllByRole('option').map(option => option.textContent)).to.deep.equal([
      'AllGrammar corrections and style improvements.check',
      'GrammarSpelling, grammar and punctuation corrections only.',
      'StyleClearer, more concise wording only.',
    ])
    fireEvent.click(screen.getByRole('option', { name: /^Style/ }))
    expect(readLanguageSuggestionsPreferences().types).to.equal('style')
    expect(select.value).to.equal('Style')
  })

  it('saves the English preference', function () {
    customLocalStorage.setItem('ai-assist:provider', MAIN)
    customLocalStorage.setItem('ai-assist:language-suggestions', { enabled: true })
    render(<Section />)
    const select = trigger('aiLanguageSuggestionsEnglish')
    expect(select.value).to.equal('English (American)')
    fireEvent.click(select)
    fireEvent.click(screen.getByRole('option', { name: /English \(British\)/ }))
    expect(readLanguageSuggestionsPreferences().englishVariant).to.equal('en-GB')
  })

  it('closes the settings and opens the blocked list from Edit', function () {
    const events: string[] = []
    const onToggle = (event: Event) =>
      events.push(`toggle-settings:${(event as CustomEvent).detail}`)
    const onOpen = () => events.push('open-blocked')
    window.addEventListener('ui.toggle-settings', onToggle)
    window.addEventListener('ai-assist:open-blocked-suggestions', onOpen)
    customLocalStorage.setItem('ai-assist:provider', MAIN)
    customLocalStorage.setItem('ai-assist:language-suggestions', { enabled: true })
    try {
      render(<Section />)
      fireEvent.click(screen.getByText('Edit'))
    } finally {
      window.removeEventListener('ui.toggle-settings', onToggle)
      window.removeEventListener('ai-assist:open-blocked-suggestions', onOpen)
    }
    expect(events).to.deep.equal(['toggle-settings:false', 'open-blocked'])
  })
})
