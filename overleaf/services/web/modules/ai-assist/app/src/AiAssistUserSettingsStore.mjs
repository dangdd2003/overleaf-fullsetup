import { AiAssistUserSettingsModel } from './AiAssistUserSettingsModel.mjs'
import { seal, open } from './connectors/ConnectorCrypto.mjs'
import { normalizeProviderBaseUrl } from './AiAssistProviders.mjs'

export const MASKED_SECRET = '••••••••'

function providerContext(userId, slot, field) {
  return `aiAssistUserSettings:${userId}:${slot}:${field}`
}

function webSearchKeyContext(userId, providerName, index) {
  return `aiAssistUserSettings:${userId}:webSearch:${providerName}:${index}`
}

function webSearchTokenContext(userId, providerName) {
  return `aiAssistUserSettings:${userId}:webSearch:${providerName}:bearerToken`
}

function sealProvider(userId, slot, incoming, existing) {
  if (!incoming || typeof incoming !== 'object' || !incoming.type) {
    return null
  }
  let apiKey = null
  if (incoming.apiKey === MASKED_SECRET) {
    apiKey = existing?.apiKey ?? null
  } else if (typeof incoming.apiKey === 'string' && incoming.apiKey.trim()) {
    apiKey = seal(incoming.apiKey.trim(), providerContext(userId, slot, 'apiKey'))
  }

  const type = String(incoming.type)
  const rawBaseUrl = typeof incoming.baseUrl === 'string' ? incoming.baseUrl.trim() : ''
  let baseUrl = rawBaseUrl
  if (rawBaseUrl) {
    try {
      baseUrl = normalizeProviderBaseUrl(type, rawBaseUrl)
    } catch {
      // Keep the raw value so a malformed URL does not fail the whole save
    }
  }

  return {
    type,
    baseUrl,
    apiKey,
    model: typeof incoming.model === 'string' ? incoming.model.trim() : '',
    modelName: typeof incoming.modelName === 'string' ? incoming.modelName.trim() : '',
    contextWindow: Number.isFinite(incoming.contextWindow) ? Number(incoming.contextWindow) : null,
    maxOutputTokens: Number.isFinite(incoming.maxOutputTokens) ? Number(incoming.maxOutputTokens) : null,
  }
}

function maskProvider(stored) {
  if (!stored || !stored.type) return null
  const hasApiKey = Boolean(stored.apiKey)
  const { apiKey: _omit, ...rest } = stored
  return {
    ...rest,
    apiKey: hasApiKey ? MASKED_SECRET : '',
    hasApiKey,
  }
}

function openProvider(userId, slot, stored) {
  if (!stored || !stored.type) return null
  let apiKey = ''
  if (stored.apiKey) {
    try {
      apiKey = open(stored.apiKey, providerContext(userId, slot, 'apiKey')) || ''
    } catch {
      apiKey = ''
    }
  }
  return {
    ...stored,
    apiKey,
  }
}

function sealWebSearch(userId, incoming, existing) {
  if (!incoming || typeof incoming !== 'object') return null
  const existingProviders = existing?.providers || {}
  const sealed = { ...incoming }
  if (incoming.providers && typeof incoming.providers === 'object') {
    const providers = {}
    for (const [name, pConfig] of Object.entries(incoming.providers)) {
      if (!pConfig || typeof pConfig !== 'object') continue
      const existingP = existingProviders[name] || {}
      const p = { ...pConfig }

      if (Array.isArray(p.apiKeys)) {
        p.apiKeys = p.apiKeys
          .map((k, idx) => {
            if (k === MASKED_SECRET) {
              return existingP.apiKeys?.[idx] ?? null
            }
            if (typeof k === 'string' && k.trim()) {
              return seal(k.trim(), webSearchKeyContext(userId, name, idx))
            }
            return null
          })
          .filter(Boolean)
      }

      if (p.bearerToken !== undefined) {
        if (p.bearerToken === MASKED_SECRET) {
          p.bearerToken = existingP.bearerToken ?? null
        } else if (typeof p.bearerToken === 'string' && p.bearerToken.trim()) {
          p.bearerToken = seal(p.bearerToken.trim(), webSearchTokenContext(userId, name))
        } else {
          p.bearerToken = null
        }
      }

      providers[name] = p
    }
    sealed.providers = providers
  }
  return sealed
}

function maskWebSearch(stored) {
  if (!stored || typeof stored !== 'object') return null
  const masked = { ...stored }
  if (stored.providers && typeof stored.providers === 'object') {
    const providers = {}
    for (const [name, pConfig] of Object.entries(stored.providers)) {
      if (!pConfig || typeof pConfig !== 'object') continue
      const p = { ...pConfig }
      if (Array.isArray(p.apiKeys)) {
        p.hasApiKey = p.apiKeys.length > 0
        p.apiKeys = p.apiKeys.map(() => MASKED_SECRET)
      }
      if (p.bearerToken !== undefined) {
        p.hasBearerToken = Boolean(p.bearerToken)
        p.bearerToken = p.bearerToken ? MASKED_SECRET : undefined
      }
      providers[name] = p
    }
    masked.providers = providers
  }
  return masked
}

function openWebSearch(userId, stored) {
  if (!stored || typeof stored !== 'object') return null
  const opened = { ...stored }
  if (stored.providers && typeof stored.providers === 'object') {
    const providers = {}
    for (const [name, pConfig] of Object.entries(stored.providers)) {
      if (!pConfig || typeof pConfig !== 'object') continue
      const p = { ...pConfig }
      if (Array.isArray(p.apiKeys)) {
        p.apiKeys = p.apiKeys
          .map((k, idx) => {
            try {
              return open(k, webSearchKeyContext(userId, name, idx))
            } catch {
              return null
            }
          })
          .filter(Boolean)
      }
      if (p.bearerToken) {
        try {
          p.bearerToken = open(p.bearerToken, webSearchTokenContext(userId, name)) || ''
        } catch {
          p.bearerToken = ''
        }
      }
      providers[name] = p
    }
    opened.providers = providers
  }
  return opened
}

export class AiAssistUserSettingsStore {
  async getUserSettings(userId) {
    if (!userId) return { provider: null, fastProvider: null, webSearch: null }
    const doc = await AiAssistUserSettingsModel.findOne({ user_id: userId })
      .lean()
      .exec()
    if (!doc) {
      return { provider: null, fastProvider: null, webSearch: null }
    }
    return {
      provider: maskProvider(doc.provider),
      fastProvider: maskProvider(doc.fastProvider),
      webSearch: maskWebSearch(doc.webSearch),
    }
  }

  async getInternalUserSettings(userId) {
    if (!userId) return { provider: null, fastProvider: null, webSearch: null }
    const doc = await AiAssistUserSettingsModel.findOne({ user_id: userId })
      .lean()
      .exec()
    if (!doc) {
      return { provider: null, fastProvider: null, webSearch: null }
    }
    return {
      provider: openProvider(userId, 'provider', doc.provider),
      fastProvider: openProvider(userId, 'fastProvider', doc.fastProvider),
      webSearch: openWebSearch(userId, doc.webSearch),
    }
  }

  async saveUserSettings(userId, { provider, fastProvider, webSearch } = {}) {
    if (!userId) throw new Error('user_id is required')
    const existing = await AiAssistUserSettingsModel.findOne({ user_id: userId })
      .lean()
      .exec()

    const updateSet = {
      updatedAt: new Date(),
    }
    if (provider !== undefined) {
      updateSet.provider = sealProvider(userId, 'provider', provider, existing?.provider)
    }
    if (fastProvider !== undefined) {
      updateSet.fastProvider = sealProvider(userId, 'fastProvider', fastProvider, existing?.fastProvider)
    }
    if (webSearch !== undefined) {
      updateSet.webSearch = sealWebSearch(userId, webSearch, existing?.webSearch)
    }

    const saved = await AiAssistUserSettingsModel.findOneAndUpdate(
      { user_id: userId },
      { $set: updateSet },
      { upsert: true, new: true }
    )
      .lean()
      .exec()

    return {
      provider: maskProvider(saved.provider),
      fastProvider: maskProvider(saved.fastProvider),
      webSearch: maskWebSearch(saved.webSearch),
    }
  }
}

export default new AiAssistUserSettingsStore()
