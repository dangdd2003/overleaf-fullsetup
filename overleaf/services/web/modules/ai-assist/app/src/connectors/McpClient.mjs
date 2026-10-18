import { StringDecoder } from 'node:string_decoder'
import { connectorFetch } from './ConnectorFetch.mjs'

export const MODERN_ERA = 'modern'
export const LEGACY_ERA = 'legacy'
export const SSE_ERA = 'sse'

export const MODERN_PROTOCOL_VERSION = '2026-07-28'
export const LEGACY_PROTOCOL_VERSION = '2025-11-25'

export function encodeMcpName(name) {
  if (!name) return ''
  if (/^[\x20-\x7E]+$/.test(name)) {
    return name
  }
  return `base64:${Buffer.from(String(name), 'utf8').toString('base64')}`
}

export function parseWwwAuthenticate(header) {
  if (!header || typeof header !== 'string') return {}
  const result = { raw: header }
  const regex = /([a-zA-Z0-9_-]+)=(?:"([^"]*)"|([^,\s]+))/g
  let match
  while ((match = regex.exec(header)) !== null) {
    const key = match[1].toLowerCase()
    const val = match[2] !== undefined ? match[2] : match[3]
    if (key === 'resource_metadata') result.resourceMetadata = val
    else if (key === 'scope') result.scope = val
    else if (key === 'error') result.error = val
    else if (key === 'error_description') result.errorDescription = val
    else if (key === 'realm') result.realm = val
    result[key] = val
  }
  return result
}

export class ConnectorAuthError extends Error {
  constructor(message, { status = 401, wwwAuthenticate = null } = {}) {
    super(message || 'Authentication required')
    this.name = 'ConnectorAuthError'
    this.status = status
    this.wwwAuthenticate = wwwAuthenticate
    this.authDetails = parseWwwAuthenticate(wwwAuthenticate)
  }
}

export class ConnectorScopeError extends Error {
  constructor(
    message,
    { status = 403, wwwAuthenticate = null, scope = null } = {}
  ) {
    super(message || 'Insufficient scope')
    this.name = 'ConnectorScopeError'
    this.status = status
    this.wwwAuthenticate = wwwAuthenticate
    this.scope = scope
  }
}

export class ConnectorRpcError extends Error {
  constructor(message, code, data, status) {
    super(message || `RPC Error (${code})`)
    this.name = 'ConnectorRpcError'
    this.code = code
    this.data = data
    this.status = status
  }
}

/** Server text (instructions) is kept only when the server sent a string. */
function textOf(value) {
  return typeof value === 'string' ? value : ''
}

function getHeader(headers, name) {
  if (!headers) return null
  if (typeof headers.get === 'function') {
    const direct = headers.get(name)
    if (direct !== undefined && direct !== null) return String(direct)
    const lower = headers.get(name.toLowerCase())
    if (lower !== undefined && lower !== null) return String(lower)
  }
  if (typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === name.toLowerCase()) return String(v)
    }
  }
  return null
}

async function parseResponsePayload(res) {
  if (typeof res.json === 'function') {
    try {
      const parsed = await res.json()
      if (parsed !== undefined && parsed !== null) return parsed
    } catch {}
  }
  if (typeof res.text === 'function') {
    try {
      const text = await res.text()
      if (!text || typeof text !== 'string' || !text.trim()) return null
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
    } catch {}
  }
  return null
}

// One SSE event larger than this means a broken or hostile server.
const MAX_SSE_EVENT_CHARS = 16 * 1024 * 1024
// Bounds on what a server may list: pages of tools, and tools in all
const MAX_TOOL_PAGES = 100
const MAX_TOOLS = 2000

async function parseSseStream(bodyStream, onMessage) {
  // Event state outlives a chunk: a `data:` line and the blank line that
  // ends its event often arrive in different reads. The decoder keeps a
  // multi-byte character split across chunks whole.
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  let eventName = 'message'
  const dataParts = []
  let eventChars = 0
  for await (const chunk of bodyStream) {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
    if (buffer.length + eventChars > MAX_SSE_EVENT_CHARS) {
      throw new Error('SSE event exceeds the size limit')
    }
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line === '') {
        if (dataParts.length > 0) {
          onMessage({ event: eventName, data: dataParts.join('\n') })
          dataParts.length = 0
          eventChars = 0
        }
        eventName = 'message'
      } else if (line.startsWith('event:')) {
        eventName = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        const data = line.slice(5).trimStart()
        dataParts.push(data)
        eventChars += data.length
      }
    }
  }
}

/**
 * A response the server delivers later on its SSE stream. Waits as long as
 * the server takes unless the connector sets a timeout; Stop still ends it.
 */
function waitForResponse(promise, { timeoutMs, signal } = {}) {
  const waits = [promise]
  let timer = null
  if (timeoutMs > 0) {
    waits.push(
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`No response after ${timeoutMs / 1000}s`)),
          timeoutMs
        )
      })
    )
  }
  if (signal) {
    waits.push(
      new Promise((_, reject) => {
        if (signal.aborted) return reject(new Error('Aborted'))
        signal.addEventListener('abort', () => reject(new Error('Aborted')), {
          once: true,
        })
      })
    )
  }
  return Promise.race(waits).finally(() => clearTimeout(timer))
}

export class McpClient {
  constructor(options = {}) {
    this.url = options.url
    this.transport = options.transport || 'auto' // 'auto' | 'streamable-http' | 'sse'
    this.customHeaders = options.headers || {}
    this.accessToken = options.accessToken || null
    this.fetch = options.fetch || connectorFetch

    this.sessionId = null
    this.protocolVersion = null
    this.era = null
    this.serverInfo = null
    this.capabilities = null
    this.instructions = null

    this.postEndpoint = null
    this.sseAbortController = null
    this.nextRequestId = 1
    this._pendingRequests = new Map()
    this._connected = false
  }

  async connect({ signal, timeoutMs } = {}) {
    if (this._connected) return

    if (this.transport === 'sse') {
      await this._connectSse({ signal, timeoutMs })
      this._connected = true
      return
    }

    // Modern Streamable HTTP (2026-07-28)
    try {
      this.protocolVersion = MODERN_PROTOCOL_VERSION
      const result = await this._sendHttpRpc(
        'server/discover',
        {
          _meta: { client: { name: 'overleaf-ai-assist', version: '1.0' } },
        },
        { signal, timeoutMs }
      )
      this.era = MODERN_ERA
      this.serverInfo = result?.serverInfo || result?.server || result || {}
      this.capabilities = result?.capabilities || {}
      this.instructions = textOf(result?.instructions)
      this._connected = true
      return
    } catch (err) {
      if (
        err instanceof ConnectorAuthError ||
        err instanceof ConnectorScopeError
      ) {
        throw err
      }
      const isUnsupported =
        err.code === -32022 ||
        err.code === -32601 ||
        err.status === 400 ||
        err.status === 404 ||
        err.status === 405
      if (!isUnsupported) {
        throw err
      }
    }

    // Legacy Streamable HTTP (2025-11-25)
    try {
      this.protocolVersion = LEGACY_PROTOCOL_VERSION
      const result = await this._sendHttpRpc(
        'initialize',
        {
          protocolVersion: LEGACY_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'overleaf-ai-assist', version: '1.0' },
        },
        { signal, timeoutMs }
      )
      this.era = LEGACY_ERA
      this.serverInfo = result?.serverInfo || result || {}
      this.capabilities = result?.capabilities || {}
      this.instructions = textOf(result?.instructions)
      await this._sendNotification('notifications/initialized').catch(() => {})
      this._connected = true
      return
    } catch (err) {
      if (
        err instanceof ConnectorAuthError ||
        err instanceof ConnectorScopeError
      ) {
        throw err
      }
      const isLegacyUnsupported =
        err.code === -32601 ||
        err.status === 400 ||
        err.status === 404 ||
        err.status === 405
      if (!isLegacyUnsupported || this.transport === 'streamable-http') {
        throw err
      }
    }

    // Legacy HTTP+SSE fallback
    await this._connectSse({ signal, timeoutMs })
    this._connected = true
  }

  async _connectSse({ signal, timeoutMs } = {}) {
    this.era = SSE_ERA
    this.protocolVersion = LEGACY_PROTOCOL_VERSION

    const reqHeaders = {
      Accept: 'text/event-stream',
      ...this.customHeaders,
    }
    if (this.accessToken) {
      reqHeaders['Authorization'] = `Bearer ${this.accessToken}`
    }

    this.sseAbortController = new AbortController()
    const abortSignal = signal
      ? AbortSignal.any([signal, this.sseAbortController.signal])
      : this.sseAbortController.signal

    const sseRes = await this.fetch(this.url, {
      method: 'GET',
      headers: reqHeaders,
      signal: abortSignal,
      timeoutMs,
    })

    if (sseRes.status === 401) {
      throw new ConnectorAuthError('Authentication required', {
        status: 401,
        wwwAuthenticate: getHeader(sseRes.headers, 'www-authenticate'),
      })
    }

    if (sseRes.status >= 400) {
      throw new Error(`SSE connection failed with HTTP ${sseRes.status}`)
    }

    // Read SSE messages in background
    let endpointResolve
    let endpointReject
    const endpointPromise = new Promise((resolve, reject) => {
      endpointResolve = resolve
      endpointReject = reject
    })

    parseSseStream(sseRes.body, ({ event, data }) => {
      if (event === 'endpoint') {
        const endpoint = new URL(data.trim(), this.url)
        // The bearer token and the connector's headers go to this address, so
        // a server may name only its own origin, never another host
        if (endpoint.origin !== new URL(this.url).origin) {
          endpointReject(
            new Error('The SSE endpoint is on another server, so it was not used')
          )
          return
        }
        this.postEndpoint = endpoint.href
        endpointResolve(this.postEndpoint)
        return
      }

      if (event === 'message') {
        try {
          const msg = JSON.parse(data)
          if (msg.id !== undefined && this._pendingRequests.has(msg.id)) {
            const { resolve, reject } = this._pendingRequests.get(msg.id)
            this._pendingRequests.delete(msg.id)
            if (msg.error) {
              reject(
                new ConnectorRpcError(
                  msg.error.message,
                  msg.error.code,
                  msg.error.data
                )
              )
            } else {
              resolve(msg.result)
            }
          }
        } catch {}
      }
    }).catch(() => {})

    // Wait for endpoint event with timeout
    let endpointTimer
    const postEndpoint = await Promise.race([
      endpointPromise,
      new Promise((_, reject) => {
        endpointTimer = setTimeout(
          () => reject(new Error('Timed out waiting for SSE endpoint event')),
          timeoutMs || 10000
        )
      }),
    ]).finally(() => clearTimeout(endpointTimer))

    this.postEndpoint = postEndpoint

    // Initialize via postEndpoint
    const initResult = await this._sendHttpRpc(
      'initialize',
      {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'overleaf-ai-assist', version: '1.0' },
      },
      { signal: abortSignal, timeoutMs }
    )

    this.serverInfo = initResult?.serverInfo || initResult || {}
    this.capabilities = initResult?.capabilities || {}
    this.instructions = textOf(initResult?.instructions)
    await this._sendNotification('notifications/initialized').catch(() => {})
  }

  async _sendNotification(method, params = {}) {
    const payload = {
      jsonrpc: '2.0',
      method,
      params,
    }
    const reqHeaders = {
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': this.protocolVersion || LEGACY_PROTOCOL_VERSION,
      'Mcp-Method': method,
      ...this.customHeaders,
    }
    if (this.accessToken) {
      reqHeaders['Authorization'] = `Bearer ${this.accessToken}`
    }
    if (this.sessionId) {
      reqHeaders['Mcp-Session-Id'] = this.sessionId
    }

    const postUrl = this.postEndpoint || this.url
    await this.fetch(postUrl, {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify(payload),
    }).catch(() => {})
  }

  async _sendHttpRpc(method, params = {}, { name, signal, timeoutMs } = {}) {
    const id = this.nextRequestId++
    const payload = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    }

    const reqHeaders = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': this.protocolVersion || MODERN_PROTOCOL_VERSION,
      'Mcp-Method': method,
      ...this.customHeaders,
    }
    if (name) {
      reqHeaders['Mcp-Name'] = encodeMcpName(name)
    }
    if (this.accessToken) {
      reqHeaders['Authorization'] = `Bearer ${this.accessToken}`
    }
    if (this.sessionId) {
      reqHeaders['Mcp-Session-Id'] = this.sessionId
    }

    const postUrl = this.postEndpoint || this.url

    // Set up pending promise in case response comes via SSE stream
    let pendingEntry
    const ssePromise = new Promise((resolve, reject) => {
      pendingEntry = { resolve, reject }
      this._pendingRequests.set(id, pendingEntry)
    })
    // Only awaited on the 202 path; close() may reject it on any other
    ssePromise.catch(() => {})

    try {
      const res = await this.fetch(postUrl, {
        method: 'POST',
        headers: reqHeaders,
        body: JSON.stringify(payload),
        signal,
        timeoutMs,
      })

      if (res.status === 401) {
        this._pendingRequests.delete(id)
        throw new ConnectorAuthError('Authentication required', {
          status: 401,
          wwwAuthenticate: getHeader(res.headers, 'www-authenticate'),
        })
      }

      if (res.status === 403) {
        this._pendingRequests.delete(id)
        const wwwAuth = getHeader(res.headers, 'www-authenticate') || ''
        const text = (await parseResponsePayload(res)) || ''
        const textStr = typeof text === 'string' ? text : JSON.stringify(text)
        if (
          wwwAuth.includes('insufficient_scope') ||
          textStr.includes('insufficient_scope')
        ) {
          throw new ConnectorScopeError('Insufficient scope', {
            status: 403,
            wwwAuthenticate: wwwAuth,
            scope: parseWwwAuthenticate(wwwAuth).scope || null,
          })
        }
        throw new Error(`Server returned HTTP 403: ${textStr}`)
      }

      if (res.status === 404 || res.status === 405) {
        this._pendingRequests.delete(id)
        const err = new Error(`HTTP ${res.status}`)
        err.status = res.status
        throw err
      }

      if (res.status >= 400) {
        this._pendingRequests.delete(id)
        let errorObj
        try {
          const json = await parseResponsePayload(res)
          if (json?.error) errorObj = json.error
        } catch {}
        if (errorObj) {
          throw new ConnectorRpcError(
            errorObj.message,
            errorObj.code,
            errorObj.data,
            res.status
          )
        }
        throw new Error(`HTTP ${res.status}`)
      }

      const sessId =
        getHeader(res.headers, 'mcp-session-id') ||
        getHeader(res.headers, 'x-session-id')
      if (sessId) {
        this.sessionId = sessId
      }

      // If accepted for background delivery on SSE stream
      if (res.status === 202 || res.status === 204) {
        return await waitForResponse(ssePromise, { timeoutMs, signal })
      }

      const contentType = String(
        getHeader(res.headers, 'content-type') || ''
      ).toLowerCase()
      if (contentType.includes('text/event-stream')) {
        return await new Promise((resolve, reject) => {
          let resolved = false
          parseSseStream(res.body, ({ event: _evt, data }) => {
            try {
              const parsed = JSON.parse(data)
              if (parsed.id === id && !resolved) {
                resolved = true
                this._pendingRequests.delete(id)
                // Answered: stop reading so a server holding the stream
                // open does not pin the socket for the rest of the run
                setImmediate(() => res.body?.destroy?.())
                if (parsed.error) {
                  reject(
                    new ConnectorRpcError(
                      parsed.error.message,
                      parsed.error.code,
                      parsed.error.data,
                      res.status
                    )
                  )
                } else {
                  resolve(parsed.result)
                }
              }
            } catch {}
          })
            .then(() => {
              if (!resolved) {
                this._pendingRequests.delete(id)
                reject(new Error('No matching response in SSE stream'))
              }
            })
            .catch(err => {
              this._pendingRequests.delete(id)
              if (!resolved) reject(err)
            })
        })
      }

      const json = await parseResponsePayload(res)
      this._pendingRequests.delete(id)
      if (!json) return null

      if (json.error) {
        throw new ConnectorRpcError(
          json.error.message,
          json.error.code,
          json.error.data,
          res.status
        )
      }
      return json.result
    } catch (err) {
      this._pendingRequests.delete(id)
      throw err
    }
  }

  async _sendRpc(method, params = {}, options = {}) {
    return this._sendHttpRpc(method, params, options)
  }

  async listTools({ signal, timeoutMs } = {}) {
    await this.connect({ signal, timeoutMs })

    // A server that keeps handing out new cursors would otherwise page forever
    const tools = []
    let cursor = undefined
    const seenCursors = new Set()
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const params = cursor ? { cursor } : {}
      const result = await this._sendRpc('tools/list', params, {
        signal,
        timeoutMs,
      })
      if (Array.isArray(result?.tools)) {
        for (const tool of result.tools) {
          if (tools.length >= MAX_TOOLS) break
          if (tool && typeof tool === 'object') tools.push(tool)
        }
      }
      cursor = result?.nextCursor
      if (!cursor || seenCursors.has(cursor) || tools.length >= MAX_TOOLS) {
        break
      }
      seenCursors.add(cursor)
    }

    return tools.map(t => ({
      name: t.name,
      title: t.title || t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || {},
      annotations: t.annotations || {},
    }))
  }

  async callTool(name, args = {}, { signal, timeoutMs } = {}) {
    await this.connect({ signal, timeoutMs })
    return this._sendRpc(
      'tools/call',
      { name, arguments: args || {} },
      { name, signal, timeoutMs }
    )
  }

  async close() {
    this._connected = false
    if (this.sseAbortController) {
      try {
        this.sseAbortController.abort()
      } catch {}
      this.sseAbortController = null
    }
    for (const { reject } of this._pendingRequests.values()) {
      reject(new Error('McpClient closed'))
    }
    this._pendingRequests.clear()
  }
}

export default McpClient
