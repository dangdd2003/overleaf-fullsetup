import { expect } from 'chai'
import customLocalStorage from '@/infrastructure/local-storage'
import {
  effectiveSlot,
  keyContext,
  modelItems,
  NOT_SET_UP,
  providerHost,
  resolveModel,
  resolveSlotModel,
} from '../../../../frontend/js/features/ai-assist/language-suggestions/model-choice'
import { normalizeLanguageSuggestionsPreferences } from '../../../../frontend/js/features/ai-assist/language-suggestions/preferences'

const MAIN = {
  type: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'k',
  model: 'claude-opus-5-5',
  modelName: 'Claude Opus 5.5',
}

const FAST = {
  type: 'google',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  apiKey: 'g',
  model: 'gemini-flash',
  modelName: 'Gemini Flash',
}

describe('language suggestions: model choice', function () {
  beforeEach(function () {
    customLocalStorage.clear()
  })

  afterEach(function () {
    customLocalStorage.clear()
  })

  it('has no model when neither slot is set up', function () {
    expect(effectiveSlot(null)).to.equal(null)
    expect(resolveModel('fast')).to.equal(null)
    expect(modelItems()).to.deep.equal([
      { slot: 'main', title: 'Main model', description: NOT_SET_UP, disabled: true },
      { slot: 'fast', title: 'Fast model', description: NOT_SET_UP, disabled: true },
    ])
  })

  it('falls back to the main model when the fast one is not set up', function () {
    customLocalStorage.setItem('ai-assist:provider', MAIN)
    expect(effectiveSlot('fast')).to.equal('main')
    expect(effectiveSlot(null)).to.equal('main')
  })

  it('resolves a specific slot independently with resolveSlotModel', function () {
    customLocalStorage.setItem('ai-assist:fast-provider', FAST)
    expect(resolveSlotModel('main')).to.equal(null)
    const resolvedFast = resolveSlotModel('fast')!
    expect(resolvedFast.slot).to.equal('fast')
    expect(resolvedFast.model).to.equal('gemini-flash')
    expect(resolvedFast.storedType).to.equal('google')
  })

  it('allows fast model to run without a main model in effectiveSlot', function () {
    customLocalStorage.setItem('ai-assist:fast-provider', FAST)
    expect(effectiveSlot('fast')).to.equal('fast')
    expect(effectiveSlot(null)).to.equal('fast')
    expect(resolveModel(null)?.slot).to.equal('fast')
  })

  it('prefers the fast model when nothing was chosen', function () {
    customLocalStorage.setItem('ai-assist:provider', MAIN)
    customLocalStorage.setItem('ai-assist:fast-provider', FAST)
    expect(effectiveSlot(null)).to.equal('fast')
    expect(effectiveSlot('main')).to.equal('main')
  })

  it('treats a saved slot without a model as not set up', function () {
    customLocalStorage.setItem('ai-assist:fast-provider', { ...FAST, model: '' })
    expect(effectiveSlot('fast')).to.equal(null)
  })

  it('runs the main model with thinking off', function () {
    customLocalStorage.setItem('ai-assist:provider', MAIN)
    const resolved = resolveModel('main')!
    expect(resolved.slot).to.equal('main')
    expect(resolved.model).to.equal('claude-opus-5-5')
    expect(resolved.storedType).to.equal('anthropic')
    expect(resolved.settings).to.include({ type: 'anthropic', thinking: false })
  })

  it('runs the fast model on its own provider, thinking off', function () {
    customLocalStorage.setItem('ai-assist:provider', MAIN)
    customLocalStorage.setItem('ai-assist:fast-provider', FAST)
    const resolved = resolveModel(null)!
    expect(resolved.slot).to.equal('fast')
    expect(resolved.storedType).to.equal('google')
    expect(resolved.settings).to.include({
      type: 'google',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-flash',
      thinking: false,
    })
  })

  it('describes both models by name, provider and a short trade-off', function () {
    customLocalStorage.setItem('ai-assist:provider', MAIN)
    customLocalStorage.setItem('ai-assist:fast-provider', FAST)
    expect(modelItems()).to.deep.equal([
      {
        slot: 'main',
        title: 'Main model',
        description: 'Claude Opus 5.5 (Anthropic). More thorough, but slower and costlier.',
        disabled: false,
      },
      {
        slot: 'fast',
        title: 'Fast model',
        description: 'Gemini Flash (Google Gemini). Quick and low-cost.',
        disabled: false,
      },
    ])
  })

  it('names the host, or the URL as written when it is not a URL', function () {
    expect(providerHost({ ...MAIN, type: 'anthropic', baseUrl: 'http://ollama:11434/v1' })).to.equal('ollama:11434')
    expect(providerHost({ ...MAIN, type: 'anthropic', baseUrl: 'not a url' })).to.equal('not a url')
  })

  it('builds the cache key context from the preferences', function () {
    customLocalStorage.setItem('ai-assist:provider', MAIN)
    customLocalStorage.setItem('ai-assist:fast-provider', FAST)
    expect(
      keyContext(normalizeLanguageSuggestionsPreferences({ englishVariant: 'en-GB' }))
    ).to.deep.equal({ slot: 'fast', model: 'gemini-flash', variant: 'en-GB', style: true })
  })
})
