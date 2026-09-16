import { expect } from 'chai'
import {
  DEFAULT_LIMITS,
  ProviderType,
  resolveLimits,
} from '../../../frontend/js/features/ai-assist/providers/types'

describe('resolveLimits', function () {
  it('falls back to the provider default', function () {
    const limits = resolveLimits({
      type: 'anthropic',
      baseUrl: '',
      apiKey: '',
      model: 'claude-opus-5',
    })
    expect(limits).to.deep.equal(DEFAULT_LIMITS.anthropic)
  })

  it('falls back to ollama defaults with full 256k window and 64k output', function () {
    const limits = resolveLimits({
      type: 'ollama',
      baseUrl: '',
      apiKey: '',
      model: 'gemma4:cloud',
    })
    expect(limits).to.deep.equal({ contextWindow: 256000, maxOutputTokens: 65536 })
  })

  it('prefers explicit settings over the default', function () {
    const limits = resolveLimits({
      type: 'ollama',
      baseUrl: '',
      apiKey: '',
      model: 'qwen3',
      contextWindow: 32000,
      maxOutputTokens: 2048,
    })
    expect(limits).to.deep.equal({ contextWindow: 32000, maxOutputTokens: 2048 })
  })

  it('ignores nonsense values rather than sending a request that cannot work', function () {
    const limits = resolveLimits({
      type: 'openai',
      baseUrl: '',
      apiKey: '',
      model: 'gpt-4o',
      contextWindow: 0,
      maxOutputTokens: -5,
    })
    expect(limits).to.deep.equal(DEFAULT_LIMITS.openai)
  })

  it('falls back to openai defaults when the provider type is unknown', function () {
    const limits = resolveLimits({
      type: 'unknown-provider' as ProviderType,
      baseUrl: '',
      apiKey: '',
      model: 'some-model',
    })
    expect(limits).to.deep.equal(DEFAULT_LIMITS.openai)
  })
})
