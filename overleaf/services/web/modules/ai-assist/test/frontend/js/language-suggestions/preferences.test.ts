import { expect } from 'chai'
import fetchMock from 'fetch-mock'
import customLocalStorage from '@/infrastructure/local-storage'
import {
  blockKey,
  blockSuggestion,
  forgetLanguageSuggestionsPreferences,
  isBlocked,
  normalizeLanguageSuggestionsPreferences,
  readLanguageSuggestionsPreferences,
  unblockSuggestion,
  updateLanguageSuggestionsPreferences,
} from '../../../../frontend/js/features/ai-assist/language-suggestions/preferences'

describe('language suggestions: preferences', function () {
  beforeEach(function () {
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

  it('starts off, American, with no model chosen and nothing blocked', function () {
    expect(readLanguageSuggestionsPreferences()).to.deep.equal({
      enabled: false,
      englishVariant: 'en-US',
      model: null,
      blocked: [],
      types: 'all',
    })
  })

  it('throws away values it does not know', function () {
    expect(
      normalizeLanguageSuggestionsPreferences({
        enabled: 'yes',
        englishVariant: 'en-AU',
        model: 'huge',
        blocked: 'none',
        types: 'some',
      })
    ).to.deep.equal({
      enabled: false,
      englishVariant: 'en-US',
      model: null,
      blocked: [],
      types: 'all',
    })
  })

  it('shows all suggestions unless narrowed, keeping the earlier style switch', function () {
    expect(normalizeLanguageSuggestionsPreferences({}).types).to.equal('all')
    expect(normalizeLanguageSuggestionsPreferences({ types: 'grammar' }).types).to.equal('grammar')
    expect(normalizeLanguageSuggestionsPreferences({ types: 'style' }).types).to.equal('style')
    expect(normalizeLanguageSuggestionsPreferences({ style: false }).types).to.equal('grammar')
  })

  it('cleans the blocked list: collapsed, capped, newest first, no duplicates', function () {
    const long = 'x'.repeat(201)
    const result = normalizeLanguageSuggestionsPreferences({
      blocked: [
        { from: 'data  is', to: 'data are', at: 1 },
        { from: 'plans,', to: 'planning,', at: 3 },
        { from: 'data is', to: 'data are', at: 2 },
        { from: long, to: 'y', at: 4 },
        { from: '', to: '', at: 5 },
        { from: 42, to: 'y', at: 6 },
        { from: ',', to: '', at: 7 },
      ],
    })
    expect(result.blocked).to.deep.equal([
      { from: ',', to: '', at: 7 },
      { from: 'plans,', to: 'planning,', at: 3 },
      { from: 'data is', to: 'data are', at: 2 },
    ])
  })

  it('keeps at most 500 blocked suggestions', function () {
    const blocked = Array.from({ length: 510 }, (_, i) => ({
      from: `a${i}`,
      to: `b${i}`,
      at: i,
    }))
    const result = normalizeLanguageSuggestionsPreferences({ blocked })
    expect(result.blocked).to.have.length(500)
    expect(result.blocked[0]).to.deep.equal({ from: 'a509', to: 'b509', at: 509 })
  })

  it('saves to this browser and the account, and tells the page', async function () {
    let events = 0
    const listener = () => events++
    window.addEventListener('ai-assist:language-suggestions-changed', listener)
    updateLanguageSuggestionsPreferences({ enabled: true, englishVariant: 'en-GB' })
    window.removeEventListener('ai-assist:language-suggestions-changed', listener)

    expect(events).to.equal(1)
    expect(customLocalStorage.getItem('ai-assist:language-suggestions')).to.deep.equal({
      enabled: true,
      englishVariant: 'en-GB',
      model: null,
      blocked: [],
      types: 'all',
    })
    const [call] = fetchMock.callHistory.calls('/ai-assist/preferences')
    expect(
      JSON.parse(call.options.body as string).preferences.languageSuggestions
    ).to.include({ enabled: true, englishVariant: 'en-GB' })
  })

  it('blocks and unblocks an exact pair, case-sensitive', function () {
    blockSuggestion('likeliness rankings', 'likelihood ranking', 10)
    expect(isBlocked('likeliness  rankings', 'likelihood ranking')).to.equal(true)
    expect(isBlocked('likeliness', 'likelihood')).to.equal(false)
    expect(isBlocked('Likeliness rankings', 'likelihood ranking')).to.equal(false)

    unblockSuggestion('likeliness rankings', 'likelihood ranking')
    expect(isBlocked('likeliness rankings', 'likelihood ranking')).to.equal(false)
    expect(readLanguageSuggestionsPreferences().blocked).to.deep.equal([])
  })

  it('puts a newly blocked suggestion first', function () {
    blockSuggestion('a', 'b', 1)
    blockSuggestion('c', 'd', 2)
    expect(readLanguageSuggestionsPreferences().blocked.map(e => e.from)).to.deep.equal([
      'c',
      'a',
    ])
    expect(blockKey(' a  b ', 'c')).to.equal(blockKey('a b', 'c'))
  })
})
