import { expect } from 'chai'
import fetchMock from 'fetch-mock'
import customLocalStorage from '@/infrastructure/local-storage'
import { loadComposerPreferences } from '../../../../frontend/js/features/ai-assist/provider-store'
import {
  forgetInlineSuggestionsPreferences,
  normalizeInlineSuggestionsPreferences,
  readInlineSuggestionsPreferences,
  updateInlineSuggestionsPreferences,
} from '../../../../frontend/js/features/ai-assist/inline-suggestion/preferences'

describe('inline suggestions: preferences', function () {
  beforeEach(function () {
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

  it('starts with the shortcut off, completion disabled, and a 300 ms delay', function () {
    expect(readInlineSuggestionsPreferences()).to.deep.equal({
      emptyLineShortcut: false,
      completionMode: 'disabled',
      completionDelayMs: 300,
    })
  })

  it('keeps only known modes and delays', function () {
    expect(
      normalizeInlineSuggestionsPreferences({
        emptyLineShortcut: 'yes',
        completionMode: 'always',
        completionDelayMs: 250,
      })
    ).to.deep.equal({
      emptyLineShortcut: false,
      completionMode: 'disabled',
      completionDelayMs: 300,
    })
    expect(
      normalizeInlineSuggestionsPreferences({
        completionMode: 'automatic',
        completionDelayMs: 800,
      })
    ).to.include({ completionMode: 'automatic', completionDelayMs: 800 })
  })

  it('turns the old sentence completion switch into the manual mode', function () {
    expect(
      normalizeInlineSuggestionsPreferences({ sentenceCompletion: true })
    ).to.include({ completionMode: 'manual' })
    expect(
      normalizeInlineSuggestionsPreferences({ sentenceCompletion: false })
    ).to.include({ completionMode: 'disabled' })
    // A real mode wins over the old switch
    expect(
      normalizeInlineSuggestionsPreferences({
        sentenceCompletion: true,
        completionMode: 'automatic',
      })
    ).to.include({ completionMode: 'automatic' })
  })

  it('saves to this browser and the account, and tells the page', function () {
    let events = 0
    const listener = () => events++
    window.addEventListener('ai-assist:inline-suggestions-changed', listener)
    updateInlineSuggestionsPreferences({ completionMode: 'automatic' })
    window.removeEventListener('ai-assist:inline-suggestions-changed', listener)

    const saved = {
      emptyLineShortcut: false,
      completionMode: 'automatic',
      completionDelayMs: 300,
    }
    expect(events).to.equal(1)
    expect(customLocalStorage.getItem('ai-assist:inline-suggestions')).to.deep.equal(saved)
    const [call] = fetchMock.callHistory.calls('/ai-assist/preferences')
    expect(
      JSON.parse(call.options.body as string).preferences.inlineSuggestions
    ).to.deep.equal(saved)
  })

  it("takes the account's copy when the editor loads, old shape included", async function () {
    fetchMock.get('/ai-assist/preferences', {
      preferences: {
        reasoningEffort: {},
        thinking: {},
        inlineSuggestions: { emptyLineShortcut: true, sentenceCompletion: true },
      },
    })
    expect(readInlineSuggestionsPreferences().emptyLineShortcut).to.equal(false)
    await loadComposerPreferences()
    expect(readInlineSuggestionsPreferences()).to.deep.equal({
      emptyLineShortcut: true,
      completionMode: 'manual',
      completionDelayMs: 300,
    })
  })
})
