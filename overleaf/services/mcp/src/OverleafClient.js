import { CODES, OverleafApiError, codeForStatus, sanitiseMessage } from './errors.js'

const API_PREFIX = '/api/v0/mcp'
const DEFAULT_TIMEOUT_MS = 30000
/** Largest binary output (PDF, zip, download) returned to a tool, in bytes. */
const MAX_BINARY_BYTES = 64 * 1024 * 1024
const MIB = 1024 * 1024

function tooLarge(totalBytes, maxBytes) {
  const maxMb = maxBytes / MIB
  const size = totalBytes == null ? `over ${maxMb} MB` : `${Math.ceil(totalBytes / MIB)} MB > ${maxMb} MB`
  return new OverleafApiError(
    CODES.OUTPUT_TOO_LARGE,
    `output too large (${size}); download it from Overleaf directly`,
    413
  )
}

/**
 * Read a response body as base64, stopping once it passes maxBytes.
 *
 * The cap is checked as each chunk arrives, so an oversized body is never
 * held in memory whole. A Content-Length already past the cap is refused
 * before any of the body is read.
 *
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
async function readBase64Capped(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel?.().catch(() => {})
    throw tooLarge(declared, maxBytes)
  }
  if (!response.body) {
    if (typeof response.arrayBuffer === 'function') {
      return base64FromArrayBuffer(response, maxBytes)
    }
    return ''
  }

  if (typeof response.body.getReader === 'function') {
    const reader = response.body.getReader()
    const encoder = createBase64Encoder()
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw tooLarge(null, maxBytes)
      }
      encoder.write(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
    }
    return encoder.end()
  }

  if (typeof response.body[Symbol.asyncIterator] === 'function') {
    const encoder = createBase64Encoder()
    let total = 0
    for await (const chunk of response.body) {
      total += chunk.byteLength || chunk.length
      if (total > maxBytes) {
        await response.body.destroy?.()
        throw tooLarge(null, maxBytes)
      }
      encoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    return encoder.end()
  }

  if (typeof response.arrayBuffer === 'function') {
    return base64FromArrayBuffer(response, maxBytes)
  }

  return ''
}

/**
 * Base64-encode a byte stream one chunk at a time. Base64 works in groups of
 * three bytes, so up to two trailing bytes that do not complete a group wait
 * for the next chunk. The output equals encoding all the bytes in one call,
 * and the chunks are never joined into a single buffer first.
 *
 * @returns {{ write: (chunk: Buffer) => void, end: () => string }}
 */
function createBase64Encoder() {
  const parts = []
  let carry = Buffer.alloc(0)
  return {
    write(chunk) {
      let bytes = chunk
      if (carry.length) {
        const take = Math.min(3 - carry.length, chunk.length)
        carry = Buffer.concat([carry, chunk.subarray(0, take)])
        bytes = chunk.subarray(take)
        if (carry.length < 3) return
        parts.push(carry.toString('base64'))
        carry = Buffer.alloc(0)
      }
      const whole = bytes.length - (bytes.length % 3)
      if (whole) parts.push(bytes.toString('base64', 0, whole))
      carry = Buffer.from(bytes.subarray(whole))
    },
    end() {
      if (carry.length) parts.push(carry.toString('base64'))
      return parts.join('')
    },
  }
}

/** Read a whole body through arrayBuffer(), for responses that expose no stream. */
async function base64FromArrayBuffer(response, maxBytes) {
  const buf = Buffer.from(await response.arrayBuffer())
  if (buf.byteLength > maxBytes) throw tooLarge(buf.byteLength, maxBytes)
  return buf.toString('base64')
}

/**
 * Read the download name out of a Content-Disposition header.
 *
 * web names every archive it serves in this header, so it stays the single
 * source of truth for what an export is called; callers only have to pass the
 * name on. Anything unparseable yields undefined and the caller falls back.
 *
 * @param {string|null} header
 * @returns {string|undefined}
 */
function filenameFromDisposition(header) {
  if (!header) return undefined
  const encoded = /filename\*=\s*(?:UTF-8'')?([^;]+)/i.exec(header)
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, ''))
    } catch {
      // a malformed percent-escape is not worth failing the download over
    }
  }
  const plain = /filename=\s*"?([^";]+)"?/i.exec(header)
  return plain ? plain[1].trim() : undefined
}

/**
 * Thin fetch wrapper over the web service's per-user MCP API.
 *
 * It holds no credential of its own: every call takes the caller's token and
 * forwards it as a bearer header. All authorization happens in `web`.
 */
export class OverleafClient {
  constructor({
    baseUrl,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '')
    this.fetchImpl = fetchImpl
    this.timeoutMs = timeoutMs
  }

  #url(path, query) {
    const url = new URL(`${this.baseUrl}${API_PREFIX}${path}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  #assertToken(token) {
    if (!token) {
      throw new OverleafApiError(
        CODES.UNAUTHORIZED,
        'no Overleaf token was supplied with this request',
        401
      )
    }
  }

  /**
   * Sends the request and hands the response to `read`, all under one
   * deadline: a server that answers its headers and then stalls the body
   * is cut off too.
   */
  async #send(token, url, init, read, timeoutMs = this.timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      let response
      try {
        response = await this.fetchImpl(url, {
          ...init,
          signal: controller.signal,
          headers: { ...init.headers, Authorization: `Bearer ${token}` },
        })
      } catch (_err) {
        throw new OverleafApiError(
          CODES.UPSTREAM_ERROR,
          controller.signal.aborted
            ? 'the Overleaf API did not respond in time'
            : 'could not reach the Overleaf API',
          502
        )
      }
      if (!response.ok) await this.#throwForResponse(response)
      try {
        return await read(response)
      } catch (err) {
        if (err instanceof OverleafApiError) throw err
        throw new OverleafApiError(
          CODES.UPSTREAM_ERROR,
          controller.signal.aborted
            ? 'the Overleaf API did not respond in time'
            : 'could not read the Overleaf API response',
          502
        )
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async #throwForResponse(response) {
    let code = codeForStatus(response.status)
    let message = `the Overleaf API returned status ${response.status}`
    const extra = {}
    try {
      const contentType = response.headers.get('content-type') || ''
      if (contentType.includes('application/json')) {
        const body = await response.json()
        if (body && typeof body === 'object') {
          if (typeof body.code === 'string') code = body.code
          if (typeof body.message === 'string') message = body.message
          if (typeof body.hint === 'string') {
            extra.hint = sanitiseMessage(body.hint, this.baseUrl)
          }
          if (body.details && typeof body.details === 'object') {
            extra.details = body.details
          }
        }
      }
    } catch {
      // A malformed body must not mask the status-derived code above.
    } finally {
      // An unread body keeps its connection checked out until it is released.
      if (!response.bodyUsed) await response.body?.cancel().catch(() => {})
    }
    throw new OverleafApiError(
      code,
      sanitiseMessage(message, this.baseUrl),
      response.status,
      extra
    )
  }

  /**
   * @param {string} token the caller's olp_ token
   * @param {'GET'|'POST'|'PATCH'} method
   * @param {string} path path below /api/v0/mcp, e.g. '/projects'
   * @param {{ query?: object, body?: object, timeoutMs?: number }} [options]
   *   timeoutMs overrides the client's default deadline for this call
   * @returns {Promise<object>} the parsed JSON body
   */
  async request(token, method, path, { query, body, timeoutMs } = {}) {
    this.#assertToken(token)
    const init = { method, headers: { Accept: 'application/json' } }
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    return await this.#send(
      token,
      this.#url(path, query),
      init,
      response => response.json(),
      timeoutMs
    )
  }

  /**
   * Fetch a binary endpoint (e.g. PDF or ZIP archive) as base64.
   *
   * @param {string} token
   * @param {string} path
   * @param {object} [queryOrOptions]
   * @returns {Promise<{ contentType: string, filename: string|undefined, base64: string }>}
   */
  async requestBinary(token, path, queryOrOptions = {}, { maxBytes = MAX_BINARY_BYTES } = {}) {
    this.#assertToken(token)
    let query
    let method = 'GET'
    let body
    const headers = {}

    if (
      queryOrOptions &&
      typeof queryOrOptions === 'object' &&
      ('query' in queryOrOptions ||
        'method' in queryOrOptions ||
        'body' in queryOrOptions ||
        'headers' in queryOrOptions)
    ) {
      query = queryOrOptions.query
      if (queryOrOptions.method) method = queryOrOptions.method
      if (queryOrOptions.body !== undefined) {
        body = JSON.stringify(queryOrOptions.body)
        headers['Content-Type'] = 'application/json'
      }
      if (queryOrOptions.headers) Object.assign(headers, queryOrOptions.headers)
    } else {
      query = queryOrOptions
    }

    if (!headers.Accept) {
      headers.Accept = '*/*'
    }

    const init = { method, headers }
    if (body !== undefined) init.body = body

    return await this.#send(
      token,
      this.#url(path, query),
      init,
      async response => ({
        contentType:
          response.headers.get('content-type') || 'application/octet-stream',
        filename: filenameFromDisposition(
          response.headers.get('content-disposition')
        ),
        base64: await readBase64Capped(response, maxBytes),
      })
    )
  }

  get(token, path, query) {
    return this.request(token, 'GET', path, { query })
  }

  post(token, path, body, { timeoutMs } = {}) {
    return this.request(token, 'POST', path, { body, timeoutMs })
  }

  patch(token, path, body) {
    return this.request(token, 'PATCH', path, { body })
  }
}
