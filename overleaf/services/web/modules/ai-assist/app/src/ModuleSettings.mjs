import Settings from "@overleaf/settings";
import { validateSafeProviderBaseUrl } from "./AiAssistProviders.mjs";
import { MAX_HISTORY_IMAGES } from "./AiAssistImages.mjs";
import { normalizeInstanceBaseUrl } from "./web-fetch/base-url.mjs";

function normalizeSearxngBaseUrl(raw) {
  return normalizeInstanceBaseUrl(raw, /\/search\/?$/);
}

function normalizeFirecrawlBaseUrl(raw) {
  return normalizeInstanceBaseUrl(raw, /\/v[12](\/.*)?$/);
}

// A whole number from the environment, or the fallback when it is unset or
// not a non-negative integer
function intFromEnv(name, fallback) {
  const raw = (process.env[name] || "").trim();
  return /^\d+$/.test(raw) ? Number(raw) : fallback;
}

// Operator tuning: how long and how much of the web search cache to keep, and
// how long to wait for a provider's first byte (slow self-hosted models need more)
const WEB_SEARCH_CACHE_HOURS = intFromEnv("AI_ASSIST_WEB_SEARCH_CACHE_HOURS", 24);
const WEB_SEARCH_MAX_CACHED_SEARCHES = intFromEnv(
  "AI_ASSIST_WEB_SEARCH_MAX_CACHED_SEARCHES",
  256,
);
const WEB_SEARCH_MAX_CACHED_PAGES = intFromEnv(
  "AI_ASSIST_WEB_SEARCH_MAX_CACHED_PAGES",
  64,
);
const REQUEST_TIMEOUT_SECONDS =
  intFromEnv("AI_ASSIST_REQUEST_TIMEOUT_SECONDS", 180) || 180;

// Fixed operating values
const WEB_SEARCH_ROTATION_STRATEGY = "round-robin";
const WEB_SEARCH_PRIMARY_PROVIDER = "searxng";
const ORPHAN_GRACE_SECONDS = 300;
const APPROVAL_TIMEOUT_SECONDS = 600;
const HEARTBEAT_STALE_SECONDS = 1800;
const STREAM_IDLE_SECONDS = 0;
const STREAM_KEEPALIVE_SECONDS = 15;
// A whole chat, as sent to start a run and as saved. 32 MiB is Anthropic's
// request ceiling (OpenAI takes 50 MB): room for a 1M-token conversation,
// whose old images the run drops before a request (maxHistoryImages).
const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
// Anthropic prompt cache lifetime, fixed at '5m' (1.25x write).
const PROMPT_CACHE_TTL = "5m";
const CHAT_HISTORY_DIR = "/var/lib/overleaf/data/ai-assist";
// SQLite file for cached web searches and pages; ':memory:' keeps them in RAM
const WEB_CACHE_PATH = "/var/lib/overleaf/data/ai-assist/web-cache.sqlite";

function parseKeyList(raw) {
  return (raw || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

// Keeps a credential out of enumeration (JSON, Object.keys, spreads)
function withSecret(obj, key, value) {
  Object.defineProperty(obj, key, {
    value,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return obj;
}

// The URLs that pass the safe provider check, after an optional normalizer
function safeBaseUrls(list, normalize = url => url) {
  return list
    .map(url => normalize(url))
    .filter(url => {
      if (!url) return false;
      try {
        validateSafeProviderBaseUrl(url);
        return true;
      } catch {
        return false;
      }
    });
}

let serverWebSearch = null;
function providerConfig(enabled, extra = {}, secrets = {}) {
  const conf = { enabled, ...extra };
  for (const [key, val] of Object.entries(secrets)) {
    if (val !== undefined) withSecret(conf, key, val);
  }
  return conf;
}

// Server-provided web search is configured only by the provider keys and URLs
// below. It is available exactly when at least one of them is set.
{
  const searxngUrls = safeBaseUrls(
    parseKeyList(process.env.AI_ASSIST_SEARXNG_URLS),
    normalizeSearxngBaseUrl,
  );

  const ollamaKeys = parseKeyList(process.env.AI_ASSIST_OLLAMA_API_KEYS);
  const websearchapiKeys = parseKeyList(
    process.env.AI_ASSIST_WEBSEARCHAPI_API_KEYS,
  );
  const tavilyKeys = parseKeyList(process.env.AI_ASSIST_TAVILY_API_KEYS);
  const firecrawlKeys = parseKeyList(
    process.env.AI_ASSIST_FIRECRAWL_API_KEYS,
  );
  const jinaKeys = parseKeyList(process.env.AI_ASSIST_JINA_API_KEYS);
  const langsearchKeys = parseKeyList(
    process.env.AI_ASSIST_LANGSEARCH_API_KEYS,
  );
  const exaKeys = parseKeyList(process.env.AI_ASSIST_EXA_API_KEYS);
  const tinyfishKeys = parseKeyList(process.env.AI_ASSIST_TINYFISH_API_KEYS);
  const parallelKeys = parseKeyList(process.env.AI_ASSIST_PARALLEL_API_KEYS);

  const mcpUrls = safeBaseUrls(parseKeyList(process.env.AI_ASSIST_MCP_URLS));

  let mcpHeaders = [];
  if (process.env.AI_ASSIST_MCP_HEADERS) {
    try {
      const parsed = JSON.parse(process.env.AI_ASSIST_MCP_HEADERS);
      if (Array.isArray(parsed)) {
        mcpHeaders = parsed
          .filter((h) => h && typeof h === "object" && h.key && h.value)
          .map((h) => ({
            key: String(h.key).trim(),
            value: String(h.value).trim(),
          }));
      } else if (parsed && typeof parsed === "object") {
        mcpHeaders = Object.entries(parsed)
          .map(([k, v]) => ({ key: String(k).trim(), value: String(v).trim() }))
          .filter((h) => h.key && h.value);
      }
    } catch {
      mcpHeaders = process.env.AI_ASSIST_MCP_HEADERS.split("\n")
        .map((line) => {
          const idx = line.indexOf(":");
          if (idx <= 0) return null;
          return {
            key: line.slice(0, idx).trim(),
            value: line.slice(idx + 1).trim(),
          };
        })
        .filter(Boolean);
    }
  }

  const mcpBearer = (process.env.AI_ASSIST_MCP_BEARER_TOKEN || "").trim();
  if (
    mcpBearer &&
    !mcpHeaders.some((h) => h.key.toLowerCase() === "authorization")
  ) {
    mcpHeaders.push({
      key: "Authorization",
      value: /^bearer\s/i.test(mcpBearer) ? mcpBearer : `Bearer ${mcpBearer}`,
    });
  }

  const firecrawlSelfHostedUrls = safeBaseUrls(
    parseKeyList(process.env.AI_ASSIST_FIRECRAWL_SELFHOSTED_URLS),
    normalizeFirecrawlBaseUrl,
  );

  const rotationStrategy = WEB_SEARCH_ROTATION_STRATEGY;
  const primaryProvider = WEB_SEARCH_PRIMARY_PROVIDER;

  const searxngEnabled = searxngUrls.length > 0;
  const ollamaEnabled = ollamaKeys.length > 0;
  const websearchapiEnabled = websearchapiKeys.length > 0;
  const tavilyEnabled = tavilyKeys.length > 0;
  const firecrawlEnabled = firecrawlKeys.length > 0;
  const firecrawlSelfHostedEnabled = firecrawlSelfHostedUrls.length > 0;
  const jinaEnabled = jinaKeys.length > 0;
  const langsearchEnabled = langsearchKeys.length > 0;
  const exaEnabled = exaKeys.length > 0;
  const tinyfishEnabled = tinyfishKeys.length > 0;
  const parallelEnabled = parallelKeys.length > 0;
  const mcpEnabled = mcpUrls.length > 0;

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
    tinyfishEnabled ||
    parallelEnabled ||
    mcpEnabled
  ) {
    serverWebSearch = {
      enabled: true,
      providers: {
        searxng: providerConfig(
          searxngEnabled,
          {},
          { baseUrls: searxngUrls },
        ),
        ollama: providerConfig(ollamaEnabled, {}, { apiKeys: ollamaKeys }),
        websearchapi: providerConfig(
          websearchapiEnabled,
          {},
          { apiKeys: websearchapiKeys },
        ),
        tavily: providerConfig(tavilyEnabled, {}, { apiKeys: tavilyKeys }),
        firecrawl: providerConfig(
          firecrawlEnabled,
          {},
          { apiKeys: firecrawlKeys },
        ),
        firecrawlSelfHosted: providerConfig(
          firecrawlSelfHostedEnabled,
          {},
          { baseUrls: firecrawlSelfHostedUrls },
        ),
        jina: providerConfig(jinaEnabled, {}, { apiKeys: jinaKeys }),
        langsearch: providerConfig(
          langsearchEnabled,
          {},
          { apiKeys: langsearchKeys },
        ),
        exa: providerConfig(exaEnabled, {}, { apiKeys: exaKeys }),
        tinyfish: providerConfig(
          tinyfishEnabled,
          {},
          { apiKeys: tinyfishKeys },
        ),
        parallel: providerConfig(
          parallelEnabled,
          {},
          { apiKeys: parallelKeys },
        ),
        mcp: providerConfig(mcpEnabled, {}, {
          serverUrls: mcpUrls,
          headers: mcpHeaders.length > 0 ? mcpHeaders : undefined,
        }),
      },
      rotationStrategy,
      primaryProvider,
      cacheHours: WEB_SEARCH_CACHE_HOURS,
      maxCachedSearches: WEB_SEARCH_MAX_CACHED_SEARCHES,
      maxCachedPages: WEB_SEARCH_MAX_CACHED_PAGES,
    };
  }
}

// Bounded, tunable lifecycle limits. See the request-lifecycle spec §7.
// 0 disables the corresponding reaper, restoring "runs always finish".
// Merge into Settings.aiAssist — settings.defaults.js may already define
// { enabled, webToolsEnabled } before this module runs.
Settings.aiAssist = {
  ...Settings.aiAssist,
  enabled: process.env.AI_ASSIST_ENABLED === "true",
  webToolsEnabled: process.env.AI_ASSIST_WEB_TOOLS_ENABLED === "true",
  serverWebSearch,
  cacheHours: WEB_SEARCH_CACHE_HOURS,
  maxCachedSearches: WEB_SEARCH_MAX_CACHED_SEARCHES,
  maxCachedPages: WEB_SEARCH_MAX_CACHED_PAGES,
  // The headless-browser sidecar (services/overleaf-browser); unset leaves it out
  browser: withSecret(
    {
      url: (process.env.AI_ASSIST_BROWSER_URL || "").trim() || null,
    },
    "token",
    (process.env.AI_ASSIST_BROWSER_TOKEN || "").trim() || null,
  ),
  orphanGraceSeconds: ORPHAN_GRACE_SECONDS,
  approvalTimeoutSeconds: APPROVAL_TIMEOUT_SECONDS,
  heartbeatStaleSeconds: HEARTBEAT_STALE_SECONDS,
  requestTimeoutSeconds: REQUEST_TIMEOUT_SECONDS,
  streamIdleSeconds: STREAM_IDLE_SECONDS,
  streamKeepAliveSeconds: STREAM_KEEPALIVE_SECONDS,
  maxTranscriptBytes: MAX_TRANSCRIPT_BYTES,
  maxHistoryImages: MAX_HISTORY_IMAGES,
  promptCacheTtl: PROMPT_CACHE_TTL,
  chatHistoryDir: CHAT_HISTORY_DIR,
  webCachePath: WEB_CACHE_PATH,
};

export default Settings.aiAssist;
