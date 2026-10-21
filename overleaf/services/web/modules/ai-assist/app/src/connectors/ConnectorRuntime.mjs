import crypto from 'node:crypto'
import { ConnectorModel } from './ConnectorModel.mjs'
import { loadCredentials } from './ConnectorCredentials.mjs'
import {
  McpClient,
  ConnectorAuthError,
  ConnectorScopeError,
  ConnectorRpcError,
} from './McpClient.mjs'
import McpOAuth from './McpOAuth.mjs'
import {
  permissionKeyFor,
  toolHint,
  toolPermission,
} from './ConnectorService.mjs'
import {
  sanitizeToolSchema,
  flattenJsonSchema,
  coerceToolArgs,
} from '../AiAssistToolSchema.mjs'

export const READ_RESULT_TOOL = 'read_connector_result'
export const CONNECTOR_SEARCH_TOOL = 'search_connector_tools'

export const MAX_DESCRIPTION_CHARS = 4096
// A tool loaded through search gets its full description back, as Claude
// Code's ToolSearch does
export const MAX_LOADED_DESCRIPTION_CHARS = 16384
export const MAX_INSTRUCTIONS_CHARS = 4096
// The most text of one tool result a run keeps to page through, and how many
// long results it keeps at once: the oldest is dropped past that
export const MAX_RESULT_CHARS = 4 * 1024 * 1024
export const MAX_STORED_RESULTS = 20
export const TRUNCATION_MARKER = '… [description truncated]'
const INSTRUCTIONS_MARKER = '… [instructions truncated]'
const SUMMARY_CHARS = 160
const MAX_NAME = 64
const MAX_SERVER_KEY = 32
const DEFAULT_TIMEOUT_SECONDS = 120
// setTimeout fires at once for anything past 2^31 - 1 milliseconds
const MAX_TIMER_SECONDS = 2_147_483
const DEFAULT_TOOL_SEARCH_PERCENT = 10
const DEFAULT_CONTEXT_TOKENS = 200_000
const SEARCH_MAX_RESULTS = 5
const SEARCH_MAX_RESULTS_LIMIT = 50

// Parameter names every provider accepts, Gemini being the strictest: a
// letter or underscore, then letters, digits and underscores, at most 64
// characters.
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

function sanitizeIdentifier(str) {
  return String(str || '')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
}

function shortHash(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 6)
}

/**
 * Tool and server names keep their case and may contain `-`: the characters
 * MCP names are made of and providers accept. Anything else becomes `_`.
 */
export function sanitizeName(value, fallback) {
  const cleaned = String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '_')
  return /[a-zA-Z0-9]/.test(cleaned) ? cleaned : fallback
}

/** Fits `name` in 64 characters, keeping it unique with a hash of the whole. */
function fitName(name) {
  if (name.length <= MAX_NAME) return name
  return `${name.slice(0, MAX_NAME - 7)}_${shortHash(name)}`
}

function withSuffix(name, suffix) {
  const room = MAX_NAME - suffix.length
  return `${name.length > room ? name.slice(0, room) : name}${suffix}`
}

/**
 * The first free name at or after `base`: the base itself, then each seed
 * (a hash or id fragment that says where the name came from), then a counter.
 * Never returns a name already in `taken`, however many collide.
 */
export function uniqueName(base, taken, seeds = []) {
  const fitted = fitName(base)
  if (!taken.has(fitted)) return fitted
  for (const seed of seeds) {
    const candidate = withSuffix(fitted, `_${seed}`)
    if (!taken.has(candidate)) return candidate
  }
  for (let n = 2; ; n += 1) {
    const candidate = withSuffix(fitted, `_${n}`)
    if (!taken.has(candidate)) return candidate
  }
}

/** Cuts `text` to at most `max` characters, the marker included. */
function capText(text, max, marker = TRUNCATION_MARKER) {
  if (text.length <= max) return text
  return `${text.slice(0, max - marker.length)}${marker}`
}

/**
 * Renames parameters a provider would reject (`user-id`, `$filter`) and
 * returns the map back to the server's own names. Only the top level: that
 * is where function-calling APIs validate names.
 */
function providerSafeParameters(schema) {
  const renamed = {}
  if (!schema?.properties) return { schema, renamed }
  const properties = {}
  for (const [name, child] of Object.entries(schema.properties)) {
    let safe = name
    if (!VALID_NAME.test(name)) {
      safe = fitName(sanitizeIdentifier(name) || `arg_${shortHash(name)}`)
      if (!/^[A-Za-z_]/.test(safe)) safe = `_${safe}`.slice(0, MAX_NAME)
      while (properties[safe] || schema.properties[safe]) {
        safe = fitName(`${safe}_${shortHash(name + safe)}`)
      }
      renamed[safe] = name
    }
    properties[safe] = child
  }
  const required = Array.isArray(schema.required)
    ? schema.required.map(
        name => Object.keys(renamed).find(k => renamed[k] === name) || name
      )
    : schema.required
  return { schema: { ...schema, properties, required }, renamed }
}

/**
 * About a quarter of the model's context window, at 4 characters a token:
 * the most of one tool result that is worth putting in front of the model at
 * once. Anything longer is kept whole and read page by page.
 */
export function resultPageChars(contextWindow) {
  const tokens = Number(contextWindow)
  return Math.max(8_000, Math.round((tokens > 0 ? tokens : 200_000) * 4 * 0.25))
}

/**
 * How connector tools are offered: "auto" (the default) defers the tools
 * when their schemas would take at least a percentage of the context window
 * ("auto:N" sets N, default 10); "true"/"always" always defers; "false"/"off"
 * never does. Anything else reads as "auto".
 */
export function connectorToolSearchMode(value) {
  const raw = String(value ?? 'auto').trim().toLowerCase()
  if (raw === 'true' || raw === 'always') {
    return { mode: 'always', percent: DEFAULT_TOOL_SEARCH_PERCENT }
  }
  if (raw === 'false' || raw === 'off') {
    return { mode: 'off', percent: DEFAULT_TOOL_SEARCH_PERCENT }
  }
  const match = /^auto(?::(\d+(?:\.\d+)?))?$/.exec(raw)
  if (match) {
    const percent = match[1] === undefined ? DEFAULT_TOOL_SEARCH_PERCENT : Number(match[1])
    if (percent > 0 && percent <= 100) return { mode: 'auto', percent }
  }
  return { mode: 'auto', percent: DEFAULT_TOOL_SEARCH_PERCENT }
}

function positiveNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function timeoutSecondsFrom(value) {
  return positiveNumber(value) ?? DEFAULT_TIMEOUT_SECONDS
}

/** A description, verbatim; the title stands in when there is none. */
function descriptionOf(tool, fallback) {
  if (typeof tool?.description === 'string' && tool.description.trim()) {
    return tool.description
  }
  return tool?.title || fallback || ''
}

/** The first sentence, else the first line, of a description, for a list. */
export function toolSummary(description, fallback = '') {
  const text = String(description || '').trim()
  const firstLine = (text.split(/\r?\n/).find(line => line.trim()) || '').trim()
  const sentence = /^(.+?[.!?])(\s|$)/.exec(firstLine)
  const line = (sentence ? sentence[1] : firstLine) || String(fallback || '')
  return capText(line, SUMMARY_CHARS, '…')
}

/** One content block as text the model reads. */
function blockText(block, serverName) {
  switch (block?.type) {
    case 'text':
      return typeof block.text === 'string' ? block.text : String(block.text ?? '')
    case 'image':
      return `[Image: ${block.mimeType || 'image/png'}]`
    case 'audio':
      return `[Audio: ${block.mimeType || 'audio/wav'}]`
    case 'resource': {
      const resource = block.resource || {}
      if (typeof resource.text === 'string') {
        return `[Resource from ${serverName} at ${resource.uri ?? ''}]\n${resource.text}`
      }
      return `[Binary resource ${resource.uri ?? ''} (${resource.mimeType || 'application/octet-stream'}), not shown]`
    }
    case 'resource_link': {
      const description = block.description ? ` (${block.description})` : ''
      return `[Resource link: ${block.name ?? ''}] ${block.uri ?? ''}${description}`
    }
    default:
      return JSON.stringify(block)
  }
}

/**
 * An MCP tool result as the text the model reads. structuredContent is used
 * only when the result has no content blocks.
 */
export function contentText(rawResult, serverName = '') {
  if (typeof rawResult === 'string') return rawResult
  const content = rawResult?.content
  if (Array.isArray(content) && content.length > 0) {
    return content.map(block => blockText(block, serverName)).join('\n')
  }
  if (rawResult?.structuredContent != null) {
    return JSON.stringify(rawResult.structuredContent)
  }
  if (Array.isArray(content)) return ''
  return JSON.stringify(rawResult ?? null)
}

/** The server did not answer a tool call in time. The call may have run. */
export class ConnectorTimeoutError extends Error {
  constructor(connectorName, toolName, seconds) {
    super(
      `MCP server "${connectorName}" did not answer tool "${toolName}" within ${seconds}s. The outcome is unknown — it may or may not have run on the server; verify before retrying anything that changes data.`
    )
    this.name = 'ConnectorTimeoutError'
    this.seconds = seconds
  }
}

/**
 * A failure to reach the server at all, as opposed to the server answering
 * with an error (a JSON-RPC error, a sign-in or scope problem, a timeout).
 */
function isConnectionFailure(err) {
  if (
    err instanceof ConnectorRpcError ||
    err instanceof ConnectorAuthError ||
    err instanceof ConnectorScopeError ||
    err instanceof ConnectorTimeoutError
  ) {
    return false
  }
  if (typeof err?.status === 'number' && err.status >= 500) return true
  const code = String(err?.code || err?.cause?.code || '')
  if (/^(ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE)/.test(code)) {
    return true
  }
  return /fetch failed|socket hang up|network|ECONN|ENOTFOUND|timed out|McpClient closed|SSE connection failed|HTTP 5\d\d/i.test(
    String(err?.message || '')
  )
}

const READ_RESULT_SPEC = {
  name: READ_RESULT_TOOL,
  description:
    'Read more of a connector tool result that was too long to show at once. Pass the result id and the page number the earlier result named.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The result id.' },
      page: { type: 'integer', description: 'Page number, starting at 1.' },
    },
    required: ['id', 'page'],
  },
}

export const CONNECTOR_SEARCH_SPEC = {
  name: CONNECTOR_SEARCH_TOOL,
  description:
    'Loads connector tools so you can call them. Connector tools (names starting with mcp__) are listed by name only: their parameters are not loaded, and calling one before it is loaded fails. Query forms: "select:<name>[,<name>...]" loads exact tools by their full names; keywords search the tool names, titles and descriptions, and a term prefixed with + must match (for example "+calendar create"). max_results caps how many keyword matches load (default 5). Loaded tools stay callable for the rest of this run.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'select:<name>[,<name>...] for exact tools, or keywords with optional +required terms.',
      },
      max_results: {
        type: 'integer',
        description: 'Most keyword matches to load, 1 to 50. Default 5.',
      },
    },
    required: ['query'],
  },
}

/** Whether a tool name belongs to connectors: an MCP tool, or one of the two helpers. */
export function isConnectorToolName(name) {
  return (
    typeof name === 'string' &&
    (name === READ_RESULT_TOOL ||
      name === CONNECTOR_SEARCH_TOOL ||
      /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/.test(name))
  )
}

function notLoadedMessage(name) {
  return `Connector tool ${name} is not loaded yet, so its parameters are not known and it was not run. Load it first with ${CONNECTOR_SEARCH_TOOL} and query "select:${name}", then call it.`
}

function scoreTerm(fields, term) {
  if (fields.parts.includes(term)) return 10
  if (fields.name.includes(term)) return 5
  if (fields.title.includes(term)) return 4
  if (fields.description.includes(term)) return 2
  return 0
}

export class ConnectorSession {
  /**
   * @param {Array<{ connector, credentials, accessToken }>} entries
   * @param {object} [options]
   * @param {Array<{ id, name, status, message }>} [options.unavailable]
   *   connectors the user picked that could not be used this run
   * @param {string} [options.toolSearch] see connectorToolSearchMode
   * @param {string|number} [options.toolTimeoutSeconds] when the connector
   *   sets none
   */
  constructor(
    entries = [],
    {
      signal = null,
      contextWindow = null,
      unavailable = [],
      toolSearch = 'auto',
      toolTimeoutSeconds,
    } = {}
  ) {
    this.signal = signal
    this.contextWindow = positiveNumber(contextWindow) ?? DEFAULT_CONTEXT_TOKENS
    this.pageChars = resultPageChars(contextWindow)
    this.defaultTimeoutSeconds = timeoutSecondsFrom(toolTimeoutSeconds)
    this.connectors = [] // what the prompt describes, see _addConnector
    this.unavailable = Array.isArray(unavailable) ? [...unavailable] : []
    this.clients = new Map() // connectorId -> McpClient
    this.toolMap = new Map() // sessionToolName -> entry
    this.loadedTools = new Set() // session tool names whose schemas were loaded
    this.results = new Map() // result id -> full text
    this.nextResultId = 1
    this.deferred = false
    this._serverKeys = new Set()
    for (const entry of entries) this._addConnector(entry)
    this.deferred = this._shouldDefer(toolSearch)
  }

  _addConnector({ connector, credentials, accessToken }) {
    const connId = connector._id.toString()
    const client = new McpClient({
      url: connector.url,
      transport: connector.transport,
      headers: credentials?.headers || {},
      accessToken,
    })
    this.clients.set(connId, client)

    const serverKey = uniqueName(
      // Runs of `_` collapse so `__` only ever separates server from tool
      (
        sanitizeName(connector.name, 'mcp')
          .replace(/_+/g, '_')
          .replace(/^_+|_+$/g, '') || 'mcp'
      ).slice(
        0,
        MAX_SERVER_KEY
      ),
      this._serverKeys,
      [connId.slice(-6)]
    )
    this._serverKeys.add(serverKey)

    const view = {
      id: connId,
      name: connector.name,
      prefix: `mcp__${serverKey}__`,
      instructions: capText(
        String(connector.server?.instructions || '').trim(),
        MAX_INSTRUCTIONS_CHARS,
        INSTRUCTIONS_MARKER
      ),
      serverTitle: connector.server?.title || null,
      serverVersion: connector.server?.version || null,
      tools: [],
    }
    this.connectors.push(view)

    for (const tool of Array.isArray(connector.tools) ? connector.tools : []) {
      if (!tool.name) continue
      const permission = toolPermission(connector, tool.name)
      if (permission === 'block') continue
      const toolKey = sanitizeName(tool.name, `tool_${shortHash(tool.name)}`)
      const name = uniqueName(
        `${view.prefix}${toolKey}`,
        this.toolMap,
        [shortHash(tool.name)]
      )
      const flat = flattenJsonSchema(tool.inputSchema || {})
      const { schema, renamed } = providerSafeParameters(flat)
      const entry = {
        connector,
        connectorId: connId,
        originalName: tool.name,
        tool,
        client,
        schema,
        originalSchema: flat,
        renamed,
        parameters: undefined,
      }
      this.toolMap.set(name, entry)
      const toolView = {
        name,
        title: tool.title || tool.name,
        summary: toolSummary(tool.description, tool.title || tool.name),
        readOnly: toolHint(tool, 'readOnly'),
        destructive: toolHint(tool, 'destructive'),
        openWorld: toolHint(tool, 'openWorld'),
        permission,
      }
      entry.view = toolView
      view.tools.push(toolView)
    }
  }

  _toolSpec(name, entry, limit) {
    entry.parameters ??= sanitizeToolSchema(entry.schema)
    return {
      name,
      description: capText(
        descriptionOf(entry.tool, entry.originalName),
        limit
      ),
      parameters: entry.parameters,
    }
  }

  _shouldDefer(value) {
    if (this.toolMap.size === 0) return false
    const { mode, percent } = connectorToolSearchMode(value)
    if (mode === 'off') return false
    if (mode === 'always') return true
    let chars = 0
    for (const [name, entry] of this.toolMap) {
      chars += JSON.stringify(
        this._toolSpec(name, entry, MAX_DESCRIPTION_CHARS)
      ).length
    }
    return chars / 4 >= (this.contextWindow * percent) / 100
  }

  /**
   * The tool specs to send with the next request. Deferred: the search tool,
   * the read-back tool, then the loaded tools in the order they were loaded,
   * appended so the prompt cache prefix stays the same. Otherwise every tool.
   */
  specs() {
    const specs = []
    if (this.deferred) {
      specs.push(CONNECTOR_SEARCH_SPEC, READ_RESULT_SPEC)
      for (const name of this.loadedTools) {
        specs.push(this._toolSpec(name, this.toolMap.get(name), MAX_LOADED_DESCRIPTION_CHARS))
      }
      return specs
    }
    for (const [name, entry] of this.toolMap) {
      specs.push(this._toolSpec(name, entry, MAX_DESCRIPTION_CHARS))
    }
    if (specs.length) specs.push(READ_RESULT_SPEC)
    return specs
  }

  /**
   * Every tool the session offers, sent or deferred, for the context
   * dashboard. `name` is the session's name (mcp__server__tool), `originalName`
   * the connector's own, `server` the connector's display name, `spec` the
   * spec as specs() would send it, and `deferred` whether
   * it is held back this request.
   */
  catalog() {
    const limit = this.deferred
      ? MAX_LOADED_DESCRIPTION_CHARS
      : MAX_DESCRIPTION_CHARS
    return [...this.toolMap].map(([name, entry]) => ({
      name,
      originalName: entry.originalName,
      server: entry.connector?.name || 'connector',
      spec: this._toolSpec(name, entry, limit),
      deferred: this.deferred && !this.loadedTools.has(name),
    }))
  }

  /** Same as specs(); kept for the callers that predate deferral. */
  getToolSpecs() {
    return this.specs()
  }

  has(name) {
    if (this.toolMap.has(name)) return true
    if (name === READ_RESULT_TOOL) return this.toolMap.size > 0
    return name === CONNECTOR_SEARCH_TOOL && this.deferred
  }

  describe(name) {
    const entry = this.toolMap.get(name)
    if (!entry) return null
    return {
      id: entry.connectorId,
      name: entry.connector.name,
      tool: entry.originalName,
      title: entry.tool.title || entry.tool.name,
      description: entry.tool.description,
      permission: toolPermission(entry.connector, entry.originalName),
      readOnly: toolHint(entry.tool, 'readOnly'),
      destructive: toolHint(entry.tool, 'destructive'),
      openWorld: toolHint(entry.tool, 'openWorld'),
    }
  }

  /** The search tool: loads the matches and says so. */
  _search(args = {}) {
    const query = typeof args?.query === 'string' ? args.query.trim() : ''
    if (!query) {
      return {
        error: `Pass a query: select:<name>[,<name>...] for exact tools, or keywords to search for.`,
      }
    }
    const limit = Math.min(
      SEARCH_MAX_RESULTS_LIMIT,
      Math.max(1, Math.trunc(Number(args.max_results)) || SEARCH_MAX_RESULTS)
    )

    let names
    const missing = []
    if (/^select:/i.test(query)) {
      names = []
      for (const raw of query.slice('select:'.length).split(',')) {
        const name = raw.trim()
        if (!name) continue
        if (this.toolMap.has(name)) {
          if (!names.includes(name)) names.push(name)
        } else {
          missing.push(name)
        }
      }
    } else {
      names = this._keywordMatches(query, limit)
    }

    const lines = []
    for (const name of names) {
      this.loadedTools.add(name)
      lines.push(
        JSON.stringify(
          this._toolSpec(name, this.toolMap.get(name), MAX_LOADED_DESCRIPTION_CHARS)
        )
      )
    }
    for (const name of missing) {
      lines.push(`No connector tool is named "${name}". Use a full name from the connector tool list.`)
    }
    if (names.length === 0) {
      lines.push(`No connector tools matched "${query}".`)
    } else {
      lines.push('These tools are now callable.')
    }
    return { result: lines.join('\n') }
  }

  _keywordMatches(query, limit) {
    const required = []
    const optional = []
    for (const term of query.toLowerCase().split(/\s+/)) {
      if (!term) continue
      if (term.startsWith('+')) {
        if (term.length > 1) required.push(term.slice(1))
      } else {
        optional.push(term)
      }
    }
    const terms = [...required, ...optional]
    if (terms.length === 0) return []

    const scored = []
    for (const [name, entry] of this.toolMap) {
      const fields = {
        name: name.toLowerCase(),
        parts: name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
        title: String(entry.tool.title || '').toLowerCase(),
        description: String(entry.tool.description || '').toLowerCase(),
      }
      if (!required.every(term => scoreTerm(fields, term) > 0)) continue
      const score = terms.reduce((sum, term) => sum + scoreTerm(fields, term), 0)
      if (score > 0) scored.push({ name, score })
    }
    // Stable sort: equal scores keep the order the server listed them in
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit).map(({ name }) => name)
  }

  _page(id, page) {
    const text = this.results.get(id)
    if (text === undefined) return { error: `No connector result ${id}` }
    const pages = Math.max(1, Math.ceil(text.length / this.pageChars))
    const n = Math.min(Math.max(1, Math.trunc(Number(page)) || 1), pages)
    const body = text.slice((n - 1) * this.pageChars, n * this.pageChars)
    const footer =
      n < pages
        ? `[Page ${n} of ${pages} of result ${id}. To read the next page, call ${READ_RESULT_TOOL} with {"id": "${id}", "page": ${n + 1}}.]`
        : `[Page ${n} of ${pages} of result ${id}: the end.]`
    return { result: `${body}\n\n${footer}` }
  }

  _restoreArgs(entry, args) {
    const restored = {}
    for (const [key, value] of Object.entries(args || {})) {
      restored[entry.renamed[key] || key] = value
    }
    // Back to the server's own types (an enum sent as a string, say)
    return coerceToolArgs(restored, entry.originalSchema)
  }

  /** Runs the call, failing with the timeout message if the server is silent. */
  async _callTool(entry, args, { signal, timeoutSeconds }) {
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (signal) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', abort, { once: true })
    }
    let timer = null
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        // Reject before aborting, so the timeout is the error that wins
        reject(
          new ConnectorTimeoutError(
            entry.connector.name,
            entry.originalName,
            timeoutSeconds
          )
        )
        controller.abort()
      }, Math.min(timeoutSeconds, MAX_TIMER_SECONDS) * 1000)
    })
    try {
      return await Promise.race([
        entry.client.callTool(entry.originalName, args, {
          signal: controller.signal,
          inputSchema: entry.tool.inputSchema,
        }),
        deadline,
      ])
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', abort)
    }
  }

  /** A result as the model gets it: a page, or an error. */
  _toolResult(rawResult, entry) {
    let text = contentText(rawResult, entry.connector.name)
    if (text.length > MAX_RESULT_CHARS) {
      text = capText(text, MAX_RESULT_CHARS, '\n\n[Result truncated: the server sent more text than is kept.]')
    }
    if (rawResult?.isError) {
      const message = text.trim()
        ? text
        : 'The connector tool reported an error with no message.'
      return {
        error: capText(message, this.pageChars, '\n\n[Error text truncated.]'),
        mcpError: true,
      }
    }
    if (text.length <= this.pageChars) return { result: text, isError: false }

    if (this.results.size >= MAX_STORED_RESULTS) {
      this.results.delete(this.results.keys().next().value)
    }
    const id = `r${this.nextResultId++}`
    this.results.set(id, text)
    const pages = Math.ceil(text.length / this.pageChars)
    const header = `[Result ${id}: ${text.length.toLocaleString('en-US')} characters in ${pages} pages. Showing page 1 of ${pages}. Read the rest page by page with ${READ_RESULT_TOOL}. If this server provides pagination or filtering parameters, prefer narrowing the query over reading every page.]`
    return {
      result: `${header}\n\n${this._page(id, 1).result}`,
      isError: false,
    }
  }

  async execute(name, args = {}, { signal } = {}) {
    if (name === READ_RESULT_TOOL) return this._page(args?.id, args?.page)
    if (name === CONNECTOR_SEARCH_TOOL && this.deferred) {
      return this._search(args || {})
    }

    const entry = this.toolMap.get(name)
    if (!entry) return { error: `Unknown connector tool: ${name}` }
    if (toolPermission(entry.connector, entry.originalName) === 'block') {
      return { error: `Tool ${name} is blocked by user permission.` }
    }
    if (this.deferred && !this.loadedTools.has(name)) {
      return { error: notLoadedMessage(name) }
    }

    const timeoutSeconds =
      positiveNumber(entry.connector.timeoutSeconds) ?? this.defaultTimeoutSeconds
    const callArgs = this._restoreArgs(entry, args)
    const doCall = () =>
      this._callTool(entry, callArgs, {
        signal: signal || this.signal,
        timeoutSeconds,
      })

    try {
      let rawResult
      try {
        rawResult = await doCall()
      } catch (err) {
        if (
          err instanceof ConnectorAuthError &&
          entry.connector.oauth?.hasRefreshToken
        ) {
          try {
            entry.client.accessToken = await McpOAuth.refreshTokens({
              connector: entry.connector,
            })
          } catch {
            throw err
          }
          rawResult = await doCall()
        } else {
          throw err
        }
      }

      ConnectorModel.updateOne(
        { _id: entry.connector._id },
        { $set: { lastUsedAt: new Date() } }
      )
        .exec()
        .catch(() => {})

      return this._toolResult(rawResult, entry)
    } catch (err) {
      if (err instanceof ConnectorScopeError) {
        return {
          error: `${entry.connector.name} needs more permissions${err.scope ? ` (${err.scope})` : ''} for this tool. Ask the user to sign in to the connector again in Settings → AI Features → Connectors, then retry.`,
        }
      }
      if (err instanceof ConnectorAuthError) {
        return {
          error: `${entry.connector.name} is signed out. Ask the user to sign in again in Settings → AI Features → Connectors.`,
        }
      }
      if (err instanceof ConnectorTimeoutError) return { error: err.message }
      if (err instanceof ConnectorRpcError) {
        return { error: err.message || 'The connector returned an error.' }
      }
      if (isConnectionFailure(err)) {
        const reason = capText(String(err?.message || err?.code || 'no response'), 200, '…')
        return {
          error: `Could not reach the ${entry.connector.name} connector (${reason}). Tell the user it may be down, or continue without it.`,
        }
      }
      return { error: err.message || 'Tool execution failed' }
    }
  }

  async allowAlways(name) {
    const entry = this.toolMap.get(name)
    if (!entry) return
    const key = permissionKeyFor(entry.originalName)
    entry.connector.toolPermissions = {
      ...(entry.connector.toolPermissions || {}),
      [key]: 'allow',
    }
    if (entry.view) entry.view.permission = 'allow'
    await ConnectorModel.updateOne(
      { _id: entry.connector._id },
      { $set: { [`toolPermissions.${key}`]: 'allow' } }
    ).exec()
  }

  async close() {
    for (const client of this.clients.values()) {
      await client.close().catch(() => {})
    }
    this.clients.clear()
    this.toolMap.clear()
    this.loadedTools.clear()
    this.results.clear()
    this.deferred = false
  }
}

/**
 * The connectors' tools the model has not loaded yet, one line each, grouped
 * by connector, for the system prompt. Empty when nothing is deferred.
 */
export function deferredToolCatalog(session) {
  if (!session?.deferred) return ''
  const blocks = []
  for (const connector of session.connectors) {
    const pending = connector.tools.filter(
      tool => !session.loadedTools.has(tool.name)
    )
    if (pending.length === 0) continue
    blocks.push(
      [
        `${connector.name}:`,
        ...pending.map(tool =>
          tool.summary ? `- ${tool.name} — ${tool.summary}` : `- ${tool.name}`
        ),
      ].join('\n')
    )
  }
  return blocks.join('\n')
}

async function sessionEntry(connector) {
  const credentials = await loadCredentials(connector._id)
  const accessToken = await McpOAuth.currentAccessToken({
    connector,
    credentials,
  })
  return { connector, credentials, accessToken }
}

/** What the user can see of a connector this run, when it cannot be used. */
function unavailableView(doc) {
  const id = doc._id.toString()
  const name = doc.name
  if (doc.status === 'needs_auth') {
    return {
      id,
      name,
      status: 'needs_auth',
      message: `${name} needs the user to sign in again in Settings → AI Features → Connectors. Its tools are not available in this chat.`,
    }
  }
  if (doc.status === 'disconnected') {
    return {
      id,
      name,
      status: 'disconnected',
      message: `${name} is disconnected. Its tools are not available in this chat.`,
    }
  }
  if (doc.status === 'pending') {
    return {
      id,
      name,
      status: 'error',
      message: `${name} has not connected yet. Its tools are not available in this chat.`,
    }
  }
  const reason = doc.lastError?.message
  return {
    id,
    name,
    status: 'error',
    message: `${name} could not be reached${reason ? ` (${reason})` : ''}. Its tools are not available in this chat.`,
  }
}

export async function createConnectorSession({
  userId,
  connectorIds,
  signal,
  contextWindow,
  toolSearch,
  toolTimeoutSeconds,
} = {}) {
  const options = { signal, contextWindow, toolSearch, toolTimeoutSeconds }
  if (!userId) return new ConnectorSession([], options)

  const query = { user_id: userId, enabled: true }
  if (Array.isArray(connectorIds)) {
    if (connectorIds.length === 0) return new ConnectorSession([], options)
    query._id = { $in: connectorIds }
  }

  const docs = await ConnectorModel.find(query).exec()
  const usable = docs.filter(doc => doc.status === 'connected')
  const unavailable = docs
    .filter(doc => doc.status !== 'connected')
    .map(unavailableView)
  const entries = await Promise.all(usable.map(sessionEntry))
  return new ConnectorSession(entries, { ...options, unavailable })
}

export default { ConnectorSession, createConnectorSession }
