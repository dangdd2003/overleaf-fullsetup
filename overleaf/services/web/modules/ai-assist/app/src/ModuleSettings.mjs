import Settings from '@overleaf/settings'
import { validateSafeProviderBaseUrl } from './AiAssistProviders.mjs'

function normalizeSearxngBaseUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return ''
  let value = raw.trim()
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `http://${value}`
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return ''
  }
  parsed.search = ''
  parsed.hash = ''
  parsed.pathname = parsed.pathname
    .replace(/\/search\/?$/, '')
    .replace(/\/+$/, '')
  return parsed.toString().replace(/\/+$/, '')
}

function normalizeFirecrawlBaseUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return ''
  let value = raw.trim()
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `http://${value}`
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return ''
  }
  parsed.search = ''
  parsed.hash = ''
  parsed.pathname = parsed.pathname
    .replace(/\/v[12](\/.*)?$/, '')
    .replace(/\/+$/, '')
  return parsed.toString().replace(/\/+$/, '')
}

function intFromEnv(name, fallback) {
  const val = process.env[name]
  if (val === undefined || val === '') return fallback
  const parsed = parseInt(val, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

// Bounded, tunable lifecycle limits. See the request-lifecycle spec §7.
// 0 disables the corresponding reaper, restoring "runs always finish".
// Merge into Settings.aiAssist — settings.defaults.js may already define
// { enabled, webToolsEnabled } before this module runs.
const cacheHours = intFromEnv('AI_ASSIST_WEB_SEARCH_CACHE_HOURS', 24)
const maxCachedSearches = intFromEnv(
  'AI_ASSIST_WEB_SEARCH_MAX_CACHED_SEARCHES',
  256
)
const maxCachedPages = intFromEnv('AI_ASSIST_WEB_SEARCH_MAX_CACHED_PAGES', 64)

const serverWebSearchEnabled =
  process.env.AI_ASSIST_WEB_SEARCH_SERVER_ENABLED === 'true'

let serverWebSearch = null
if (serverWebSearchEnabled) {
  const searxngUrlsRaw =
    process.env.AI_ASSIST_SEARXNG_URLS ||
    process.env.AI_ASSIST_SEARXNG_URL ||
    ''
  const searxngUrls = searxngUrlsRaw
    .split(',')
    .map(u => normalizeSearxngBaseUrl(u))
    .filter(u => {
      if (!u) return false
      try {
        validateSafeProviderBaseUrl(u)
        return true
      } catch {
        return false
      }
    })

  const ollamaKeysRaw =
    process.env.AI_ASSIST_OLLAMA_API_KEYS ||
    process.env.AI_ASSIST_OLLAMA_API_KEY ||
    ''
  const ollamaKeys = ollamaKeysRaw
    .split(',')
    .map(k => k.trim())
    .filter(Boolean)

  const websearchapiKeysRaw =
    process.env.AI_ASSIST_WEBSEARCHAPI_API_KEYS ||
    process.env.AI_ASSIST_WEBSEARCHAPI_API_KEY ||
    ''
  const websearchapiKeys = websearchapiKeysRaw
    .split(',')
    .map(k => k.trim())
    .filter(Boolean)

  const tavilyKeys = (
    process.env.AI_ASSIST_TAVILY_API_KEYS ||
    process.env.AI_ASSIST_TAVILY_API_KEY ||
    ''
  )
    .split(',')
    .map(k => k.trim())
    .filter(Boolean)

  const firecrawlKeys = (
    process.env.AI_ASSIST_FIRECRAWL_API_KEYS ||
    process.env.AI_ASSIST_FIRECRAWL_API_KEY ||
    ''
  )
    .split(',')
    .map(k => k.trim())
    .filter(Boolean)

  const jinaKeys = (
    process.env.AI_ASSIST_JINA_API_KEYS ||
    process.env.AI_ASSIST_JINA_API_KEY ||
    ''
  )
    .split(',')
    .map(k => k.trim())
    .filter(Boolean)

  const langsearchKeys = (
    process.env.AI_ASSIST_LANGSEARCH_API_KEYS ||
    process.env.AI_ASSIST_LANGSEARCH_API_KEY ||
    ''
  )
    .split(',')
    .map(k => k.trim())
    .filter(Boolean)

  const exaKeys = (
    process.env.AI_ASSIST_EXA_API_KEYS ||
    process.env.AI_ASSIST_EXA_API_KEY ||
    ''
  )
    .split(',')
    .map(k => k.trim())
    .filter(Boolean)

  const mcpUrlsRaw =
    process.env.AI_ASSIST_MCP_URLS ||
    process.env.AI_ASSIST_MCP_URL ||
    ''
  const mcpUrls = mcpUrlsRaw
    .split(',')
    .map(u => u.trim())
    .filter(u => {
      if (!u) return false
      try {
        validateSafeProviderBaseUrl(u)
        return true
      } catch {
        return false
      }
    })

  let mcpHeaders = []
  if (process.env.AI_ASSIST_MCP_HEADERS) {
    try {
      const parsed = JSON.parse(process.env.AI_ASSIST_MCP_HEADERS)
      if (Array.isArray(parsed)) {
        mcpHeaders = parsed
          .filter(h => h && typeof h === 'object' && h.key && h.value)
          .map(h => ({
            key: String(h.key).trim(),
            value: String(h.value).trim(),
          }))
      } else if (parsed && typeof parsed === 'object') {
        mcpHeaders = Object.entries(parsed)
          .map(([k, v]) => ({ key: String(k).trim(), value: String(v).trim() }))
          .filter(h => h.key && h.value)
      }
    } catch {
      mcpHeaders = process.env.AI_ASSIST_MCP_HEADERS
        .split('\n')
        .map(line => {
          const idx = line.indexOf(':')
          if (idx <= 0) return null
          return {
            key: line.slice(0, idx).trim(),
            value: line.slice(idx + 1).trim(),
          }
        })
        .filter(Boolean)
    }
  }

  const mcpBearer = (
    process.env.AI_ASSIST_MCP_BEARER_TOKEN ||
    process.env.AI_ASSIST_MCP_API_KEY ||
    ''
  ).trim()
  if (
    mcpBearer &&
    !mcpHeaders.some(h => h.key.toLowerCase() === 'authorization')
  ) {
    mcpHeaders.push({
      key: 'Authorization',
      value: `Bearer ${mcpBearer}`,
    })
  }

  const firecrawlSelfHostedUrls = (
    process.env.AI_ASSIST_FIRECRAWL_SELFHOSTED_URLS ||
    process.env.AI_ASSIST_FIRECRAWL_SELFHOSTED_URL ||
    ''
  )
    .split(',')
    .map(u => normalizeFirecrawlBaseUrl(u))
    .filter(u => {
      if (!u) return false
      try {
        validateSafeProviderBaseUrl(u)
        return true
      } catch {
        return false
      }
    })

  const defaultCategories =
    (process.env.AI_ASSIST_SEARXNG_DEFAULT_CATEGORIES || '').trim() || undefined
  const defaultLanguage =
    (process.env.AI_ASSIST_SEARXNG_DEFAULT_LANGUAGE || '').trim() || undefined

  const rotationStrategy = [
    'round-robin',
    'provider-priority',
    'sticky',
  ].includes(process.env.AI_ASSIST_WEB_SEARCH_ROTATION_STRATEGY)
    ? process.env.AI_ASSIST_WEB_SEARCH_ROTATION_STRATEGY
    : 'round-robin'

  const primaryProvider = [
    'searxng',
    'ollama',
    'websearchapi',
    'tavily',
    'firecrawl',
    'firecrawlSelfHosted',
    'jina',
    'langsearch',
    'exa',
    'mcp',
  ].includes(process.env.AI_ASSIST_WEB_SEARCH_PRIMARY_PROVIDER)
    ? process.env.AI_ASSIST_WEB_SEARCH_PRIMARY_PROVIDER
    : 'searxng'


  const searxngEnabled = searxngUrls.length > 0
  const ollamaEnabled = ollamaKeys.length > 0
  const websearchapiEnabled = websearchapiKeys.length > 0
  const tavilyEnabled = tavilyKeys.length > 0
  const firecrawlEnabled = firecrawlKeys.length > 0
  const firecrawlSelfHostedEnabled = firecrawlSelfHostedUrls.length > 0
  const jinaEnabled = jinaKeys.length > 0
  const langsearchEnabled = langsearchKeys.length > 0
  const exaEnabled = exaKeys.length > 0
  const mcpEnabled = mcpUrls.length > 0

  if (
    searxngEnabled ||
    ollamaEnabled ||
    websearchapiEnabled ||
    tavilyEnabled ||
    firecrawlEnabled ||
    firecrawlSelfHostedEnabled ||
    jinaEnabled ||
    langsearchEnabled ||
    exaEnabled ||
    mcpEnabled
  ) {
    serverWebSearch = {
      enabled: true,
      providers: {
        searxng: {
          enabled: searxngEnabled,
          baseUrls: searxngUrls,
          ...(defaultCategories ? { defaultCategories } : {}),
          ...(defaultLanguage ? { defaultLanguage } : {}),
        },
        ollama: {
          enabled: ollamaEnabled,
          apiKeys: ollamaKeys,
        },
        websearchapi: {
          enabled: websearchapiEnabled,
          apiKeys: websearchapiKeys,
        },
        tavily: {
          enabled: tavilyEnabled,
          apiKeys: tavilyKeys,
        },
        firecrawl: {
          enabled: firecrawlEnabled,
          apiKeys: firecrawlKeys,
        },
        firecrawlSelfHosted: {
          enabled: firecrawlSelfHostedEnabled,
          baseUrls: firecrawlSelfHostedUrls,
        },
        jina: {
          enabled: jinaEnabled,
          apiKeys: jinaKeys,
        },
        langsearch: {
          enabled: langsearchEnabled,
          apiKeys: langsearchKeys,
        },
        exa: {
          enabled: exaEnabled,
          apiKeys: exaKeys,
        },
        mcp: {
          enabled: mcpEnabled,
          serverUrls: mcpUrls,
          ...(mcpHeaders.length > 0 ? { headers: mcpHeaders } : {}),
        },
      },
      rotationStrategy,
      primaryProvider,
      cacheHours,
      maxCachedSearches,
      maxCachedPages,
    }
  }
}

Settings.aiAssist = {
  ...Settings.aiAssist,
  enabled: process.env.AI_ASSIST_ENABLED === 'true',
  webToolsEnabled: process.env.AI_ASSIST_WEB_TOOLS_ENABLED === 'true',
  serverWebSearch,
  cacheHours,
  maxCachedSearches,
  maxCachedPages,
  // The headless-browser sidecar (services/overleaf-browser); unset leaves it out
  browser: (() => {
    const obj = {
      url: (process.env.AI_ASSIST_BROWSER_URL || '').trim() || null,
      concurrency: Math.max(1, intFromEnv('AI_ASSIST_BROWSER_CONCURRENCY', 2)),
    }
    Object.defineProperty(obj, 'token', {
      value: (process.env.AI_ASSIST_BROWSER_TOKEN || '').trim() || null,
      enumerable: false,
      writable: true,
      configurable: true,
    })
    return obj
  })(),
  orphanGraceSeconds: intFromEnv('AI_ASSIST_ORPHAN_GRACE_SECONDS', 300),
  approvalTimeoutSeconds: intFromEnv('AI_ASSIST_APPROVAL_TIMEOUT_SECONDS', 600),
  heartbeatStaleSeconds: intFromEnv('AI_ASSIST_HEARTBEAT_STALE_SECONDS', 1800),
  requestTimeoutSeconds: intFromEnv('AI_ASSIST_REQUEST_TIMEOUT_SECONDS', 180),
  streamIdleSeconds: intFromEnv('AI_ASSIST_STREAM_IDLE_SECONDS', 0),
  streamKeepAliveSeconds: intFromEnv('AI_ASSIST_STREAM_KEEPALIVE_SECONDS', 15),
  maxTranscriptBytes: intFromEnv('AI_ASSIST_MAX_TRANSCRIPT_BYTES', 5000000),
  // Anthropic prompt cache lifetime: '5m' (default, 1.25x write) or '1h' (2x
  // write). An hour keeps a chat cached while the user reads a reply or edits
  // for longer than five minutes before writing again.
  promptCacheTtl: process.env.AI_ASSIST_PROMPT_CACHE_TTL === '1h' ? '1h' : '5m',
  chatHistoryDir:
    process.env.AI_ASSIST_CHAT_HISTORY_DIR ||
    '/var/lib/overleaf/data/ai-assist',
  // SQLite file for cached web searches and pages; ':memory:' keeps them in RAM
  webCachePath:
    process.env.AI_ASSIST_WEB_CACHE_PATH ||
    '/var/lib/overleaf/data/ai-assist/web-cache.sqlite',
}

export default Settings.aiAssist
