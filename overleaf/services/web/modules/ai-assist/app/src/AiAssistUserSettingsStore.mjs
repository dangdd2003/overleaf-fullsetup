import { AiAssistUserSettingsModel } from './AiAssistUserSettingsModel.mjs'
import { seal, open } from './connectors/ConnectorCrypto.mjs'
import { normalizeProviderBaseUrl } from './AiAssistProviders.mjs'

export const MASKED_SECRET = '••••••••'

function httpOrigin(url) {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return parsed.origin !== 'null' ? parsed.origin : null
}

function providerOrigin(type, rawBaseUrl) {
  if (
    !type ||
    (rawBaseUrl !== undefined &&
      rawBaseUrl !== null &&
      typeof rawBaseUrl !== 'string')
  ) {
    return null
  }
  try {
    return httpOrigin(normalizeProviderBaseUrl(type, rawBaseUrl))
  } catch {
    return null
  }
}

export function canReuseStoredProviderSecret(incoming, stored) {
  if (
    !incoming ||
    typeof incoming !== 'object' ||
    !stored ||
    typeof stored !== 'object'
  ) {
    return false
  }
  if (!stored.type || incoming.type !== stored.type) {
    return false
  }
  const storedOrigin = providerOrigin(
    stored.type,
    stored.baseUrl || stored.baseURL
  )
  if (!storedOrigin) return false

  const hasBaseUrl =
    typeof incoming.baseUrl === 'string' && incoming.baseUrl.trim() !== ''
  const hasBaseURL =
    typeof incoming.baseURL === 'string' && incoming.baseURL.trim() !== ''
  if (hasBaseUrl && hasBaseURL) {
    return (
      providerOrigin(incoming.type, incoming.baseUrl) === storedOrigin &&
      providerOrigin(incoming.type, incoming.baseURL) === storedOrigin
    )
  }
  const incomingOrigin = providerOrigin(
    incoming.type,
    incoming.baseUrl || incoming.baseURL
  )
  return Boolean(incomingOrigin && incomingOrigin === storedOrigin)
}

function parseWebProviderUrlOrigin(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return ''
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`
  try {
    return httpOrigin(withScheme)
  } catch {
    return null
  }
}

function collectWebProviderOrigins(providerConfig, { strict = false } = {}) {
  if (!providerConfig || typeof providerConfig !== 'object') {
    return strict ? null : new Set()
  }
  const rawEntries = []
  if (providerConfig.baseUrl !== undefined && providerConfig.baseUrl !== null) {
    if (typeof providerConfig.baseUrl !== 'string') {
      return strict ? null : new Set()
    }
    if (providerConfig.baseUrl.trim()) rawEntries.push(providerConfig.baseUrl)
  }
  for (const field of ['baseUrls', 'serverUrls']) {
    const list = providerConfig[field]
    if (list !== undefined && list !== null) {
      if (!Array.isArray(list)) {
        return strict ? null : new Set()
      }
      for (const item of list) {
        if (typeof item !== 'string') {
          if (strict) return null
          continue
        }
        if (item.trim()) rawEntries.push(item)
      }
    }
  }
  const origins = new Set()
  for (const raw of rawEntries) {
    const origin = parseWebProviderUrlOrigin(raw)
    if (!origin) {
      if (strict) return null
      continue
    }
    origins.add(origin)
  }
  return origins
}

export function canReuseStoredWebProviderSecret(incomingP, storedP) {
  if (
    !incomingP ||
    typeof incomingP !== 'object' ||
    !storedP ||
    typeof storedP !== 'object'
  ) {
    return false
  }
  const incomingOrigins = collectWebProviderOrigins(incomingP, { strict: true })
  if (!incomingOrigins) return false
  if (incomingOrigins.size === 0) return true

  const storedOrigins = collectWebProviderOrigins(storedP, { strict: false })
  if (storedOrigins.size === 0) return false
  for (const origin of incomingOrigins) {
    if (!storedOrigins.has(origin)) return false
  }
  return true
}

export function applyStoredProviderSecret(
  incoming,
  internal,
  { slot = 'provider', fallbackSlots = [] } = {}
) {
  const candidates = [slot, ...fallbackSlots]
    .map(name => internal?.[name])
    .filter(s => s?.type)

  if (!incoming || typeof incoming !== 'object' || !incoming.type) {
    return candidates[0] || incoming
  }

  if (!incoming.apiKey || incoming.apiKey === MASKED_SECRET) {
    const matched = candidates.find(stored =>
      canReuseStoredProviderSecret(incoming, stored)
    )
    if (matched) {
      return { ...incoming, apiKey: matched.apiKey }
    }
    if (incoming.apiKey === MASKED_SECRET) {
      return { ...incoming, apiKey: '' }
    }
  }
  return incoming
}

export function stripMaskedProviderSecret(providerSettings) {
  if (
    providerSettings &&
    typeof providerSettings === 'object' &&
    providerSettings.apiKey === MASKED_SECRET
  ) {
    return { ...providerSettings, apiKey: '' }
  }
  return providerSettings
}

function isEmptyCustomWebSearch(clientSettings) {
  return (
    !clientSettings.type &&
    (!clientSettings.providers ||
      Object.keys(clientSettings.providers).length === 0)
  )
}

export function hasMaskedWebSearchSecrets(clientSettings) {
  if (clientSettings?.sourceMode !== 'custom') return false
  if (isEmptyCustomWebSearch(clientSettings)) return true
  if (
    clientSettings.providers &&
    typeof clientSettings.providers === 'object'
  ) {
    return Object.values(clientSettings.providers).some(
      p =>
        (Array.isArray(p?.apiKeys) && p.apiKeys.includes(MASKED_SECRET)) ||
        p?.bearerToken === MASKED_SECRET ||
        p?.apiKey === MASKED_SECRET
    )
  }
  return false
}

export function mergeStoredWebSearchSettings(clientSettings, internalWebSearch) {
  if (!clientSettings || typeof clientSettings !== 'object') {
    return clientSettings
  }
  if (clientSettings.sourceMode !== 'custom') return clientSettings

  if (isEmptyCustomWebSearch(clientSettings)) {
    return internalWebSearch || clientSettings
  }

  if (
    !clientSettings.providers ||
    typeof clientSettings.providers !== 'object'
  ) {
    return clientSettings
  }

  const storedProviders = internalWebSearch?.providers || {}
  const providers = {}
  for (const [name, pConfig] of Object.entries(clientSettings.providers)) {
    if (!pConfig || typeof pConfig !== 'object') {
      providers[name] = pConfig
      continue
    }
    const p = { ...pConfig }
    const storedP = storedProviders[name]
    const canReuse = Boolean(
      storedP && canReuseStoredWebProviderSecret(p, storedP)
    )

    if (Array.isArray(p.apiKeys)) {
      p.apiKeys = p.apiKeys
        .map((k, idx) => {
          if (k === MASKED_SECRET) {
            return canReuse ? (storedP.apiKeys?.[idx] ?? null) : null
          }
          return k
        })
        .filter(k => k !== null && k !== undefined && k !== '')
    }
    if (p.apiKey === MASKED_SECRET) {
      delete p.apiKey
    }
    if (p.bearerToken === MASKED_SECRET) {
      if (canReuse && storedP.bearerToken) {
        p.bearerToken = storedP.bearerToken
      } else {
        delete p.bearerToken
      }
    }
    providers[name] = p
  }
  return { ...clientSettings, providers }
}

export async function resolveStoredWebSearchSettings(
  clientSettings,
  userSettingsStore,
  userId,
  // Settings the caller already loaded for this user, to skip a second read
  loadedInternal = null
) {
  if (!hasMaskedWebSearchSecrets(clientSettings)) {
    return clientSettings
  }
  let internalWebSearch = null
  if (loadedInternal) {
    internalWebSearch = loadedInternal.webSearch || null
  } else if (userId) {
    try {
      const internal = await userSettingsStore.getInternalUserSettings(userId)
      internalWebSearch = internal?.webSearch || null
    } catch {}
  }
  return mergeStoredWebSearchSettings(clientSettings, internalWebSearch)
}

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
    apiKey = canReuseStoredProviderSecret(incoming, existing)
      ? (existing?.apiKey ?? null)
      : null
  } else if (typeof incoming.apiKey === 'string' && incoming.apiKey.trim()) {
    apiKey = seal(incoming.apiKey.trim(), providerContext(userId, slot, 'apiKey'))
  }

  const type = String(incoming.type)
  const rawBaseUrl =
    typeof incoming.baseUrl === 'string'
      ? incoming.baseUrl.trim()
      : typeof incoming.baseURL === 'string'
        ? incoming.baseURL.trim()
        : ''
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
      const canReuse = canReuseStoredWebProviderSecret(p, existingP)

      if (Array.isArray(p.apiKeys)) {
        p.apiKeys = p.apiKeys
          .map((k, idx) => {
            if (k === MASKED_SECRET) {
              return canReuse ? (existingP.apiKeys?.[idx] ?? null) : null
            }
            if (typeof k === 'string' && k.trim()) {
              return seal(k.trim(), webSearchKeyContext(userId, name, idx))
            }
            return null
          })
          .filter(Boolean)
      }
      if (p.apiKey === MASKED_SECRET) {
        delete p.apiKey
      }

      if (p.bearerToken !== undefined) {
        if (p.bearerToken === MASKED_SECRET) {
          p.bearerToken = canReuse ? (existingP.bearerToken ?? null) : null
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

function emptySettings() {
  return { provider: null, fastProvider: null, webSearch: null }
}

export class AiAssistUserSettingsStore {
  async _loadDoc(userId) {
    return AiAssistUserSettingsModel.findOne({ user_id: userId }).lean().exec()
  }

  async getUserSettings(userId) {
    if (!userId) return emptySettings()
    const doc = await this._loadDoc(userId)
    if (!doc) return emptySettings()
    return {
      provider: maskProvider(doc.provider),
      fastProvider: maskProvider(doc.fastProvider),
      webSearch: maskWebSearch(doc.webSearch),
    }
  }

  async getInternalUserSettings(userId) {
    if (!userId) return emptySettings()
    const doc = await this._loadDoc(userId)
    if (!doc) return emptySettings()
    return {
      provider: openProvider(userId, 'provider', doc.provider),
      fastProvider: openProvider(userId, 'fastProvider', doc.fastProvider),
      webSearch: openWebSearch(userId, doc.webSearch),
    }
  }

  async saveUserSettings(userId, { provider, fastProvider, webSearch } = {}) {
    if (!userId) throw new Error('user_id is required')
    const existing = await this._loadDoc(userId)

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
