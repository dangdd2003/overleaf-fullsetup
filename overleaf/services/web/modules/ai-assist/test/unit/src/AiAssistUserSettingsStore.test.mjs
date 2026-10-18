import { describe, it, beforeEach, afterEach, vi } from 'vitest'
import { expect } from 'chai'
import Settings from '@overleaf/settings'
import { AiAssistUserSettingsModel } from '../../../app/src/AiAssistUserSettingsModel.mjs'
import store from '../../../app/src/AiAssistUserSettingsStore.mjs'
import { open } from '../../../app/src/connectors/ConnectorCrypto.mjs'

const USER_ID = '607f1f77bcf86cd799439099'

describe('AiAssistUserSettingsStore', function () {
  const originalSecurity = Settings.security
  let userSettingsDoc = null

  beforeEach(function () {
    Settings.security = { sessionSecret: 'test-session-secret-for-user-settings-12345' }
    userSettingsDoc = null

    vi.spyOn(AiAssistUserSettingsModel, 'findOne').mockImplementation((filter) => ({
      lean: () => ({
        exec: async () => {
          if (userSettingsDoc && String(userSettingsDoc.user_id) === String(filter.user_id)) {
            return JSON.parse(JSON.stringify(userSettingsDoc))
          }
          return null
        },
      }),
      exec: async () => {
        if (userSettingsDoc && String(userSettingsDoc.user_id) === String(filter.user_id)) {
          return userSettingsDoc
        }
        return null
      },
    }))

    vi.spyOn(AiAssistUserSettingsModel, 'findOneAndUpdate').mockImplementation(
      (filter, update, options) => ({
        lean: () => ({
          exec: async () => {
            const now = new Date()
            const existing = userSettingsDoc || { user_id: filter.user_id, createdAt: now }
            userSettingsDoc = {
              ...existing,
              ...update.$set,
              user_id: filter.user_id,
              updatedAt: now,
            }
            return JSON.parse(JSON.stringify(userSettingsDoc))
          },
        }),
        exec: async () => {
          const now = new Date()
          const existing = userSettingsDoc || { user_id: filter.user_id, createdAt: now }
          userSettingsDoc = {
            ...existing,
            ...update.$set,
            user_id: filter.user_id,
            updatedAt: now,
          }
          return userSettingsDoc
        },
      })
    )
  })

  afterEach(function () {
    vi.restoreAllMocks()
    Settings.security = originalSecurity
  })

  it('returns default empty settings when no document exists', async function () {
    const res = await store.getUserSettings(USER_ID)
    expect(res).to.deep.equal({
      provider: null,
      fastProvider: null,
      webSearch: null,
    })
  })

  it('seals API keys at rest and masks them when returned to client', async function () {
    await store.saveUserSettings(USER_ID, {
      provider: {
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-secret-12345',
        model: 'gpt-5.4',
      },
      fastProvider: {
        type: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant-secret-999',
        model: 'claude-3-5-haiku-20241022',
      },
    })

    // In Mongo doc, API keys are encrypted (v2:...)
    expect(userSettingsDoc.provider.apiKey).to.match(/^v2:/)
    expect(userSettingsDoc.provider.apiKey).not.to.include('sk-secret-12345')
    expect(userSettingsDoc.fastProvider.apiKey).to.match(/^v2:/)
    expect(userSettingsDoc.fastProvider.apiKey).not.to.include('sk-ant-secret-999')

    // Read by frontend: masked
    const clientSettings = await store.getUserSettings(USER_ID)
    expect(clientSettings.provider.apiKey).to.equal('••••••••')
    expect(clientSettings.provider.hasApiKey).to.be.true
    expect(clientSettings.provider.model).to.equal('gpt-5.4')

    expect(clientSettings.fastProvider.apiKey).to.equal('••••••••')
    expect(clientSettings.fastProvider.hasApiKey).to.be.true

    // Read by backend: decrypted
    const internalSettings = await store.getInternalUserSettings(USER_ID)
    expect(internalSettings.provider.apiKey).to.equal('sk-secret-12345')
    expect(internalSettings.fastProvider.apiKey).to.equal('sk-ant-secret-999')
  })

  it('preserves existing encrypted key when client sends masked key back', async function () {
    await store.saveUserSettings(USER_ID, {
      provider: {
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-initial-secret',
        model: 'gpt-5.4',
      },
    })

    const initialEncrypted = userSettingsDoc.provider.apiKey

    // Client updates model, sends back masked key
    await store.saveUserSettings(USER_ID, {
      provider: {
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '••••••••',
        model: 'gpt-5.4-turbo',
      },
    })

    expect(userSettingsDoc.provider.apiKey).to.equal(initialEncrypted)
    const internal = await store.getInternalUserSettings(USER_ID)
    expect(internal.provider.apiKey).to.equal('sk-initial-secret')
    expect(internal.provider.model).to.equal('gpt-5.4-turbo')
  })

  it('clears API key when explicitly set to empty string or null', async function () {
    await store.saveUserSettings(USER_ID, {
      provider: {
        type: 'openai',
        apiKey: 'sk-initial-secret',
        model: 'gpt-5.4',
      },
    })

    await store.saveUserSettings(USER_ID, {
      provider: {
        type: 'openai',
        apiKey: '',
        model: 'gpt-5.4',
      },
    })

    expect(userSettingsDoc.provider.apiKey).to.be.null
    const client = await store.getUserSettings(USER_ID)
    expect(client.provider.hasApiKey).to.be.false
    expect(client.provider.apiKey).to.equal('')
  })

  it('encrypts and decrypts webSearch provider API keys and bearer tokens', async function () {
    await store.saveUserSettings(USER_ID, {
      webSearch: {
        sourceMode: 'custom',
        providers: {
          tavily: { enabled: true, apiKeys: ['tvly-secret-1'] },
          firecrawl: { enabled: true, apiKeys: ['fc-secret-2'] },
          mcp: { enabled: true, serverUrls: ['https://mcp.example.com'], bearerToken: 'bearer-secret-3' },
          searxng: { enabled: true, baseUrls: ['https://searxng.example.com'] },
        },
        rotationStrategy: 'round-robin',
        primaryProvider: 'tavily',
      },
    })

    // In Mongo doc: encrypted
    const rawTavilyKey = userSettingsDoc.webSearch.providers.tavily.apiKeys[0]
    expect(rawTavilyKey).to.match(/^v2:/)
    expect(rawTavilyKey).not.to.include('tvly-secret-1')

    const rawMcpToken = userSettingsDoc.webSearch.providers.mcp.bearerToken
    expect(rawMcpToken).to.match(/^v2:/)
    expect(rawMcpToken).not.to.include('bearer-secret-3')

    // Client view: masked
    const client = await store.getUserSettings(USER_ID)
    expect(client.webSearch.providers.tavily.apiKeys).to.deep.equal(['••••••••'])
    expect(client.webSearch.providers.tavily.hasApiKey).to.be.true
    expect(client.webSearch.providers.mcp.bearerToken).to.equal('••••••••')
    expect(client.webSearch.providers.mcp.hasBearerToken).to.be.true
    expect(client.webSearch.providers.searxng.baseUrls).to.deep.equal(['https://searxng.example.com'])

    // Internal view: decrypted
    const internal = await store.getInternalUserSettings(USER_ID)
    expect(internal.webSearch.providers.tavily.apiKeys).to.deep.equal(['tvly-secret-1'])
    expect(internal.webSearch.providers.firecrawl.apiKeys).to.deep.equal(['fc-secret-2'])
    expect(internal.webSearch.providers.mcp.bearerToken).to.equal('bearer-secret-3')
  })
})
