import crypto from "node:crypto";
import {
  ConnectorAuthError,
  ConnectorRpcError,
  ConnectorScopeError,
  McpClient,
} from "../connectors/McpClient.mjs";
import { connectorFetch } from "../connectors/ConnectorFetch.mjs";
import { ProviderError } from "../AiAssistErrors.mjs";
import { resolveDockerHostUrl } from "../AiAssistProviders.mjs";
import { clip, collapse, webError } from "./util.mjs";

/**
 * A custom search endpoint that does not speak MCP at all (no handshake, or
 * an empty tool list). The caller may then try the plain JSON contract.
 */
class McpNotSupportedError extends Error {
  constructor(message) {
    super(message);
    this.name = "McpNotSupportedError";
  }
}

const TOOL_CACHE_MS = 10 * 60 * 1000;
const TOOL_CACHE_MAX = 200;
const toolCache = new Map();

export function clearMcpToolCache() {
  toolCache.clear();
}

// Argument names a search or reader tool is likely to take, most common first
const SEARCH_ARGS = ["query", "q", "search", "search_query", "keywords"];
const READ_ARGS = ["url", "uri", "link", "href", "urls"];
const SEARCH_NAME = /search/i;
const SEARCH_AVOID = /read|fetch|url|scrape|crawl|browse/i;
const READ_NAME = /read|fetch|scrape|crawl|extract|url|page|browse/i;
const READ_AVOID = /search/i;
const RESULT_KEYS = ["results", "items", "organic"];
// Longest snippet kept per result, from the text a search tool answers with
const SNIPPET_MAX = 2000;
const NOT_MCP_STATUSES = [400, 404, 405];

/**
 * Headers for an MCP endpoint: its own custom headers, and its own Bearer
 * token unless one of them already sets Authorization. The MCP client sets
 * Accept and Content-Type itself, so the JSON defaults of the plain contract
 * are not sent here.
 */
export function mcpHeaders(endpoint = {}) {
  const headers = new Map();
  const entries = Array.isArray(endpoint.headers)
    ? endpoint.headers.map((h) => [h?.key, h?.value])
    : Object.entries(endpoint.headers || {});
  for (const [key, value] of entries) {
    if (typeof key === "string" && key && typeof value === "string") {
      headers.set(key.toLowerCase(), [key, value]);
    }
  }
  const token = (endpoint.bearerToken || endpoint.apiKey || "").trim();
  if (token && !headers.has("authorization")) {
    headers.set("authorization", [
      "Authorization",
      /^bearer\s/i.test(token) ? token : `Bearer ${token}`,
    ]);
  }
  return Object.fromEntries(headers.values());
}

/** The fetch, URL and deadline one MCP call uses, from a pool endpoint. */
export function mcpTarget(endpoint, { fetchFn, signal, timeoutMs }) {
  return {
    url: resolveDockerHostUrl(endpoint.baseUrl),
    headers: mcpHeaders(endpoint),
    fetchFn,
    signal,
    timeoutMs,
  };
}

function toolFor(tool, arg) {
  return { name: tool.name, arg, inputSchema: tool.inputSchema || {} };
}

/**
 * The argument a tool takes its text in: the first of the known names it
 * declares as a string (or array), else the only required string.
 */
function argumentFor(schema, candidates, { loose }) {
  const props =
    schema?.properties && typeof schema.properties === "object"
      ? schema.properties
      : {};
  const isText = (prop) =>
    prop && (prop.type === "string" || prop.type === "array");
  for (const name of candidates) {
    if (isText(props[name])) {
      return { name, array: props[name].type === "array" };
    }
  }
  const required = Array.isArray(schema?.required) ? schema.required : [];
  // A reader must take a URL by name, so only a search takes any single text
  if (
    loose &&
    required.length === 1 &&
    props[required[0]]?.type === "string"
  ) {
    return { name: required[0], array: false };
  }
  // A tool that declares no properties at all still gets the common name
  if (Object.keys(props).length === 0) {
    return { name: candidates[0], array: false };
  }
  return null;
}

function usableTool(tool) {
  return (
    tool &&
    typeof tool.name === "string" &&
    tool.annotations?.destructiveHint !== true
  );
}

function pickTool(tools, { name, avoid, args, loose }) {
  for (const tool of tools) {
    if (!usableTool(tool) || !name.test(tool.name) || avoid.test(tool.name)) {
      continue;
    }
    const arg = argumentFor(tool.inputSchema, args, { loose });
    if (arg) return toolFor(tool, arg);
  }
  return null;
}

/** The search tool of a server's tool list, or null. */
export function pickSearchTool(tools) {
  return pickTool(tools, {
    name: SEARCH_NAME,
    avoid: SEARCH_AVOID,
    args: SEARCH_ARGS,
    loose: true,
  });
}

/** The page-reading tool of a server's tool list, or null. */
export function pickReadTool(tools) {
  return pickTool(tools, {
    name: READ_NAME,
    avoid: READ_AVOID,
    args: READ_ARGS,
    loose: false,
  });
}

/**
 * The arguments for a call: the text in the chosen argument, and any other
 * required argument filled from the schema (its default, or the text for a
 * string such as Exa's "objective"). Fills are only for search; a reader
 * passes `fillText: false`.
 */
export function buildToolArguments(tool, text, { fillText = true } = {}) {
  const args = { [tool.arg.name]: tool.arg.array ? [text] : text };
  const props = tool.inputSchema?.properties || {};
  const required = Array.isArray(tool.inputSchema?.required)
    ? tool.inputSchema.required
    : [];
  for (const name of required) {
    if (name in args) continue;
    const prop = props[name] || {};
    if (prop.default !== undefined) args[name] = prop.default;
    else if (fillText && prop.type === "string") args[name] = text;
    else if (fillText && prop.type === "array") args[name] = [text];
  }
  return args;
}

function cacheKey(target, kind) {
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify([target.url, target.headers || {}]))
    .digest("hex")
    .slice(0, 24);
  return `${kind}:${digest}`;
}

function cachedTool(key) {
  const hit = toolCache.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    toolCache.delete(key);
    return null;
  }
  return hit.tool;
}

function rememberTool(key, tool) {
  if (toolCache.size >= TOOL_CACHE_MAX) {
    toolCache.delete(toolCache.keys().next().value);
  }
  toolCache.set(key, { tool, expires: Date.now() + TOOL_CACHE_MS });
}

/** Maps what the MCP client threw to an error the web tools can classify. */
function mcpError(err, { url, callerSignal, deadlineSignal, timeoutMs }) {
  if (callerSignal?.aborted) {
    return new ProviderError("Request was cancelled", { code: "aborted" });
  }
  if (deadlineSignal?.aborted) {
    return webError(
      `The MCP search server did not answer within ${timeoutMs / 1000}s.`,
      { kind: "network" },
    );
  }
  const message = err?.message || "MCP request failed";
  // The MCP client's HTTP errors carry their status only in the message
  const status = Number(err?.status ?? /HTTP (\d{3})/.exec(message)?.[1]);
  if (
    err instanceof ConnectorAuthError ||
    err instanceof ConnectorScopeError ||
    status === 401 ||
    status === 403
  ) {
    const authStatus = Number.isInteger(status) ? status : 401;
    return webError(
      `The MCP search server rejected the request (HTTP ${authStatus}).`,
      { status: authStatus },
    );
  }
  if (status === 429) {
    return webError("The MCP search server is rate limiting requests.", {
      status,
    });
  }
  if (Number.isInteger(status) && status >= 500) {
    return webError(`The MCP search server failed with HTTP ${status}.`, {
      status,
      kind: "network",
    });
  }
  if (/fetch failed|socket hang up|ECONN|ENOTFOUND|network|EAI_AGAIN/i.test(message)) {
    return webError(`Could not reach the MCP search server at ${url}: ${message}`, {
      kind: "network",
    });
  }
  return webError(`MCP search server error: ${message}`);
}

/**
 * The errors that mean the plain JSON contract should be tried instead: the
 * URL is not an MCP server, or it refused the caller before answering as one.
 * The contract's own reply then says why (the same text as a contract
 * endpoint's refusal).
 */
export function isNotMcpError(err) {
  if (err instanceof McpNotSupportedError) return true;
  if (err instanceof ConnectorRpcError && err.code === -32601) return true;
  if (err instanceof ConnectorAuthError || err instanceof ConnectorScopeError) {
    return true;
  }
  if ([...NOT_MCP_STATUSES, 401, 403].includes(Number(err?.status))) return true;
  return /SSE connection failed with HTTP (400|404|405)|HTTP (400|404|405)$/.test(
    err?.message || "",
  );
}

/**
 * Runs `run` on a connected MCP client for one call, and always closes it.
 * The whole call shares one deadline, and the caller's signal can end it.
 */
async function withMcpClient(target, run) {
  const timeoutMs = target.timeoutMs ?? 15_000;
  const deadlineSignal = AbortSignal.timeout(timeoutMs);
  const signal = target.signal
    ? AbortSignal.any([target.signal, deadlineSignal])
    : deadlineSignal;
  const client = new McpClient({
    url: target.url,
    headers: target.headers || {},
    fetch: target.fetchFn || connectorFetch,
  });
  try {
    await client.connect({ signal, timeoutMs });
    return await run(client, { signal, timeoutMs });
  } catch (err) {
    if (err?.kind === "network" || err?.code === "aborted" || err?.code === "webToolError") {
      throw err;
    }
    if (isNotMcpError(err)) throw err;
    throw mcpError(err, {
      url: target.url,
      callerSignal: target.signal,
      deadlineSignal,
      timeoutMs,
    });
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * The server's tool list. A server that lists no tools is not an MCP search
 * server (McpNotSupportedError).
 */
async function listToolsOrThrow(client, opts) {
  const tools = await client.listTools(opts);
  if (tools.length === 0) {
    throw new McpNotSupportedError("The endpoint lists no MCP tools.");
  }
  return tools;
}

/**
 * The tool a call needs, from the cache or the server's tool list. One that
 * lists tools but none fit the kind asked for is a real error.
 */
async function resolveTool(client, target, kind, opts) {
  const key = cacheKey(target, kind);
  const hit = cachedTool(key);
  if (hit) return hit;
  const tools = await listToolsOrThrow(client, opts);
  const tool = kind === "search" ? pickSearchTool(tools) : pickReadTool(tools);
  if (!tool) {
    const names = tools.map((t) => t.name).slice(0, 8).join(", ");
    throw webError(
      kind === "search"
        ? `The MCP search server has no search tool (it offers: ${names}).`
        : `The MCP search server has no page reader tool (it offers: ${names}).`,
    );
  }
  rememberTool(key, tool);
  return tool;
}

/**
 * Text of a tool result: its content parts joined. A result flagged isError
 * is a failure whatever the server meant by it.
 */
function resultText(result) {
  return (Array.isArray(result?.content) ? result.content : [])
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n\n");
}

function assertNotToolError(result, label) {
  if (!result?.isError) return;
  const detail = clip(collapse(resultText(result)), 300);
  throw webError(`${label} failed${detail ? `: ${detail}` : "."}`);
}

const NA = /^n\/?a$/i;
const SNIPPET_KEYS = new Set([
  "description",
  "snippet",
  "content",
  "summary",
  "excerpt",
  "highlights",
  "text",
]);

/**
 * Result blocks in the "Title: / URL: / Published: / Description:" text that
 * MCP search tools answer with, separated by blank lines or "---".
 */
export function parseResultBlocks(text) {
  const entries = [];
  let current = null;
  const start = () => {
    current = {};
    entries.push(current);
    return current;
  };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^-{3,}$/.test(line)) {
      current = null;
      continue;
    }
    if (/^https?:\/\//i.test(line)) {
      (current || start()).url ??= line;
      continue;
    }
    const match = /^([A-Za-z][A-Za-z ]{0,30}?)\s*:\s*(.*)$/.exec(line);
    const key = match ? match[1].trim().toLowerCase() : "";
    const value = match ? match[2].trim() : "";
    if (key === "title") {
      start().title = NA.test(value) ? "" : value;
    } else if (key === "url" || key === "link" || key === "source") {
      const entry = current || start();
      if (!entry.url) entry.url = value;
    } else if (key === "published" || key === "published date" || key === "date") {
      if (current && !NA.test(value)) current.publishedDate = value;
    } else if (key === "author") {
      continue;
    } else if (current) {
      const piece = SNIPPET_KEYS.has(key) ? value : line;
      if (piece && (current.snippet || "").length < SNIPPET_MAX) {
        const joined = current.snippet ? `${current.snippet} ${piece}` : piece;
        current.snippet = joined.slice(0, SNIPPET_MAX);
      }
    }
  }
  return entries;
}

/**
 * Result entries of a search answer: structuredContent when the server sends
 * it, else JSON text, else the "Title:" blocks of a text answer.
 */
export function mcpSearchEntries(result) {
  const structured = result?.structuredContent;
  if (Array.isArray(structured)) return structured;
  if (structured && typeof structured === "object") {
    for (const key of RESULT_KEYS) {
      if (Array.isArray(structured[key])) return structured[key];
    }
  }
  const text = resultText(result).trim();
  if (!text) return [];
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed;
      for (const key of RESULT_KEYS) {
        if (Array.isArray(parsed?.[key])) return parsed[key];
      }
    } catch {
      // Not JSON after all: read it as text blocks
    }
  }
  return parseResultBlocks(text);
}

/** Search through an MCP server: the result entries, unnormalized. */
export async function searchViaMcp(target, query) {
  return withMcpClient(target, async (client, opts) => {
    const tool = await resolveTool(client, target, "search", opts);
    const result = await client.callTool(
      tool.name,
      buildToolArguments(tool, query),
      opts,
    );
    assertNotToolError(result, "The MCP search tool");
    return mcpSearchEntries(result);
  });
}

/** Reads one page through an MCP server's reader tool: { title, text }. */
export async function readViaMcp(target, url) {
  return withMcpClient(target, async (client, opts) => {
    const tool = await resolveTool(client, target, "read", opts);
    const result = await client.callTool(
      tool.name,
      buildToolArguments(tool, url, { fillText: false }),
      opts,
    );
    assertNotToolError(result, "The MCP page reader");
    const structured =
      result?.structuredContent && typeof result.structuredContent === "object"
        ? result.structuredContent
        : {};
    const text =
      [structured.content, structured.markdown, structured.text].find(
        (value) => typeof value === "string" && value.trim(),
      ) || resultText(result);
    if (!text.trim()) {
      throw webError(`The MCP page reader returned no text for ${url}.`);
    }
    return {
      title: typeof structured.title === "string" ? structured.title : undefined,
      text,
    };
  });
}

/**
 * Lists the server's tools for a health check: whether it answers as MCP,
 * and whether it offers a search tool. Throws McpNotSupportedError when it
 * is not an MCP server.
 */
export async function probeMcpSearch(target) {
  return withMcpClient(target, async (client, opts) => {
    const tools = await listToolsOrThrow(client, opts);
    return { toolCount: tools.length, hasSearch: Boolean(pickSearchTool(tools)) };
  });
}
