import { expect } from 'chai'
import customLocalStorage from '@/infrastructure/local-storage'
import {
  clearFastSettings,
  readFastSettings,
  readSettings,
  writeFastSettings,
} from '../../../../frontend/js/features/ai-assist/provider-store'

describe('language suggestions: fast model slot', function () {
  beforeEach(function () {
    customLocalStorage.clear()
  })

  afterEach(function () {
    customLocalStorage.clear()
  })

  it('has nothing until a fast model is saved', function () {
    expect(readFastSettings()).to.equal(null)
  })

  it('saves and reads the fast model, limits included, apart from the main one', function () {
    writeFastSettings({
      type: 'ollama',
      baseUrl: 'http://ollama:11434/v1',
      apiKey: '',
      model: 'qwen3:4b',
      modelName: 'Qwen3 4B',
      contextWindow: 8192,
      maxOutputTokens: 2048,
    })
    expect(readFastSettings()).to.deep.equal({
      type: 'ollama',
      baseUrl: 'http://ollama:11434/v1',
      apiKey: '',
      model: 'qwen3:4b',
      modelName: 'Qwen3 4B',
      contextWindow: 8192,
      maxOutputTokens: 2048,
    })
    expect(readSettings()).to.equal(null)
  })

  it('takes every provider, Anthropic included', function () {
    customLocalStorage.setItem('ai-assist:fast-provider', {
      type: 'anthropic',
      baseUrl: '',
      apiKey: 'k',
      model: 'claude-haiku',
    })
    expect(readFastSettings()).to.deep.equal({
      type: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'k',
      model: 'claude-haiku',
    })
  })

  it('fills in the native default URL when none was saved', function () {
    customLocalStorage.setItem('ai-assist:fast-provider', {
      type: 'google',
      baseUrl: '',
      apiKey: 'k',
      model: 'gemini-flash',
    })
    expect(readFastSettings()?.baseUrl).to.equal(
      'https://generativelanguage.googleapis.com/v1beta'
    )
  })

  it('moves an old Gemini fast model off the OpenAI-compatible URL', function () {
    customLocalStorage.setItem('ai-assist:fast-provider', {
      type: 'google',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKey: 'k',
      model: 'gemini-flash',
    })
    expect(readFastSettings()?.baseUrl).to.equal(
      'https://generativelanguage.googleapis.com/v1beta'
    )
  })

  it('ignores a provider type that does not exist', function () {
    customLocalStorage.setItem('ai-assist:fast-provider', {
      type: 'bogus',
      baseUrl: 'https://example.com',
      apiKey: 'k',
      model: 'm',
    })
    expect(readFastSettings()).to.equal(null)
  })

  it('clears the fast model and tells the page', function () {
    let events = 0
    const listener = () => events++
    window.addEventListener('aiAssist:fastProviderChanged', listener)
    writeFastSettings({
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'k',
      model: 'gpt-mini',
    })
    clearFastSettings()
    window.removeEventListener('aiAssist:fastProviderChanged', listener)
    expect(readFastSettings()).to.equal(null)
    expect(events).to.equal(2)
  })
})
