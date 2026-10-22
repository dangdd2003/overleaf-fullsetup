import type { ContextState, ContextThresholds } from './budget'

/**
 * Context window usage: the shared vocabulary of the composer's meter and the
 * `/context` dashboard.
 *
 * Three sources feed it, emitted by a server run once per provider request:
 *
 * - `contextUsage`: the run's anchored count before the request (the newest
 *   provider usage plus an estimate of what followed it), with the thresholds
 *   and the state the count is in. Newest wins for the meter's total.
 * - `usage`: what the provider billed for the request. Exact, but not every
 *   provider reports it (and an older chat has none).
 * - `contextBreakdown`: the run's own estimate of what the request held,
 *   split by category. Always present, and the only source of the split;
 *   scaled to `usage` when both exist.
 *
 * Mirrors Claude Code's `/context`: the dashboard lays the count out over the
 * window with the autocompact buffer shown as its own block.
 */

/** Token counts one provider request reported, normalised across providers. */
export type ProviderUsage = {
  /** Uncached prompt tokens (Anthropic `input_tokens`, OpenAI prompt minus cached). */
  inputTokens: number
  outputTokens: number
  /** Prompt tokens read from the provider's cache. */
  cacheReadTokens: number
  /** Prompt tokens written to the provider's cache (Anthropic only). */
  cacheCreationTokens: number
  /**
   * The provider counted only part of the prompt (Ollama's prompt_eval_count
   * leaves out its cached prefix), so the input side is a floor, not the
   * request's size. Such usage never calibrates the dashboard.
   */
  partialInput?: boolean
  /** The provider request this reports on; pairs with ContextBreakdown.step. */
  step?: number
}

/**
 * What one request held, estimated by the server per content type (prose,
 * JSON, LaTeX) on the provider's wire shapes, or counted exactly by the
 * provider's token-count API where `exactFixed` says so. Every field is a
 * token count.
 */
export type ContextBreakdown = {
  /** The shared system prompt (core, modes, style, web), slash commands excluded. */
  systemPrompt: number
  /**
   * The slash command catalogue the system prompt carries: our analogue of
   * Claude Code's skill listing, shown as its "Skills" row.
   */
  skills?: number
  /** AGENTS.md / project instructions block of the system prompt. */
  projectInstructions: number
  /** Connector (MCP) server instructions block of the system prompt. */
  connectorInstructions: number
  /** Built-in tool specs (project, compile, settings, PDF, plan tools). */
  builtinTools: number
  /** Web search / fetch tool specs. */
  webTools: number
  /** search_connector_tools / read_connector_result specs. */
  connectorHelperTools?: number
  /** Connector (MCP) tool specs sent this request, helpers excluded. */
  connectorTools: number
  /**
   * Every connector tool the chat's connectors offer, sent or deferred: the
   * dashboard's MCP list. `name` is the tool's own name (no mcp__ prefix),
   * `server` the connector's display name. Sent tools first, each group
   * largest first.
   */
  connectorToolDetails?: {
    name: string
    server: string
    tokens: number
    deferred?: boolean
  }[]
  /**
   * Framing the provider adds that no part above holds: per-message wrappers,
   * the tool-use system preamble. Estimated from per-provider constants.
   */
  overhead?: number
  /** System prompt and tool counts come from the provider's count API. */
  exactFixed?: boolean
  /** The provider request this describes; pairs with ProviderUsage.step. */
  step?: number
  /** User turns' own words plus frozen `<command>` blocks. */
  userMessages: number
  /** Frozen `<project-context>` envelopes of the user turns. */
  projectContext: number
  /** Assistant prose and tool-call arguments. */
  assistantMessages: number
  /** Tool results, total. */
  toolResults: number
  /** Per tool name, summed over the conversation. Largest first, at most 20. */
  toolResultDetails?: { name: string; tokens: number; count: number }[]
  /** Images attached to user turns or returned by tools. */
  images: number
  /** Messages the budget elided or dropped so far (counts, not tokens). */
  elidedMessages: number
  droppedMessages: number
  /** The limits the run resolved for this request. */
  contextWindow: number
  maxOutputTokens: number
  /** The block threshold (contextThresholds.blockAt): requests at or past it are not sent. */
  budget: number
  /** The model the request was sent to, when known. */
  model?: string
  /**
   * Connector tools the run can load (search_connector_tools) but did not
   * send this request. Not in the window; shown as a muted "deferred" row.
   */
  deferredConnectorTools?: number
  deferredConnectorToolCount?: number
}

/**
 * The anchored context count of one provider request, as the run emitted it
 * right before sending that request. Persisted on the assistant entry.
 */
export type ContextUsageRecord = {
  /** The provider request this count is for; pairs with ProviderUsage.step. */
  step: number
  /** Anchored total: the last reported usage plus the estimate after it. */
  tokens: number
  /** The part anchored on provider usage (0 when there was none). */
  anchoredTokens: number
  /** The estimated part of `tokens`. */
  estimatedTokens: number
  /** True when `tokens` is anchored on provider usage. */
  exact: boolean
  contextWindow: number
  thresholds: ContextThresholds
  state: ContextState
}

/** Server -> client events (added to the AgentEvent union). */
export type ContextUsageEvent =
  | { type: 'usage'; usage: ProviderUsage; step?: number }
  | { type: 'contextBreakdown'; breakdown: ContextBreakdown; step?: number }
  | ({ type: 'contextUsage' } & ContextUsageRecord)

/**
 * The rows the dashboard draws, in Claude Code's order and with its names:
 * Messages, System tools, MCP tools, Skills, System prompt, Memory files,
 * MCP server instructions, Since last update, Autocompact buffer, Free space.
 */
export type ContextCategoryId =
  /**
   * The conversation: your messages, AI replies, tool calls and results,
   * images, project context and provider framing. Exact usage: billed input
   * minus every fixed row, as Claude Code computes it.
   */
  | 'messages'
  /** Built-in, web and connector helper tool specs. */
  | 'systemTools'
  /** Connector (MCP) tool specs sent. */
  | 'mcpTools'
  /** The slash command catalogue in the system prompt. */
  | 'skills'
  /** The rest of the system prompt. */
  | 'systemPrompt'
  /** AGENTS.md project instructions. */
  | 'memoryFiles'
  /** Connector (MCP) server instructions. */
  | 'mcpInstructions'
  /** Estimated tokens added after the newest provider usage report. */
  | 'sinceLastUpdate'
  /** From the auto-compact threshold to the window's end (Claude Code's autocompact buffer). */
  | 'reserved'
  | 'free'

export type ContextCategory = {
  id: ContextCategoryId
  tokens: number
  /** Share of the context window, 0..100, unrounded. */
  percent: number
}

/** Everything the meter and the dashboard render, computed by `computeContextUsage`. */
export type ContextUsageSnapshot = {
  /** Tokens the conversation takes now (exact when `exact`). */
  usedTokens: number
  contextWindow: number
  maxOutputTokens: number
  /** Where requests are blocked: the block threshold. */
  budget: number
  /** usedTokens / contextWindow, 0..100, unrounded; drives the ring fill. */
  percentUsed: number
  /** usedTokens / budget, 0..100, unrounded. */
  percentOfBudget: number
  /** Where the count sits against the thresholds; drives the colour. */
  state: ContextState
  /** The window's thresholds: warn, auto-compact and block. */
  thresholds: ContextThresholds
  /** True when `usedTokens` is anchored on provider-reported usage. */
  exact: boolean
  /** The latest provider usage, when any. */
  usage?: ProviderUsage
  /** Categories in grid order, including `reserved` and `free`; sum = window. */
  categories: ContextCategory[]
  breakdown?: ContextBreakdown
  /**
   * Tokens that could join the window but are not in it now (deferred
   * connector tools). Never part of `categories`, the bar or the percentages.
   */
  deferred: { id: 'deferredConnectorTools'; tokens: number; count: number }[]
  model?: string
  /** True for a chat with no turns yet. */
  empty: boolean
}
