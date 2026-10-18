import { describe, it, beforeEach, afterEach, vi } from "vitest";
import { expect } from "chai";

const ENV_KEYS = [
  "AI_ASSIST_MCP_URLS",
  "AI_ASSIST_MCP_BEARER_TOKEN",
  "AI_ASSIST_MCP_HEADERS",
  "AI_ASSIST_TAVILY_API_KEYS",
  "AI_ASSIST_SEARXNG_URLS",
  "AI_ASSIST_BROWSER_CONCURRENCY",
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
    expect(Settings.aiAssist.browser.concurrency).to.equal(2);
  });

  it("configures browser concurrency from AI_ASSIST_BROWSER_CONCURRENCY", async function () {
    const Settings = await loadSettings({
      AI_ASSIST_BROWSER_CONCURRENCY: "5",
    });
    expect(Settings.aiAssist.browser.concurrency).to.equal(5);
  });

  it("falls back to default browser concurrency when invalid or empty", async function () {
    const empty = await loadSettings({
      AI_ASSIST_BROWSER_CONCURRENCY: "",
    });
    expect(empty.aiAssist.browser.concurrency).to.equal(2);

    const invalid = await loadSettings({
      AI_ASSIST_BROWSER_CONCURRENCY: "not-a-number",
    });
    expect(invalid.aiAssist.browser.concurrency).to.equal(2);
  });

  it("clamps browser concurrency to at least 1 when value is less than 1", async function () {
    const zero = await loadSettings({
      AI_ASSIST_BROWSER_CONCURRENCY: "0",
    });
    expect(zero.aiAssist.browser.concurrency).to.equal(1);

    const negative = await loadSettings({
      AI_ASSIST_BROWSER_CONCURRENCY: "-3",
    });
    expect(negative.aiAssist.browser.concurrency).to.equal(1);
  });
});
