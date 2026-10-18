import { describe, it, beforeEach, afterEach, vi } from "vitest";
import { expect } from "chai";

const ENV_KEYS = [
  "AI_ASSIST_MCP_URLS",
  "AI_ASSIST_MCP_BEARER_TOKEN",
  "AI_ASSIST_MCP_HEADERS",
  "AI_ASSIST_TAVILY_API_KEYS",
  "AI_ASSIST_SEARXNG_URLS",
  "AI_ASSIST_MCP_API_KEY",
  "AI_ASSIST_WEB_SEARCH_CACHE_HOURS",
  "AI_ASSIST_WEB_SEARCH_MAX_CACHED_SEARCHES",
  "AI_ASSIST_WEB_SEARCH_MAX_CACHED_PAGES",
  "AI_ASSIST_REQUEST_TIMEOUT_SECONDS",
];

async function loadSettings(env) {
  Object.assign(process.env, env);
  vi.resetModules();
  const { default: Settings } = await import("@overleaf/settings");
  await import("../../../app/src/ModuleSettings.mjs");
  return Settings;
}

async function loadServerWebSearch(env) {
  const Settings = await loadSettings(env);
  return Settings.aiAssist.serverWebSearch;
}

describe("ModuleSettings server MCP WebSearch", function () {
  let saved;

  beforeEach(function () {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(function () {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.resetModules();
  });

  it("reads the cache and request timeout settings", async function () {
    const Settings = await loadSettings({
      AI_ASSIST_WEB_SEARCH_CACHE_HOURS: "168",
      AI_ASSIST_WEB_SEARCH_MAX_CACHED_SEARCHES: "1000",
      AI_ASSIST_WEB_SEARCH_MAX_CACHED_PAGES: "200",
      AI_ASSIST_REQUEST_TIMEOUT_SECONDS: "600",
    });
    expect(Settings.aiAssist.cacheHours).to.equal(168);
    expect(Settings.aiAssist.maxCachedSearches).to.equal(1000);
    expect(Settings.aiAssist.maxCachedPages).to.equal(200);
    expect(Settings.aiAssist.requestTimeoutSeconds).to.equal(600);
  });

  it("keeps the defaults for unset or invalid tuning values", async function () {
    const Settings = await loadSettings({
      AI_ASSIST_WEB_SEARCH_CACHE_HOURS: "a week",
      AI_ASSIST_REQUEST_TIMEOUT_SECONDS: "0",
    });
    expect(Settings.aiAssist.cacheHours).to.equal(24);
    expect(Settings.aiAssist.maxCachedSearches).to.equal(256);
    expect(Settings.aiAssist.maxCachedPages).to.equal(64);
    expect(Settings.aiAssist.requestTimeoutSeconds).to.equal(180);
  });

  it("reads full endpoint URLs from env", async function () {
    const sws = await loadServerWebSearch({
      AI_ASSIST_MCP_URLS:
        "https://search.example.com/v1/search?src=overleaf, https://b.example.com/q",
    });
    const mcp = sws.providers.mcp;
    expect(mcp.enabled).to.be.true;
    expect(mcp.serverUrls).to.deep.equal([
      "https://search.example.com/v1/search?src=overleaf",
      "https://b.example.com/q",
    ]);
    expect(mcp.headers).to.be.undefined;
  });

  it("keeps the URLs out of serialized settings", async function () {
    const sws = await loadServerWebSearch({
      AI_ASSIST_MCP_URLS: "https://search.example.com/v1/search",
    });
    const json = JSON.stringify(sws);
    expect(json).to.not.include("search.example.com");
  });

  it("leaves MCP off when no URL is set", async function () {
    const sws = await loadServerWebSearch({});
    expect(sws).to.be.null;
  });

  it("reads bearer token and custom headers from env when configured", async function () {
    const sws = await loadServerWebSearch({
      AI_ASSIST_MCP_URLS: "https://search.example.com/v1/search",
      AI_ASSIST_MCP_BEARER_TOKEN: "secret-token-123",
      AI_ASSIST_MCP_HEADERS: JSON.stringify({ "X-Custom-Org": "12345" }),
    });
    const mcp = sws.providers.mcp;
    expect(mcp.enabled).to.be.true;
    expect(mcp.headers).to.deep.equal([
      { key: "X-Custom-Org", value: "12345" },
      { key: "Authorization", value: "Bearer secret-token-123" },
    ]);
  });

  it("enables server web search from any configured provider key, single or list", async function () {
    const single = await loadServerWebSearch({
      AI_ASSIST_TAVILY_API_KEYS: "tvly-one",
    });
    expect(single.enabled).to.be.true;
    expect(single.providers.tavily.enabled).to.be.true;
    expect(single.providers.tavily.apiKeys).to.deep.equal(["tvly-one"]);

    const list = await loadServerWebSearch({
      AI_ASSIST_TAVILY_API_KEYS: " tvly-one , tvly-two ",
    });
    expect(list.providers.tavily.apiKeys).to.deep.equal([
      "tvly-one",
      "tvly-two",
    ]);
  });

  it("uses the hardcoded defaults for tuning values", async function () {
    const Settings = await loadSettings({
      AI_ASSIST_TAVILY_API_KEYS: "tvly-one",
    });
    const sws = Settings.aiAssist.serverWebSearch;
    expect(sws.rotationStrategy).to.equal("round-robin");
    expect(sws.primaryProvider).to.equal("searxng");
    expect(sws.cacheHours).to.equal(24);
    expect(sws.maxCachedSearches).to.equal(256);
    expect(sws.maxCachedPages).to.equal(64);
    expect(Settings.aiAssist.orphanGraceSeconds).to.equal(300);
    expect(Settings.aiAssist.approvalTimeoutSeconds).to.equal(600);
    expect(Settings.aiAssist.heartbeatStaleSeconds).to.equal(1800);
    expect(Settings.aiAssist.requestTimeoutSeconds).to.equal(180);
    expect(Settings.aiAssist.streamIdleSeconds).to.equal(0);
    expect(Settings.aiAssist.streamKeepAliveSeconds).to.equal(15);
    expect(Settings.aiAssist.maxTranscriptBytes).to.equal(32 * 1024 * 1024);
    expect(Settings.aiAssist.maxHistoryImages).to.equal(20);
    expect(Settings.aiAssist.promptCacheTtl).to.equal("5m");
    expect(Settings.aiAssist.chatHistoryDir).to.equal(
      "/var/lib/overleaf/data/ai-assist",
    );
    expect(Settings.aiAssist.webCachePath).to.equal(
      "/var/lib/overleaf/data/ai-assist/web-cache.sqlite",
    );
    expect(Settings.aiAssist.browser).to.not.have.property("concurrency");
  });

  it("ignores the retired AI_ASSIST_MCP_API_KEY alias", async function () {
    const sws = await loadServerWebSearch({
      AI_ASSIST_MCP_URLS: "https://search.example.com/v1/search",
      AI_ASSIST_MCP_API_KEY: "old-alias-token",
    });
    expect(sws.providers.mcp.headers).to.be.undefined;
  });
});
