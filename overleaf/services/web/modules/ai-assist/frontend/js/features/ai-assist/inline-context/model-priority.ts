import { DEFAULT_BASE_URLS, ProviderSettings } from '../providers/types'

/**
 * Ghost-text completion goes before the background language check when both
 * talk to one server. A self-hosted model or gateway may generate one reply
 * at a time: the check of a whole file on opening sends batch after batch,
 * and a completion queued behind them shows nothing before the author types
 * on. So, on such a server, the check sends no new batch while a completion
 * is under way or while the author writes with Automatic on. A batch already
 * sent is never cut off: it finishes, and the next one waits.
 * The providers' own APIs answer requests side by side: nothing waits there.
 *
 * The two features only meet here; either works without the other.
 */

/** How long after the author's last keystroke the check holds back: Automatic's longest pause, and a little more. */
export const WRITING_HOLD_MS = 2500

type Listener = (endpoint: string) => void

const claims = new Map<string, number>()
const releaseListeners = new Set<Listener>()
let lastWrite = -Infinity

const PARALLEL_ENDPOINTS = new Set(
  Object.entries(DEFAULT_BASE_URLS)
    .filter(([type]) => type !== 'ollama')
    .map(([, url]) => normalise(url))
)

function normalise(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase()
}

/** Where a model's requests go; null for a provider API that never makes them wait. */
export function sharedEndpoint(settings: ProviderSettings): string | null {
  const endpoint = normalise(settings.baseUrl || DEFAULT_BASE_URLS[settings.type] || '')
  return endpoint && !PARALLEL_ENDPOINTS.has(endpoint) ? endpoint : null
}

/** A completion request starts on `settings`; call the result once it ends. */
export function claimModel(settings: ProviderSettings): () => void {
  const endpoint = sharedEndpoint(settings)
  if (!endpoint) return () => {}
  claims.set(endpoint, (claims.get(endpoint) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const left = (claims.get(endpoint) ?? 1) - 1
    if (left > 0) claims.set(endpoint, left)
    else claims.delete(endpoint)
    for (const listener of [...releaseListeners]) listener(endpoint)
  }
}

/** The author typed with Automatic on: a completion may follow. */
export function noteWriting(now = Date.now()) {
  lastWrite = now
}

/**
 * How long the language check should wait before sending on `settings`:
 * 0 to go now, Infinity until a completion ends (`onModelReleased`).
 */
export function backgroundHold(settings: ProviderSettings, now = Date.now()): number {
  const endpoint = sharedEndpoint(settings)
  if (!endpoint) return 0
  if (claims.has(endpoint)) return Infinity
  return Math.max(0, lastWrite + WRITING_HOLD_MS - now)
}

/** Called with the endpoint whenever a completion there ends; returns the unsubscribe. */
export function onModelReleased(listener: Listener): () => void {
  releaseListeners.add(listener)
  return () => {
    releaseListeners.delete(listener)
  }
}

/** For tests. */
export function resetModelPriority() {
  claims.clear()
  lastWrite = -Infinity
}
