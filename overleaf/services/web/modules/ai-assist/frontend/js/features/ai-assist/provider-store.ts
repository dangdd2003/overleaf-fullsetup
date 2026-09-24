import customLocalStorage from '@/infrastructure/local-storage'
import getMeta from '@/utils/meta'
import {
  DEFAULT_BASE_URLS,
  ProviderSettings,
  ProviderType,
  WEB_SEARCH_DEFAULTS,
  WebSearchPreferences,
  WebSearchSettings,
} from './providers/types'

const SETTINGS_KEY = 'ai-assist:provider'
const WEB_SEARCH_KEY = 'ai-assist:web-search'
const CONSENT_KEY = 'ai-assist:consent'
const AI_ENABLED_KEY = 'ai-assist:enabled'

/**
 * Where the provider configuration lives.
 *
 * The browser calls the provider directly, the way Overleaf's own AI assistant
 * does, so the key stays in this browser and never reaches an Overleaf server.
 * That is the trade this design makes: no server-side storage, no server-side
 * quota, and a key that is readable by anything running on this origin.
 *
 * Storage goes through `customLocalStorage`, which JSON-encodes on the way in,
 * JSON-decodes on the way out, and turns a denied or full store into `null`
 * instead of an exception. A private-mode browser therefore just has no
 * provider, with no try/catch needed here.
 */
export function readSettings(): ProviderSettings | null {
  const parsed = customLocalStorage.getItem(SETTINGS_KEY)
  if (!parsed?.type) return null

  let type = parsed.type as ProviderType
  if ((type as any) === 'openai-compatible') type = 'openai'
  if ((type as any) === 'anthropic-compatible') type = 'anthropic'

  const result: ProviderSettings = {
    type,
    baseUrl: (parsed.baseUrl || DEFAULT_BASE_URLS[type] || '').trim(),
    apiKey: (parsed.apiKey ?? '').trim(),
    model: (parsed.model ?? '').trim(),
  }
  if (parsed.modelName) {
    result.modelName = parsed.modelName
  }
  return result
}

export function writeSettings(settings: ProviderSettings) {
  customLocalStorage.setItem(SETTINGS_KEY, settings)
}

export function clearSettings() {
  customLocalStorage.removeItem(SETTINGS_KEY)
}

/** Whether this instance offers web_search and web_fetch at all. */
export function isWebToolsAvailable(): boolean {
  return Boolean(getMeta('ol-aiAssistWebToolsEnabled'))
}

/**
 * The web search backend, stored beside the provider in this browser and sent
 * with each run. A stored entry that is incomplete reads as none.
 */
export function readWebSearchSettings(): WebSearchSettings | null {
  const parsed = customLocalStorage.getItem(WEB_SEARCH_KEY)
  const preferences = readWebSearchPreferences(parsed)
  if (parsed?.type === 'ollama') {
    const apiKey = String(parsed.apiKey ?? '').trim()
    return apiKey ? { type: 'ollama', apiKey, ...preferences } : null
  }
  if (parsed?.type === 'searxng') {
    const baseUrl = String(parsed.baseUrl ?? '').trim()
    return baseUrl ? { type: 'searxng', baseUrl, ...preferences } : null
  }
  return null
}

/** The stored cache and result-count choices that are whole numbers in range. */
function readWebSearchPreferences(parsed: any): WebSearchPreferences {
  const preferences: WebSearchPreferences = {}
  for (const key of Object.keys(WEB_SEARCH_DEFAULTS) as Array<
    keyof WebSearchPreferences
  >) {
    const value = parsed?.[key]
    const { min, max } = WEB_SEARCH_DEFAULTS[key]
    if (Number.isInteger(value) && value >= min && value <= max) {
      preferences[key] = value
    }
  }
  return preferences
}

export function writeWebSearchSettings(settings: WebSearchSettings) {
  customLocalStorage.setItem(WEB_SEARCH_KEY, settings)
}

export function clearWebSearchSettings() {
  customLocalStorage.removeItem(WEB_SEARCH_KEY)
}

/**
 * Whether the user has acknowledged that document text leaves this browser.
 *
 * Recorded per browser, since that is where the provider is configured.
 */
export function hasConsented(): boolean {
  return customLocalStorage.getItem(CONSENT_KEY) === true
}

export function recordConsent() {
  customLocalStorage.setItem(CONSENT_KEY, true)
}

/**
 * Whether AI features are currently enabled by the user.
 *
 * Checks explicit browser storage first, falling back to the server-rendered
 * `ol-showAiFeatures` meta tag, which defaults to true.
 */
export function isAiAssistEnabled(): boolean {
  const stored = customLocalStorage.getItem(AI_ENABLED_KEY)
  if (stored !== null && stored !== undefined) {
    return Boolean(stored)
  }
  const meta = getMeta('ol-showAiFeatures')
  if (meta !== undefined && meta !== null) {
    return Boolean(meta)
  }
  return true
}

export function setAiAssistEnabled(enabled: boolean) {
  customLocalStorage.setItem(AI_ENABLED_KEY, enabled)
}

