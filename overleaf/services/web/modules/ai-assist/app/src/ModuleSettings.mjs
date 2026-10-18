import Settings from "@overleaf/settings";
import { validateSafeProviderBaseUrl } from "./AiAssistProviders.mjs";

function normalizeSearxngBaseUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) return "";
  let value = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `http://${value}`;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return "";
  }
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname
    .replace(/\/search\/?$/, "")
    .replace(/\/+$/, "");
  return parsed.toString().replace(/\/+$/, "");
}

function normalizeFirecrawlBaseUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) return "";
  let value = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `http://${value}`;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return "";
  }
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname
    .replace(/\/v[12](\/.*)?$/, "")
    .replace(/\/+$/, "");
  return parsed.toString().replace(/\/+$/, "");
}

// Fixed operating values. These used to be AI_ASSIST_* environment variables;
// each one is the default every instance has always run with.
const WEB_SEARCH_CACHE_HOURS = 24;
const WEB_SEARCH_MAX_CACHED_SEARCHES = 256;
const WEB_SEARCH_MAX_CACHED_PAGES = 64;
const WEB_SEARCH_ROTATION_STRATEGY = "round-robin";
const WEB_SEARCH_PRIMARY_PROVIDER = "searxng";
const SEARXNG_DEFAULT_CATEGORIES = "";
const SEARXNG_DEFAULT_LANGUAGE = "";
const ORPHAN_GRACE_SECONDS = 300;
const APPROVAL_TIMEOUT_SECONDS = 600;
const HEARTBEAT_STALE_SECONDS = 1800;
const REQUEST_TIMEOUT_SECONDS = 180;
const STREAM_IDLE_SECONDS = 0;
const STREAM_KEEPALIVE_SECONDS = 15;
// A whole chat, as sent to start a run and as saved. 32 MiB is Anthropic's
// request ceiling (OpenAI takes 50 MB): room for a 1M-token conversation,
// whose old images the run drops before a request (maxHistoryImages).
const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
// User images each request re-sends: the newest ones, the rest dropped
const MAX_HISTORY_IMAGES = 20;
// Anthropic prompt cache lifetime, fixed at '5m' (1.25x write).
const PROMPT_CACHE_TTL = "5m";
const CHAT_HISTORY_DIR = "/var/lib/overleaf/data/ai-assist";
// SQLite file for cached web searches and pages; ':memory:' keeps them in RAM
const WEB_CACHE_PATH = "/var/lib/overleaf/data/ai-assist/web-cache.sqlite";

const cacheHours = WEB_SEARCH_CACHE_HOURS;
const maxCachedSearches = WEB_SEARCH_MAX_CACHED_SEARCHES;
const maxCachedPages = WEB_SEARCH_MAX_CACHED_PAGES;

function intFromEnv(name, fallback) {
  const val = process.env[name];
  if (val === undefined || val === '') return fallback;
  const parsed = parseInt(val, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseKeyList(raw) {
  return (raw || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

let serverWebSearch = null;
function providerConfig(enabled, extra = {}, secrets = {}) {
  const conf = { enabled, ...extra };
  for (const [key, val] of Object.entries(secrets)) {
    if (val !== undefined) {
      Object.defineProperty(conf, key, {
        value: val,
        enumerable: false,
        writable: true,
        configurable: true,
      });
    }
  }
  return conf;
}

// Server-provided web search is configured only by the provider keys and URLs
// below. It is available exactly when at least one of them is set.
{
  const searxngUrls = parseKeyList(process.env.AI_ASSIST_SEARXNG_URLS)
    .map((u) => normalizeSearxngBaseUrl(u))
    .filter((u) => {
      if (!u) return false;
      try {
        validateSafeProviderBaseUrl(u);
        return true;
      } catch {
        return false;
      }
    });

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

  const mcpUrls = parseKeyList(process.env.AI_ASSIST_MCP_URLS).filter((u) => {
    try {
      validateSafeProviderBaseUrl(u);
      return true;
    } catch {
      return false;
    }
  });

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

  const mcpBearer = (
    process.env.AI_ASSIST_MCP_BEARER_TOKEN ||
    process.env.AI_ASSIST_MCP_API_KEY ||
    ""
  ).trim();
  if (
    mcpBearer &&
    !mcpHeaders.some((h) => h.key.toLowerCase() === "authorization")
  ) {
    mcpHeaders.push({
      key: "Authorization",
      value: /^bearer\s/i.test(mcpBearer) ? mcpBearer : `Bearer ${mcpBearer}`,
    });
  }

  const firecrawlSelfHostedUrls = parseKeyList(
    process.env.AI_ASSIST_FIRECRAWL_SELFHOSTED_URLS,
  )
    .map((u) => normalizeFirecrawlBaseUrl(u))
    .filter((u) => {
      if (!u) return false;
      try {
        validateSafeProviderBaseUrl(u);
        return true;
      } catch {
        return false;
      }
    });

  const defaultCategories =
    SEARXNG_DEFAULT_CATEGORIES.trim() || undefined;
  const defaultLanguage = SEARXNG_DEFAULT_LANGUAGE.trim() || undefined;

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
          {
            ...(defaultCategories ? { defaultCategories } : {}),
            ...(defaultLanguage ? { defaultLanguage } : {}),
          },
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
        mcp: providerConfig(
          mcpEnabled,
          { ...(mcpHeaders.length > 0 ? { headers: mcpHeaders } : {}) },
          { serverUrls: mcpUrls },
        ),
      },
      rotationStrategy,
      primaryProvider,
      cacheHours,
      maxCachedSearches,
      maxCachedPages,
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
  cacheHours,
  maxCachedSearches,
  maxCachedPages,
  // The headless-browser sidecar (services/overleaf-browser); unset leaves it out
  browser: (() => {
    const obj = {
      url: (process.env.AI_ASSIST_BROWSER_URL || "").trim() || null,
      concurrency: Math.max(1, intFromEnv("AI_ASSIST_BROWSER_CONCURRENCY", 2)),
    };
    Object.defineProperty(obj, "token", {
      value: (process.env.AI_ASSIST_BROWSER_TOKEN || "").trim() || null,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    return obj;
  })(),
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
