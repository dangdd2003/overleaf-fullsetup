import { expect } from 'chai'
import customLocalStorage from '@/infrastructure/local-storage'
import {
  clearSettings,
  readSettings,
  writeSettings,
  readFastSettings,
  writeFastSettings,
  clearFastSettings,
  readWebSearchSettings,
  writeWebSearchSettings,
  clearWebSearchSettings,
  SETTINGS_KEY,
  FAST_SETTINGS_KEY,
} from '../../../frontend/js/features/ai-assist/provider-store'

describe('provider-store', function () {
  beforeEach(function () {
    customLocalStorage.clear()
  })

  describe('readSettings', function () {
    it('returns null when no settings stored', function () {
      expect(readSettings()).to.be.null
    })

    it('returns null when stored type is unknown/invalid', function () {
      customLocalStorage.setItem(SETTINGS_KEY, {
        type: 'invalid-provider-type',
        model: 'some-model',
      })
      expect(readSettings()).to.be.null
    })

    it('reads valid openai settings', function () {
      writeSettings({
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        model: 'gpt-4o',
      })
      expect(readSettings()).to.deep.include({
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        model: 'gpt-4o',
      })
    })

    it('normalizes legacy compatible types', function () {
      customLocalStorage.setItem(SETTINGS_KEY, {
        type: 'openai-compatible',
        baseUrl: 'https://example.com/v1',
        apiKey: 'sk-test',
        model: 'custom-model',
      })
      expect(readSettings()).to.deep.include({
        type: 'openai',
        baseUrl: 'https://example.com/v1',
        apiKey: 'sk-test',
        model: 'custom-model',
      })
    })
  })

  describe('readFastSettings', function () {
    it('returns null when stored type is unknown', function () {
      customLocalStorage.setItem(FAST_SETTINGS_KEY, {
        type: 'unknown-provider',
        model: 'fast-model',
      })
      expect(readFastSettings()).to.be.null
    })

    it('reads valid fast settings', function () {
      writeFastSettings({
        type: 'google',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'gemini-key',
        model: 'gemini-1.5-flash',
      })
      expect(readFastSettings()).to.deep.include({
        type: 'google',
        model: 'gemini-1.5-flash',
      })
    })

    it('normalizes openai-compatible and anthropic-compatible types', function () {
      customLocalStorage.setItem(FAST_SETTINGS_KEY, {
        type: 'openai-compatible',
        baseUrl: 'http://localhost:11434/v1',
        apiKey: 'k',
        model: 'qwen2.5-coder',
      })
      expect(readFastSettings()).to.deep.include({
        type: 'openai',
        baseUrl: 'http://localhost:11434/v1',
        apiKey: 'k',
        model: 'qwen2.5-coder',
      })

      customLocalStorage.setItem(FAST_SETTINGS_KEY, {
        type: 'anthropic-compatible',
        baseUrl: 'http://localhost:8080',
        apiKey: 'k',
        model: 'claude-local',
      })
      expect(readFastSettings()).to.deep.include({
        type: 'anthropic',
        baseUrl: 'http://localhost:8080',
        apiKey: 'k',
        model: 'claude-local',
      })
    })
  })

  describe('readWebSearchSettings / writeWebSearchSettings', function () {
    it('saves and reads parallel web search provider settings', function () {
      writeWebSearchSettings({
        sourceMode: 'custom',
        providers: {
          parallel: {
            enabled: true,
            apiKeys: ['parallel-key-test'],
            baseUrl: 'https://api.parallel.ai',
            search: {
              maxResults: 15,
              mode: 'fast',
              location: 'us',
              includeDomains: ['arxiv.org'],
            },
            read: {
              fullContent: true,
              timeoutSeconds: 30,
            },
          },
        },
      })
      const read = readWebSearchSettings()
      expect(read?.sourceMode).to.equal('custom')
      expect(read?.providers?.parallel?.enabled).to.be.true
      expect(read?.providers?.parallel?.apiKeys).to.deep.equal(['parallel-key-test'])
      expect(read?.providers?.parallel?.baseUrl).to.equal('https://api.parallel.ai')
      expect(read?.providers?.parallel?.search?.mode).to.equal('fast')
      expect(read?.providers?.parallel?.read?.fullContent).to.be.true
    })
  })
})
