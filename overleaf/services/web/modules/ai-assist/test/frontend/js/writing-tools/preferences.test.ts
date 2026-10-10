import { expect } from 'chai'
import fetchMock from 'fetch-mock'
import customLocalStorage from '@/infrastructure/local-storage'
import {
  normalizeWritingToolsPreferences,
  readWritingToolsPreferences,
  rememberLanguage,
} from '../../../../frontend/js/features/ai-assist/writing-tools/preferences'

describe('writing tools: preferences', function () {
  beforeEach(function () {
    customLocalStorage.clear()
    fetchMock.removeRoutes().clearHistory()
    fetchMock.put('/ai-assist/preferences', { preferences: null })
  })

  afterEach(function () {
    customLocalStorage.clear()
    fetchMock.removeRoutes().clearHistory()
  })

  it('defaults to medium Rephrase, no recent languages and the diff on', function () {
    expect(readWritingToolsPreferences()).to.deep.equal({
      recentLanguages: [],
      rephrase: { level: 'medium', style: null, length: null },
      showDiff: true,
    })
  })

  it('drops unknown values', function () {
    expect(
      normalizeWritingToolsPreferences({
        recentLanguages: ['French', 7],
        rephrase: { level: 'max', style: 'concise', length: 'tiny' },
        showDiff: false,
      })
    ).to.deep.equal({
      recentLanguages: ['French'],
      rephrase: { level: 'medium', style: 'concise', length: null },
      showDiff: false,
    })
  })

  it('keeps the three most recent languages, newest first, and saves them to the account', function () {
    rememberLanguage('French')
    rememberLanguage('German')
    rememberLanguage('Spanish')
    rememberLanguage('French')
    rememberLanguage('Vietnamese')
    expect(readWritingToolsPreferences().recentLanguages).to.deep.equal([
      'Vietnamese',
      'French',
      'Spanish',
    ])
    const calls = fetchMock.callHistory.calls('/ai-assist/preferences')
    expect(calls.length).to.equal(5)
    const body = JSON.parse(String(calls[calls.length - 1].options.body))
    expect(body.preferences.writingTools.recentLanguages).to.deep.equal([
      'Vietnamese',
      'French',
      'Spanish',
    ])
  })
})
