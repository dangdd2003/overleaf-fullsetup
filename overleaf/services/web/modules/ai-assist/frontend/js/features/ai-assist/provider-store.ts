import customLocalStorage from '@/infrastructure/local-storage'
import { getJSON, putJSON } from '@/infrastructure/fetch-json'
import { debugConsole } from '@/utils/debugging'
import getMeta from '@/utils/meta'
import {
  DEFAULT_BASE_URLS,
  MultiWebSearchSettings,
  ProviderSettings,
  ProviderType,
  REASONING_EFFORTS,
  ReasoningEffort,
  WEB_SEARCH_DEFAULTS,
  WebSearchPreferences,
  WebSearchSettings,
} from './providers/types'

const SETTINGS_KEY = 'ai-assist:provider'
const WEB_SEARCH_KEY = 'ai-assist:web-search'
const CONSENT_KEY = 'ai-assist:consent'
const AI_ENABLED_KEY = 'ai-assist:enabled'
const REASONING_EFFORT_KEY = 'ai-assist:reasoning-effort'
const THINKING_KEY = 'ai-assist:thinking'

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
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('aiAssist:providerChanged'))
  }
}

export function clearSettings() {
  customLocalStorage.removeItem(SETTINGS_KEY)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('aiAssist:providerChanged'))
  }
}

/** Whether this instance offers web_search and web_fetch at all. */
export function isWebToolsAvailable(): boolean {
  return Boolean(getMeta('ol-aiAssistWebToolsEnabled'))
}

/** Whether the server provides a pre-configured base web search service. */
export function isServerWebSearchAvailable(): boolean {
  return Boolean(getMeta('ol-aiAssistServerWebSearchEnabled'))
}

/** Human-readable summary of what the server-configured search provides. */
export function getServerWebSearchSummary(): string {
  return (getMeta('ol-aiAssistServerWebSearchSummary') as string) || ''
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** How the server-provided search caches results, as the server is set up. */
export function getServerWebSearchCache(): WebSearchPreferences | undefined {
  return getMeta('ol-aiAssistServerWebSearchCache')
}

export function migrateLegacyWebSearchSettings(
  parsed: any
): MultiWebSearchSettings | null {
  if (!parsed || typeof parsed !== 'object') return null

  if (parsed.sourceMode === 'disabled') {
    return { sourceMode: 'disabled', providers: {} }
  }

  if (parsed.sourceMode === 'server') {
    return { sourceMode: 'server', providers: {} }
  }

  const preferences = readWebSearchPreferences(parsed)

  if (parsed.type && typeof parsed.type === 'string') {
    const type = parsed.type.trim()
    if (type === 'searxng') {
      const baseUrl = String(parsed.baseUrl ?? '').trim()
      if (!baseUrl) return null
      return {
        sourceMode: 'custom',
        providers: {
          searxng: { enabled: true, baseUrls: [baseUrl] },
        },
        rotationStrategy: 'round-robin',
        primaryProvider: 'searxng',
        ...preferences,
      }
    }

    if (type === 'firecrawlSelfHosted') {
      const baseUrl = String(parsed.baseUrl ?? '').trim()
      if (!baseUrl) return null
      return {
        sourceMode: 'custom',
        providers: {
          firecrawlSelfHosted: { enabled: true, baseUrls: [baseUrl] },
        },
        rotationStrategy: 'round-robin',
        primaryProvider: 'firecrawlSelfHosted',
        ...preferences,
      }
    }

    const apiKey = String(parsed.apiKey ?? '').trim()
    if (!apiKey) return null
    if (
      [
        'ollama',
        'websearchapi',
        'tavily',
        'firecrawl',
        'jina',
        'langsearch',
        'exa',
      ].includes(type)
    ) {
      return {
        sourceMode: 'custom',
        providers: {
          [type]: { enabled: true, apiKeys: [apiKey] },
        },
        rotationStrategy: 'round-robin',
        primaryProvider: type as any,
        ...preferences,
      }
    }
  }

  // Already multi-provider structure
  if (parsed.providers && typeof parsed.providers === 'object') {
    const ollamaKeys = Array.isArray(parsed.providers.ollama?.apiKeys)
      ? parsed.providers.ollama.apiKeys
          .map((k: any) => String(k ?? '').trim())
          .filter(Boolean)
      : []
    const searxngUrls = Array.isArray(parsed.providers.searxng?.baseUrls)
      ? parsed.providers.searxng.baseUrls
          .map((u: any) => String(u ?? '').trim())
          .filter(Boolean)
      : []
    const websearchapiKeys = Array.isArray(
      parsed.providers.websearchapi?.apiKeys
    )
      ? parsed.providers.websearchapi.apiKeys
          .map((k: any) => String(k ?? '').trim())
          .filter(Boolean)
      : []

    const tavilyKeys = Array.isArray(parsed.providers.tavily?.apiKeys)
      ? parsed.providers.tavily.apiKeys
          .map((k: any) => String(k ?? '').trim())
          .filter(Boolean)
      : []

    const firecrawlKeys = Array.isArray(parsed.providers.firecrawl?.apiKeys)
      ? parsed.providers.firecrawl.apiKeys
          .map((k: any) => String(k ?? '').trim())
          .filter(Boolean)
      : []

    const firecrawlSelfHostedUrls = Array.isArray(
      parsed.providers.firecrawlSelfHosted?.baseUrls
    )
      ? parsed.providers.firecrawlSelfHosted.baseUrls
          .map((u: any) => String(u ?? '').trim())
          .filter(Boolean)
      : []

    const jinaKeys = Array.isArray(parsed.providers.jina?.apiKeys)
      ? parsed.providers.jina.apiKeys
          .map((k: any) => String(k ?? '').trim())
          .filter(Boolean)
      : []

    const langsearchKeys = Array.isArray(parsed.providers.langsearch?.apiKeys)
      ? parsed.providers.langsearch.apiKeys
          .map((k: any) => String(k ?? '').trim())
          .filter(Boolean)
      : []

    const exaKeys = Array.isArray(parsed.providers.exa?.apiKeys)
      ? parsed.providers.exa.apiKeys
          .map((k: any) => String(k ?? '').trim())
          .filter(Boolean)
      : []

    const ollamaEnabled = Boolean(
      parsed.providers.ollama?.enabled && ollamaKeys.length > 0
    )
    const searxngEnabled = Boolean(
      parsed.providers.searxng?.enabled && searxngUrls.length > 0
    )

    const websearchapiEnabled = Boolean(
      parsed.providers.websearchapi?.enabled && websearchapiKeys.length > 0
    )

    const tavilyEnabled = Boolean(
      parsed.providers.tavily?.enabled && tavilyKeys.length > 0
    )

    const firecrawlEnabled = Boolean(
      parsed.providers.firecrawl?.enabled && firecrawlKeys.length > 0
    )

    const firecrawlSelfHostedEnabled = Boolean(
      parsed.providers.firecrawlSelfHosted?.enabled &&
      firecrawlSelfHostedUrls.length > 0
    )

    const jinaEnabled = Boolean(
      parsed.providers.jina?.enabled && jinaKeys.length > 0
    )

    const langsearchEnabled = Boolean(
      parsed.providers.langsearch?.enabled && langsearchKeys.length > 0
    )

    const exaEnabled = Boolean(
      parsed.providers.exa?.enabled && exaKeys.length > 0
    )

    if (
      !ollamaEnabled &&
      !searxngEnabled &&
      !websearchapiEnabled &&
      !tavilyEnabled &&
      !firecrawlEnabled &&
      !firecrawlSelfHostedEnabled &&
      !jinaEnabled &&
      !langsearchEnabled &&
      !exaEnabled
    )
      return null

    return {
      sourceMode: 'custom',
      providers: {
        ollama: {
          enabled: ollamaEnabled,
          apiKeys: ollamaKeys,
          ...(Number.isInteger(parsed.providers.ollama?.maxResults)
            ? { maxResults: parsed.providers.ollama.maxResults }
            : {}),
        },
        websearchapi: {
          enabled: websearchapiEnabled,
          apiKeys: websearchapiKeys,
          // Validated by the server, which drops anything it does not accept
          ...(isPlainObject(parsed.providers.websearchapi?.search)
            ? { search: parsed.providers.websearchapi.search }
            : {}),
          ...(isPlainObject(parsed.providers.websearchapi?.scrape)
            ? { scrape: parsed.providers.websearchapi.scrape }
            : {}),
        },
        tavily: {
          enabled: tavilyEnabled,
          apiKeys: tavilyKeys,
          // Validated by the server, which drops anything it does not accept
          ...(typeof parsed.providers.tavily?.projectId === 'string'
            ? { projectId: parsed.providers.tavily.projectId }
            : {}),
          ...(isPlainObject(parsed.providers.tavily?.search)
            ? { search: parsed.providers.tavily.search }
            : {}),
          ...(isPlainObject(parsed.providers.tavily?.extract)
            ? { extract: parsed.providers.tavily.extract }
            : {}),
        },
        firecrawl: {
          enabled: firecrawlEnabled,
          apiKeys: firecrawlKeys,
          // Validated by the server, which drops anything it does not accept
          ...(isPlainObject(parsed.providers.firecrawl?.search)
            ? { search: parsed.providers.firecrawl.search }
            : {}),
          ...(isPlainObject(parsed.providers.firecrawl?.scrape)
            ? { scrape: parsed.providers.firecrawl.scrape }
            : {}),
        },
        firecrawlSelfHosted: {
          enabled: firecrawlSelfHostedEnabled,
          baseUrls: firecrawlSelfHostedUrls,
          ...(isPlainObject(parsed.providers.firecrawlSelfHosted?.search)
            ? { search: parsed.providers.firecrawlSelfHosted.search }
            : {}),
          ...(isPlainObject(parsed.providers.firecrawlSelfHosted?.scrape)
            ? { scrape: parsed.providers.firecrawlSelfHosted.scrape }
            : {}),
        },
        jina: {
          enabled: jinaEnabled,
          apiKeys: jinaKeys,
          // Validated by the server, which drops anything it does not accept
          ...(isPlainObject(parsed.providers.jina?.search)
            ? { search: parsed.providers.jina.search }
            : {}),
          ...(isPlainObject(parsed.providers.jina?.read)
            ? { read: parsed.providers.jina.read }
            : {}),
        },
        langsearch: {
          enabled: langsearchEnabled,
          apiKeys: langsearchKeys,
          // Validated by the server, which drops anything it does not accept
          ...(isPlainObject(parsed.providers.langsearch?.search)
            ? { search: parsed.providers.langsearch.search }
            : {}),
        },
        exa: {
          enabled: exaEnabled,
          apiKeys: exaKeys,
          // Validated by the server, which drops anything it does not accept
          ...(isPlainObject(parsed.providers.exa?.search)
            ? { search: parsed.providers.exa.search }
            : {}),
          ...(isPlainObject(parsed.providers.exa?.read)
            ? { read: parsed.providers.exa.read }
            : {}),
        },
        searxng: {
          enabled: searxngEnabled,
          baseUrls: searxngUrls,
          defaultCategories:
            typeof parsed.providers.searxng?.defaultCategories === 'string'
              ? parsed.providers.searxng.defaultCategories.trim()
              : undefined,
          defaultLanguage:
            typeof parsed.providers.searxng?.defaultLanguage === 'string'
              ? parsed.providers.searxng.defaultLanguage.trim()
              : undefined,
          // Validated by the server, which drops anything it does not accept
          timeRange: parsed.providers.searxng?.timeRange,
          safeSearch: parsed.providers.searxng?.safeSearch,
        },
      },
      rotationStrategy:
        parsed.rotationStrategy === 'provider-priority' ||
        parsed.rotationStrategy === 'sticky'
          ? parsed.rotationStrategy
          : 'round-robin',
      primaryProvider:
        parsed.primaryProvider === 'ollama' ||
        parsed.primaryProvider === 'websearchapi' ||
        parsed.primaryProvider === 'tavily' ||
        parsed.primaryProvider === 'firecrawl' ||
        parsed.primaryProvider === 'firecrawlSelfHosted' ||
        parsed.primaryProvider === 'jina' ||
        parsed.primaryProvider === 'langsearch' ||
        parsed.primaryProvider === 'exa'
          ? parsed.primaryProvider
          : 'searxng',
      ...preferences,
    }
  }

  return null
}

/**
 * The web search backend, stored beside the provider in this browser and sent
 * with each run. A stored entry that is incomplete reads as none.
 */
export function readWebSearchSettings(): MultiWebSearchSettings | null {
  const parsed = customLocalStorage.getItem(WEB_SEARCH_KEY)
  const migrated = migrateLegacyWebSearchSettings(parsed)
  if (migrated) return migrated

  if (parsed === null && isServerWebSearchAvailable()) {
    return {
      sourceMode: 'server',
      providers: {},
    }
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

export function writeWebSearchSettings(settings: MultiWebSearchSettings) {
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

/** The reasoning effort picked for this provider type, if one was picked. */
export function readReasoningEffort(
  type: ProviderType
): ReasoningEffort | undefined {
  const stored = customLocalStorage.getItem(REASONING_EFFORT_KEY)
  const effort = stored && typeof stored === 'object' ? stored[type] : undefined
  return REASONING_EFFORTS[type]?.includes(effort) ? effort : undefined
}

export function writeReasoningEffort(
  type: ProviderType,
  effort: ReasoningEffort | undefined
) {
  const stored = customLocalStorage.getItem(REASONING_EFFORT_KEY)
  const efforts = stored && typeof stored === 'object' ? { ...stored } : {}
  if (effort) {
    efforts[type] = effort
  } else {
    delete efforts[type]
  }
  customLocalStorage.setItem(REASONING_EFFORT_KEY, efforts)
  saveComposerPreferences()
}

/** Whether thinking is on for this provider type; off until switched on. */
export function readThinking(type: ProviderType): boolean {
  const stored = customLocalStorage.getItem(THINKING_KEY)
  return Boolean(stored && typeof stored === 'object' && stored[type] === true)
}

export function writeThinking(type: ProviderType, enabled: boolean) {
  const stored = customLocalStorage.getItem(THINKING_KEY)
  const thinking = stored && typeof stored === 'object' ? { ...stored } : {}
  thinking[type] = enabled
  customLocalStorage.setItem(THINKING_KEY, thinking)
  saveComposerPreferences()
}

const PREFERENCES_URL = '/ai-assist/preferences'

type ComposerPreferences = {
  reasoningEffort: Partial<Record<ProviderType, ReasoningEffort>>
  thinking: Partial<Record<ProviderType, boolean>>
}

function localComposerPreferences(): ComposerPreferences {
  const efforts = customLocalStorage.getItem(REASONING_EFFORT_KEY)
  const thinking = customLocalStorage.getItem(THINKING_KEY)
  return {
    reasoningEffort: efforts && typeof efforts === 'object' ? efforts : {},
    thinking: thinking && typeof thinking === 'object' ? thinking : {},
  }
}

/** Saves the effort levels and thinking switches to the user's account. */
function saveComposerPreferences() {
  putJSON(PREFERENCES_URL, {
    body: { preferences: localComposerPreferences() },
  }).catch(() => {})
}

/**
 * Brings this browser in line with the user's account. The account wins; an
 * account with nothing saved yet takes what this browser has.
 */
export async function loadComposerPreferences() {
  try {
    const res = await getJSON<{
      preferences: ComposerPreferences | null
    }>(PREFERENCES_URL)
    if (!res || !res.preferences) {
      saveComposerPreferences()
      return
    }
    customLocalStorage.setItem(
      REASONING_EFFORT_KEY,
      res.preferences.reasoningEffort
    )
    customLocalStorage.setItem(THINKING_KEY, res.preferences.thinking)
  } catch {
    // Silently ignore preference sync errors in environments/tests where endpoint isn't available
  }
}
