import Settings from '@overleaf/settings'
import { ProviderError } from '../../AiAssistProviders.mjs'
import { MAX_DOWNLOAD_BYTES, MAX_PDF_BYTES } from '../transport.mjs'
import { describeStatus, safeDecodeURI, webError } from '../util.mjs'

/**
 * HTTP client for the overleaf-browser sidecar (services/overleaf-browser).
 * Communicates with the sidecar over HTTP with Bearer token authentication.
 */

const RAW_TIMEOUT_MS = 25_000
const RENDER_TIMEOUT_MS = 60_000
const UNAVAILABLE_MS = 30_000

function cancelled() {
  return new ProviderError('Request was cancelled', { code: 'aborted' })
}

/**
 * A response body of at most `limit` bytes, read as it streams in, so a huge
 * page is cut on arrival instead of after it fills memory.
 */
async function readCapped(res, limit) {
  const reader = res.body?.getReader?.()
  if (!reader) {
    const whole = Buffer.from(await res.arrayBuffer())
    return whole.length > limit
      ? { body: whole.subarray(0, limit), cut: true }
      : { body: whole, cut: false }
  }
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (size + value.length > limit) {
      chunks.push(Buffer.from(value.subarray(0, limit - size)))
      await reader.cancel().catch(() => {})
      return { body: Buffer.concat(chunks), cut: true }
    }
    chunks.push(Buffer.from(value))
    size += value.length
  }
  return { body: Buffer.concat(chunks), cut: false }
}

export class BrowserRoute {
  constructor({
    baseUrl,
    token,
    concurrency = 2,
    fetchFn = fetch,
    now = () => Date.now(),
  } = {}) {
    this.baseUrl = baseUrl?.replace(/\/+$/, '')
    this.token = token
    this.concurrency = concurrency
    this.fetchFn = fetchFn
    this.now = now
    this.unavailableUntil = 0
  }

  available() {
    return (
      Boolean(this.baseUrl && this.token) && this.now() >= this.unavailableUntil
    )
  }

  markUnavailable() {
    this.unavailableUntil = this.now() + UNAVAILABLE_MS
  }

  async _request(path, targetUrl, { timeoutMs, signal } = {}) {
    if (!this.available()) {
      throw webError('the browser sidecar is unavailable', { kind: 'network' })
    }

    const stepSignal = AbortSignal.timeout(timeoutMs)
    const combined = signal ? AbortSignal.any([signal, stepSignal]) : stepSignal

    let res
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ url: targetUrl }),
        signal: combined,
      })
    } catch (err) {
      if (signal?.aborted) throw cancelled()
      this.markUnavailable()
      throw webError(
        `the browser sidecar could not be reached (${String(err?.message || err).split('\n')[0]})`,
        { kind: 'network' }
      )
    }

    if (!res.ok) {
      if ([429, 502, 503, 504].includes(res.status)) {
        if (res.status === 502 || res.status === 503) this.markUnavailable()
        throw webError(`browser sidecar returned HTTP ${res.status}`, {
          status: res.status,
          kind: 'network',
        })
      }
      if (res.status === 400 || res.status === 403) {
        throw webError(`browser sidecar refused request: HTTP ${res.status}`, {
          status: res.status,
          kind: 'content',
        })
      }
      throw webError(`browser sidecar error: HTTP ${res.status}`, {
        status: res.status,
        kind: 'network',
      })
    }

    const pageStatus = Number(res.headers.get('x-page-status') || 200)
    if (pageStatus >= 400) {
      const desc = describeStatus(pageStatus) || 'error'
      throw webError(`${targetUrl} returned HTTP ${pageStatus}: ${desc}`, {
        status: pageStatus,
        kind: pageStatus === 404 || pageStatus === 410 ? 'http' : 'network',
      })
    }

    const contentType =
      res.headers.get('content-type') || 'text/html; charset=utf-8'
    const { body, cut } = await readCapped(
      res,
      /pdf/i.test(contentType) ? MAX_PDF_BYTES : MAX_DOWNLOAD_BYTES
    )
    return {
      url: safeDecodeURI(res.headers.get('x-page-url') || targetUrl),
      contentType,
      body,
      truncated: cut || res.headers.get('x-page-truncated') === '1',
    }
  }

  async raw(url, { signal } = {}) {
    return this._request('/v1/raw', url, { timeoutMs: RAW_TIMEOUT_MS, signal })
  }

  async render(url, { signal } = {}) {
    return this._request('/v1/render', url, {
      timeoutMs: RENDER_TIMEOUT_MS,
      signal,
    })
  }
}

let shared = null

export function sharedBrowserRoute() {
  const config = Settings.aiAssist?.browser
  if (!config?.url || !config?.token) return null
  if (
    !shared ||
    shared.baseUrl !== config.url ||
    shared.token !== config.token
  ) {
    shared = new BrowserRoute({
      baseUrl: config.url,
      token: config.token,
      concurrency: config.concurrency ?? 2,
    })
  }
  return shared
}
