import Settings from '@overleaf/settings'
import { ProviderError } from '../../AiAssistProviders.mjs'
import {
  MAX_DOWNLOAD_BYTES,
  MAX_PDF_BYTES,
  parseFetchUrl,
} from '../transport.mjs'
import { describeStatus, safeDecodeURI, webError } from '../util.mjs'

/**
 * HTTP client for the overleaf-browser sidecar (services/overleaf-browser).
 * Communicates with the sidecar over HTTP with Bearer token authentication.
 * While the sidecar is configured it is the only way Overleaf reaches a page
 * on its own: see fetchPage and fetchFile.
 */

const RAW_TIMEOUT_MS = 25_000
const RENDER_TIMEOUT_MS = 60_000
const UNAVAILABLE_MS = 30_000
/** A small file (a site icon) by /v1/fetch, which opens no browser page. */
const FILE_TIMEOUT_MS = 10_000
/**
 * Small-file fetches at once: the sidecar's places for them. With the page
 * reads, well under the 16 calls the gateway relay takes at once (it refuses
 * the rest outright).
 */
const FILE_CONCURRENCY = 8

function cancelled() {
  return new ProviderError('Request was cancelled', { code: 'aborted' })
}

/**
 * At most `size` requests at the sidecar at once, so a burst waits here, in
 * arrival order, instead of being refused there.
 */
export class SidecarGate {
  constructor(size = 2) {
    this.size = Math.max(1, Math.floor(Number(size)) || 1)
    this.busy = 0
    this.waiting = []
  }

  /** Resolves to the function that gives the place back. */
  acquire({ signal } = {}) {
    if (signal?.aborted) return Promise.reject(cancelled())
    if (this.busy < this.size) return Promise.resolve(this._take())
    return new Promise((resolve, reject) => {
      const entry = {}
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort)
        const index = this.waiting.indexOf(entry)
        if (index !== -1) this.waiting.splice(index, 1)
      }
      const onAbort = () => {
        cleanup()
        reject(cancelled())
      }
      entry.grant = () => {
        cleanup()
        resolve(this._take())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiting.push(entry)
    })
  }

  /** Takes a place; returns the function that gives it back. */
  _take() {
    this.busy++
    let released = false
    return () => {
      if (released) return
      released = true
      this.busy--
      if (this.busy < this.size) this.waiting[0]?.grant()
    }
  }
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
    this.gate = new SidecarGate(concurrency)
    this.fileGate = new SidecarGate(FILE_CONCURRENCY)
  }

  available() {
    return Boolean(this.baseUrl) && this.now() >= this.unavailableUntil
  }

  markUnavailable() {
    this.unavailableUntil = this.now() + UNAVAILABLE_MS
  }

  /** Refuses before asking the sidecar when it cannot be used. */
  _check() {
    if (!this.token) {
      throw webError(
        'the browser is enabled (AI_ASSIST_BROWSER_URL) but AI_ASSIST_BROWSER_TOKEN is not set, so no page can be read',
        { kind: 'network' }
      )
    }
    if (!this.available()) {
      throw webError('the browser sidecar is unavailable', { kind: 'network' })
    }
  }

  async _request(path, targetUrl, { timeoutMs, signal, maxBytes } = {}) {
    this._check()
    const release = await this.gate.acquire({ signal })
    try {
      return await this._send(path, targetUrl, { timeoutMs, signal, maxBytes })
    } finally {
      release()
    }
  }

  async _send(path, targetUrl, { timeoutMs, signal, maxBytes, extra = {} }) {
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
        body: JSON.stringify({ url: targetUrl, ...extra }),
        signal: combined,
      })
    } catch (err) {
      if (signal?.aborted) throw cancelled()
      // Out of time is a slow page, not a sidecar that is down
      if (stepSignal.aborted) {
        throw webError(
          `the browser did not answer within ${Math.round(timeoutMs / 1000)}s`,
          { kind: 'network' }
        )
      }
      this.markUnavailable()
      throw webError(
        `the browser sidecar could not be reached (${String(err?.message || err).split('\n')[0]})`,
        { kind: 'network' }
      )
    }

    if (!res.ok) {
      if ([429, 502, 503, 504].includes(res.status)) {
        // 502 is the sidecar reporting a page it could not load (app.mjs
        // answers err.status || 502), not the sidecar being down
        if (res.status === 503) this.markUnavailable()
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
      maxBytes ??
        (/pdf/i.test(contentType) ? MAX_PDF_BYTES : MAX_DOWNLOAD_BYTES)
    )
    return {
      status: pageStatus,
      url: safeDecodeURI(res.headers.get('x-page-url') || targetUrl),
      contentType,
      body,
      truncated: cut || res.headers.get('x-page-truncated') === '1',
    }
  }

  /**
   * fetchPublicUrl's contract (transport.mjs) through the sidecar's /v1/raw:
   * how every request Overleaf makes on its own goes out while the browser
   * is enabled. A private address is refused here, before the sidecar is
   * asked. Chrome sends its own headers, so `headers` and `impersonate` are
   * not used.
   */
  async fetchPage(
    rawUrl,
    { signal, maxBytes, timeoutMs = RAW_TIMEOUT_MS } = {}
  ) {
    const url = parseFetchUrl(rawUrl).toString()
    return this._request('/v1/raw', url, { timeoutMs, signal, maxBytes })
  }

  /**
   * fetchPage for a small file (a site icon) by /v1/fetch: plain HTTP through
   * the gateway's egress, with no browser page unless a bot check refuses
   * it (the sidecar then asks Chrome). It does not wait for the page reads'
   * places; small files have their own, here and in the sidecar. `head`
   * reads a page only up to its </head>.
   */
  async fetchFile(
    rawUrl,
    { signal, maxBytes, timeoutMs = FILE_TIMEOUT_MS, head = false } = {}
  ) {
    const url = parseFetchUrl(rawUrl).toString()
    this._check()
    const release = await this.fileGate.acquire({ signal })
    try {
      return await this._send('/v1/fetch', url, {
        timeoutMs,
        signal,
        maxBytes,
        extra: head ? { head: true } : {},
      })
    } finally {
      release()
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

/**
 * The sidecar client, whenever AI_ASSIST_BROWSER_URL is set. A missing token
 * does not turn the browser off: the route then refuses every request, so a
 * half-configured browser never lets Overleaf fetch pages directly.
 */
export function sharedBrowserRoute() {
  const config = Settings.aiAssist?.browser
  if (!config?.url) return null
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
