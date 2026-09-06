import { CODES, OverleafApiError, codeForStatus, sanitiseMessage } from './errors.js'

const API_PREFIX = '/api/v0/mcp'
const DEFAULT_TIMEOUT_MS = 30000

/**
 * Thin fetch wrapper over the web service's per-user MCP API.
 *
 * It holds no credential of its own: every call takes the caller's token and
 * forwards it as a bearer header. All authorization happens in `web`.
 */
export class OverleafClient {
  constructor({ baseUrl, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
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

  async #send(token, url, init) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      return await this.fetchImpl(url, {
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
    } finally {
      clearTimeout(timer)
    }
  }

  async #throwForResponse(response) {
    let code = codeForStatus(response.status)
    let message = `the Overleaf API returned status ${response.status}`
    try {
      const contentType = response.headers.get('content-type') || ''
      if (contentType.includes('application/json')) {
        const body = await response.json()
        if (body && typeof body === 'object') {
          if (typeof body.code === 'string') code = body.code
          if (typeof body.message === 'string') message = body.message
        }
      }
    } catch {
      // A malformed body must not mask the status-derived code above.
    }
    throw new OverleafApiError(code, sanitiseMessage(message, this.baseUrl), response.status)
  }

  /**
   * @param {string} token the caller's olp_ token
   * @param {'GET'|'POST'|'PATCH'} method
   * @param {string} path path below /api/v0/mcp, e.g. '/projects'
   * @param {{ query?: object, body?: object }} [options]
   * @returns {Promise<object>} the parsed JSON body
   */
  async request(token, method, path, { query, body } = {}) {
    this.#assertToken(token)
    const init = { method, headers: { Accept: 'application/json' } }
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    const response = await this.#send(token, this.#url(path, query), init)
    if (!response.ok) await this.#throwForResponse(response)
    return await response.json()
  }

  /**
   * Fetch a binary endpoint (e.g. PDF or ZIP archive) as base64.
   *
   * @param {string} token
   * @param {string} path
   * @param {object} [queryOrOptions]
   * @returns {Promise<{ contentType: string, base64: string }>}
   */
  async requestBinary(token, path, queryOrOptions = {}) {
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

    const response = await this.#send(token, this.#url(path, query), init)
    if (!response.ok) await this.#throwForResponse(response)
    const buffer = Buffer.from(await response.arrayBuffer())
    return {
      contentType:
        response.headers.get('content-type') || 'application/octet-stream',
      base64: buffer.toString('base64'),
    }
  }

  get(token, path, query) {
    return this.request(token, 'GET', path, { query })
  }

  post(token, path, body) {
    return this.request(token, 'POST', path, { body })
  }

  patch(token, path, body) {
    return this.request(token, 'PATCH', path, { body })
  }
}
