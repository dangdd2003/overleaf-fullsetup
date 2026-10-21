import { expect } from 'chai'
import sinon from 'sinon'
import fetchMock from 'fetch-mock'
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
  initServerSettings,
  _resetCachedSettings,
  SETTINGS_KEY,
  FAST_SETTINGS_KEY,
} from '../../../frontend/js/features/ai-assist/provider-store'

const WEB_SEARCH_KEY = 'ai-assist:web-search'

describe('provider-store', function () {
  beforeEach(function () {
    _resetCachedSettings()
    customLocalStorage.clear()
    fetchMock.removeRoutes().clearHistory()
    fetchMock.get('/ai-assist/settings', {
      status: 200,
      body: { provider: null, fastProvider: null, webSearch: null },
    })
    fetchMock.put('/ai-assist/settings', {
      status: 200,
      body: { success: true },
    })
  })

  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
    _resetCachedSettings()
    customLocalStorage.clear()
  })

  describe('_resetCachedSettings', function () {
    it('clears cached provider, fast provider, and web search settings in memory', function () {
      writeSettings({
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        model: 'gpt-4o',
      })
      writeFastSettings({
        type: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant-test',
        model: 'claude-3-5-haiku-20241022',
      })
      writeWebSearchSettings({
        sourceMode: 'custom',
        providers: {
          searxng: { enabled: true, baseUrls: ['https://searx.example.com'] },
        },
      })

      expect(readSettings()).to.not.be.null
      expect(readFastSettings()).to.not.be.null
      expect(readWebSearchSettings()).to.not.be.null

      _resetCachedSettings()

      expect(readSettings()).to.be.null
      expect(readFastSettings()).to.be.null
      expect(readWebSearchSettings()).to.be.null
    })
  })

  describe('initServerSettings', function () {
    it('loads server-backed settings into memory cache', async function () {
      fetchMock.removeRoutes().clearHistory()
      fetchMock.get('/ai-assist/settings', {
        status: 200,
        body: {
          provider: {
            type: 'openai',
            baseUrl: 'https://api.openai.com/v1',
            apiKey: 'sk-server-key',
            model: 'gpt-4o',
          },
          fastProvider: {
            type: 'anthropic',
            baseUrl: 'https://api.anthropic.com',
            apiKey: 'sk-server-fast-key',
            model: 'claude-3-5-haiku-20241022',
          },
          webSearch: {
            sourceMode: 'custom',
            providers: {
              searxng: {
                enabled: true,
                baseUrls: ['https://searx.server.org'],
              },
            },
          },
        },
      })

      await initServerSettings()

      expect(readSettings()).to.deep.include({
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-server-key',
        model: 'gpt-4o',
      })
      expect(readFastSettings()).to.deep.include({
        type: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-server-fast-key',
        model: 'claude-3-5-haiku-20241022',
      })
      const search = readWebSearchSettings()
      expect(search?.sourceMode).to.equal('custom')
      expect(search?.providers?.searxng?.enabled).to.be.true
      expect(search?.providers?.searxng?.baseUrls).to.deep.equal([
        'https://searx.server.org',
      ])
    })

    it('migrates legacy localStorage settings to the server and removes them from localStorage', async function () {
      customLocalStorage.setItem(SETTINGS_KEY, {
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-legacy-key',
        model: 'gpt-4o',
      })
      customLocalStorage.setItem(FAST_SETTINGS_KEY, {
        type: 'google',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'gemini-legacy-key',
        model: 'gemini-1.5-flash',
      })
      customLocalStorage.setItem(WEB_SEARCH_KEY, {
        type: 'searxng',
        baseUrl: 'https://searx.legacy.org',
      })

      fetchMock.removeRoutes().clearHistory()
      let putCallPayload: any = null
      fetchMock.put('/ai-assist/settings', (callLog) => {
        putCallPayload = JSON.parse(callLog.options.body as string)
        return { status: 200, body: { success: true } }
      })
      fetchMock.get('/ai-assist/settings', {
        status: 200,
        body: { provider: null, fastProvider: null, webSearch: null },
      })

      await initServerSettings()

      expect(putCallPayload).to.not.be.null
      expect(putCallPayload.provider).to.deep.include({
        type: 'openai',
        apiKey: 'sk-legacy-key',
        model: 'gpt-4o',
      })
      expect(putCallPayload.fastProvider).to.deep.include({
        type: 'google',
        apiKey: 'gemini-legacy-key',
        model: 'gemini-1.5-flash',
      })
      expect(putCallPayload.webSearch.providers.searxng.baseUrls).to.deep.equal([
        'https://searx.legacy.org',
      ])

      expect(customLocalStorage.getItem(SETTINGS_KEY)).to.be.null
      expect(customLocalStorage.getItem(FAST_SETTINGS_KEY)).to.be.null
      expect(customLocalStorage.getItem(WEB_SEARCH_KEY)).to.be.null
    })

    it('deduplicates concurrent initServerSettings calls', async function () {
      fetchMock.removeRoutes().clearHistory()
      fetchMock.get('/ai-assist/settings', {
        status: 200,
        body: { provider: null, fastProvider: null, webSearch: null },
      })

      const p1 = initServerSettings()
      const p2 = initServerSettings()
      await Promise.all([p1, p2])

      const calls = fetchMock.callHistory.calls('/ai-assist/settings')
      expect(calls).to.have.lengthOf(1)
    })

    it('handles server network failure gracefully without throwing', async function () {
      fetchMock.removeRoutes().clearHistory()
      fetchMock.get('/ai-assist/settings', { status: 500 })

      await initServerSettings()
      expect(readSettings()).to.be.null
      expect(readFastSettings()).to.be.null
      expect(readWebSearchSettings()).to.be.null
    })

    it('dispatches provider, fastProvider, and webSearch change events upon init', async function () {
      const providerSpy = sinon.spy()
      const fastSpy = sinon.spy()
      const webSpy = sinon.spy()

      window.addEventListener('aiAssist:providerChanged', providerSpy)
      window.addEventListener('aiAssist:fastProviderChanged', fastSpy)
      window.addEventListener('aiAssist:webSearchChanged', webSpy)

      try {
        await initServerSettings()
        expect(providerSpy).to.have.been.calledOnce
        expect(fastSpy).to.have.been.calledOnce
        expect(webSpy).to.have.been.calledOnce
      } finally {
        window.removeEventListener('aiAssist:providerChanged', providerSpy)
        window.removeEventListener('aiAssist:fastProviderChanged', fastSpy)
        window.removeEventListener('aiAssist:webSearchChanged', webSpy)
      }
    })
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

    it('normalizes endpoint URLs according to provider requirements', function () {
      customLocalStorage.setItem(SETTINGS_KEY, {
        type: 'openai',
        baseUrl: 'https://api.openai.com',
        apiKey: 'sk-test',
        model: 'gpt-4o',
      })
      expect(readSettings()?.baseUrl).to.equal('https://api.openai.com/v1')

      customLocalStorage.setItem(SETTINGS_KEY, {
        type: 'anthropic',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-test',
        model: 'deepseek-chat',
      })
      expect(readSettings()?.baseUrl).to.equal('https://api.deepseek.com')

      customLocalStorage.setItem(SETTINGS_KEY, {
        type: 'google',
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiKey: 'sk-test',
        model: 'gemini-2.0-flash',
      })
      expect(readSettings()?.baseUrl).to.equal(
        'https://generativelanguage.googleapis.com/v1beta'
      )

      customLocalStorage.setItem(SETTINGS_KEY, {
        type: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        apiKey: '',
        model: 'llama3.2',
      })
      expect(readSettings()?.baseUrl).to.equal('http://localhost:11434')
    })
  })

  describe('writeSettings & clearSettings', function () {
    it('sends updated provider settings to server via PUT', function () {
      const settings = {
        type: 'openai' as const,
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-write-test',
        model: 'gpt-4o',
      }
      writeSettings(settings)

      expect(readSettings()).to.deep.include(settings)

      const lastCall = fetchMock.callHistory.lastCall('/ai-assist/settings')
      expect(lastCall).to.exist
      const payload = JSON.parse(lastCall?.options?.body as string)
      expect(payload).to.deep.equal({ provider: settings })
    })

    it('dispatches aiAssist:providerChanged on writeSettings and clearSettings', function () {
      const spy = sinon.spy()
      window.addEventListener('aiAssist:providerChanged', spy)
      try {
        writeSettings({
          type: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-test',
          model: 'gpt-4o',
        })
        expect(spy).to.have.been.calledOnce

        clearSettings()
        expect(spy).to.have.been.calledTwice
        expect(readSettings()).to.be.null

        const putCalls = fetchMock.callHistory
          .calls()
          .filter((c) => c.options?.method?.toLowerCase() === 'put')
        const lastPut = putCalls[putCalls.length - 1]
        expect(lastPut).to.exist
        const payload = JSON.parse(lastPut.options.body as string)
        expect(payload).to.deep.equal({ provider: null })
      } finally {
        window.removeEventListener('aiAssist:providerChanged', spy)
      }
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

      _resetCachedSettings()

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

    it('strips /openai suffix for google provider and preserves contextWindow and maxOutputTokens', function () {
      customLocalStorage.setItem(FAST_SETTINGS_KEY, {
        type: 'google',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        apiKey: 'gem-key',
        model: 'gemini-2.0-flash',
        contextWindow: 1000000,
        maxOutputTokens: 8192,
      })
      const fast = readFastSettings()
      expect(fast?.baseUrl).to.equal(
        'https://generativelanguage.googleapis.com/v1beta'
      )
      expect(fast?.contextWindow).to.equal(1000000)
      expect(fast?.maxOutputTokens).to.equal(8192)
    })
  })

  describe('writeFastSettings & clearFastSettings', function () {
    it('sends updated fast provider settings to server via PUT', function () {
      const settings = {
        type: 'google' as const,
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'gemini-write-test',
        model: 'gemini-1.5-flash',
      }
      writeFastSettings(settings)

      expect(readFastSettings()).to.deep.include(settings)

      const lastCall = fetchMock.callHistory.lastCall('/ai-assist/settings')
      expect(lastCall).to.exist
      const payload = JSON.parse(lastCall?.options?.body as string)
      expect(payload).to.deep.equal({ fastProvider: settings })
    })

    it('dispatches aiAssist:fastProviderChanged on writeFastSettings and clearFastSettings', function () {
      const spy = sinon.spy()
      window.addEventListener('aiAssist:fastProviderChanged', spy)
      try {
        writeFastSettings({
          type: 'google',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
          apiKey: 'gem-key',
          model: 'gemini-1.5-flash',
        })
        expect(spy).to.have.been.calledOnce

        clearFastSettings()
        expect(spy).to.have.been.calledTwice
        expect(readFastSettings()).to.be.null

        const putCalls = fetchMock.callHistory
          .calls()
          .filter((c) => c.options?.method?.toLowerCase() === 'put')
        const lastPut = putCalls[putCalls.length - 1]
        expect(lastPut).to.exist
        const payload = JSON.parse(lastPut.options.body as string)
        expect(payload).to.deep.equal({ fastProvider: null })
      } finally {
        window.removeEventListener('aiAssist:fastProviderChanged', spy)
      }
    })
  })

  describe('readWebSearchSettings & writeWebSearchSettings', function () {
    it('saves and reads parallel web search provider settings', function () {
      writeWebSearchSettings({
        sourceMode: 'custom',
        providers: {
          parallel: {
            enabled: true,
            apiKeys: ['parallel-key-test'],
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
      expect(read?.providers?.parallel?.apiKeys).to.deep.equal([
        'parallel-key-test',
      ])
      expect(read?.providers?.parallel?.search?.mode).to.equal('fast')
      expect(read?.providers?.parallel?.read?.fullContent).to.be.true
    })

    it('saves and reads mcp web search provider settings with bearerToken and custom headers', function () {
      writeWebSearchSettings({
        sourceMode: 'custom',
        providers: {
          mcp: {
            enabled: true,
            serverUrls: ['https://mcp.example.com/api/mcp'],
            bearerToken: 'test-oauth-bearer-token-123',
            headers: [
              { key: 'Content-Type', value: 'application/json' },
              { key: 'X-Custom-Env', value: 'production' },
            ],
          },
        },
      })
      const read = readWebSearchSettings()
      expect(read?.sourceMode).to.equal('custom')
      expect(read?.providers?.mcp?.enabled).to.be.true
      expect(read?.providers?.mcp?.serverUrls).to.deep.equal([
        'https://mcp.example.com/api/mcp',
      ])
      expect(read?.providers?.mcp?.bearerToken).to.equal(
        'test-oauth-bearer-token-123'
      )
      expect(read?.providers?.mcp?.headers).to.deep.equal([
        { key: 'Content-Type', value: 'application/json' },
        { key: 'X-Custom-Env', value: 'production' },
      ])
    })

    it('sends updated web search settings to server via PUT', function () {
      const settings = {
        sourceMode: 'custom' as const,
        providers: {
          searxng: { enabled: true, baseUrls: ['https://searx.example.com'] },
        },
      }
      writeWebSearchSettings(settings)

      const lastCall = fetchMock.callHistory.lastCall('/ai-assist/settings')
      expect(lastCall).to.exist
      const payload = JSON.parse(lastCall?.options?.body as string)
      expect(payload).to.deep.equal({ webSearch: settings })
    })

    it('clears web search settings and sends PUT with null', function () {
      const spy = sinon.spy()
      window.addEventListener('aiAssist:webSearchChanged', spy)
      try {
        writeWebSearchSettings({
          sourceMode: 'custom',
          providers: {
            searxng: { enabled: true, baseUrls: ['https://searx.example.com'] },
          },
        })
        expect(spy).to.have.been.calledOnce

        clearWebSearchSettings()
        expect(spy).to.have.been.calledTwice
        expect(readWebSearchSettings()).to.be.null

        const putCalls = fetchMock.callHistory
          .calls()
          .filter((c) => c.options?.method?.toLowerCase() === 'put')
        const lastPut = putCalls[putCalls.length - 1]
        expect(lastPut).to.exist
        const payload = JSON.parse(lastPut.options.body as string)
        expect(payload).to.deep.equal({ webSearch: null })
      } finally {
        window.removeEventListener('aiAssist:webSearchChanged', spy)
      }
    })
  })

  describe('credential security (no API keys in localStorage)', function () {
    it('does not store main provider API key in localStorage when calling writeSettings', function () {
      const apiKey = 'sk-live-main-secret-key-12345'
      writeSettings({
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey,
        model: 'gpt-4o',
      })

      expect(customLocalStorage.getItem(SETTINGS_KEY)).to.be.null
      expect(localStorage.getItem(SETTINGS_KEY)).to.be.null

      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)!
        const value = localStorage.getItem(key) || ''
        expect(value).to.not.include(apiKey)
      }
    })

    it('does not store fast provider API key in localStorage when calling writeFastSettings', function () {
      const apiKey = 'sk-ant-fast-secret-key-67890'
      writeFastSettings({
        type: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey,
        model: 'claude-3-5-haiku-20241022',
      })

      expect(customLocalStorage.getItem(FAST_SETTINGS_KEY)).to.be.null
      expect(localStorage.getItem(FAST_SETTINGS_KEY)).to.be.null

      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)!
        const value = localStorage.getItem(key) || ''
        expect(value).to.not.include(apiKey)
      }
    })

    it('does not store web search API keys or bearer tokens in localStorage when calling writeWebSearchSettings', function () {
      const tavilyKey = 'tvly-secret-key-4444'
      const bearerToken = 'mcp-bearer-token-5555'
      writeWebSearchSettings({
        sourceMode: 'custom',
        providers: {
          tavily: {
            enabled: true,
            apiKeys: [tavilyKey],
          },
          mcp: {
            enabled: true,
            serverUrls: ['https://mcp.example.com'],
            bearerToken,
          },
        },
      })

      expect(customLocalStorage.getItem(WEB_SEARCH_KEY)).to.be.null
      expect(localStorage.getItem(WEB_SEARCH_KEY)).to.be.null

      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)!
        const value = localStorage.getItem(key) || ''
        expect(value).to.not.include(tavilyKey)
        expect(value).to.not.include(bearerToken)
      }
    })

    it('purges credentials from localStorage upon initServerSettings migration', async function () {
      const providerKey = 'sk-legacy-provider-key-999'
      const fastKey = 'sk-legacy-fast-key-888'
      const searchKey = 'tvly-legacy-search-key-777'

      customLocalStorage.setItem(SETTINGS_KEY, {
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: providerKey,
        model: 'gpt-4o',
      })
      customLocalStorage.setItem(FAST_SETTINGS_KEY, {
        type: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: fastKey,
        model: 'claude-3-5-sonnet',
      })
      customLocalStorage.setItem(WEB_SEARCH_KEY, {
        type: 'tavily',
        apiKey: searchKey,
      })

      fetchMock.removeRoutes().clearHistory()
      let migrationPayload: any = null
      fetchMock.put('/ai-assist/settings', (callLog) => {
        migrationPayload = JSON.parse(callLog.options.body as string)
        return { status: 200, body: { success: true } }
      })
      fetchMock.get('/ai-assist/settings', {
        status: 200,
        body: { provider: null, fastProvider: null, webSearch: null },
      })

      await initServerSettings()

      expect(migrationPayload).to.not.be.null
      expect(migrationPayload.provider.apiKey).to.equal(providerKey)
      expect(migrationPayload.fastProvider.apiKey).to.equal(fastKey)
      expect(
        migrationPayload.webSearch.providers.tavily.apiKeys
      ).to.deep.equal([searchKey])

      expect(customLocalStorage.getItem(SETTINGS_KEY)).to.be.null
      expect(customLocalStorage.getItem(FAST_SETTINGS_KEY)).to.be.null
      expect(customLocalStorage.getItem(WEB_SEARCH_KEY)).to.be.null

      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)!
        const value = localStorage.getItem(key) || ''
        expect(value).to.not.include(providerKey)
        expect(value).to.not.include(fastKey)
        expect(value).to.not.include(searchKey)
      }
    })
  })
})
