import { expect } from 'chai'
import { fireEvent, render, screen } from '@testing-library/react'
import fetchMock from 'fetch-mock'
import customLocalStorage from '@/infrastructure/local-storage'
import useAiAssistanceSection from '../../../../frontend/js/features/ai-assist/components/inline-suggestion/ai-assistance-section'
import {
  forgetInlineSuggestionsPreferences,
  readInlineSuggestionsPreferences,
} from '../../../../frontend/js/features/ai-assist/inline-suggestion/preferences'

function setMeta({ enabled = true } = {}) {
  window.metaAttributesCache?.clear()
  document.head.innerHTML = enabled
    ? '<meta name="ol-aiAssistEnabled" data-type="boolean" content="">'
    : ''
}

function Section() {
  const section = useAiAssistanceSection()
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

const optionTexts = (select: HTMLSelectElement) =>
  [...select.options].map(option => option.textContent)

describe('inline suggestions: settings section', function () {
  beforeEach(function () {
    setMeta()
    customLocalStorage.clear()
    forgetInlineSuggestionsPreferences()
    fetchMock.removeRoutes().clearHistory()
    fetchMock.put('/ai-assist/preferences', { preferences: null })
  })

  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
    customLocalStorage.clear()
    forgetInlineSuggestionsPreferences()
  })

  it('adds nothing with AI off', function () {
    setMeta({ enabled: false })
    const { container } = render(<Section />)
    expect(container.textContent).to.equal('')
  })

  it('shows the shortcut switch and the completion dropdown, both off', function () {
    render(<Section />)
    expect(screen.getByRole('heading', { name: 'AI assistance' })).to.exist
    expect((screen.getByLabelText('AI shortcut on empty lines') as HTMLInputElement).checked).to.equal(false)
    const mode = screen.getByLabelText('AI code completion') as HTMLSelectElement
    expect(mode.value).to.equal('disabled')
    expect(optionTexts(mode)).to.deep.equal(['Disabled', 'Manual (Shift+Space)', 'Automatic (and Shift+Space)'])
    expect(screen.getByText('Ghost text at the cursor; Tab accepts, Shift+Space asks for a new one')).to.exist
    expect(screen.queryByLabelText('Trigger delay')).to.equal(null)
  })

  it('shows the trigger delay, at 300 ms, only while Automatic is chosen', function () {
    render(<Section />)
    const mode = screen.getByLabelText('AI code completion') as HTMLSelectElement
    fireEvent.change(mode, { target: { value: 'automatic' } })
    const delay = screen.getByLabelText('Trigger delay') as HTMLSelectElement
    expect(delay.value).to.equal('300')
    expect(optionTexts(delay)).to.deep.equal([
      '100 ms', '200 ms', '300 ms', '400 ms', '500 ms', '600 ms', '800 ms', '1000 ms',
    ])
    expect(screen.getByText('Pause in typing before a suggestion is requested')).to.exist
    fireEvent.change(mode, { target: { value: 'manual' } })
    expect(screen.queryByLabelText('Trigger delay')).to.equal(null)
  })

  it('saves the chosen mode and delay', function () {
    render(<Section />)
    fireEvent.change(screen.getByLabelText('AI code completion'), { target: { value: 'automatic' } })
    fireEvent.change(screen.getByLabelText('Trigger delay'), { target: { value: '500' } })
    expect(readInlineSuggestionsPreferences()).to.deep.equal({
      emptyLineShortcut: false,
      completionMode: 'automatic',
      completionDelayMs: 500,
    })
  })
})
