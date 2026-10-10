/** Two Shift+Space requests never start closer together than this; Automatic has no gap. */
export const MIN_REQUEST_GAP_MS = 1000
export const CACHE_SIZE = 32
const KEY_PREFIX_CHARS = 500
const KEY_SUFFIX_CHARS = 200

/** Same model, same kind, same text around the cursor: same completion. */
export function cacheKey(
  model: string,
  kind: string,
  prefix: string,
  suffix: string
): string {
  return [
    model,
    kind,
    prefix.slice(-KEY_PREFIX_CHARS),
    suffix.slice(0, KEY_SUFFIX_CHARS),
  ].join('\u0000')
}

/** The last completions shown, least recently used first out. */
export class CompletionCache {
  private entries = new Map<string, string>()

  get(key: string): string | undefined {
    const text = this.entries.get(key)
    if (text !== undefined) {
      this.entries.delete(key)
      this.entries.set(key, text)
    }
    return text
  }

  set(key: string, text: string) {
    this.entries.delete(key)
    this.entries.set(key, text)
    if (this.entries.size > CACHE_SIZE) {
      this.entries.delete(this.entries.keys().next().value!)
    }
  }

  clear() {
    this.entries.clear()
  }
}

/**
 * Spaces request starts at least `MIN_REQUEST_GAP_MS` apart. A trigger
 * inside the gap waits for its end; a newer one replaces it.
 */
export class RateGate {
  private last = -Infinity
  private timer: ReturnType<typeof setTimeout> | null = null

  schedule(run: () => void) {
    this.cancel()
    const wait = this.last + MIN_REQUEST_GAP_MS - Date.now()
    if (wait <= 0) {
      this.last = Date.now()
      run()
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      this.last = Date.now()
      run()
    }, wait)
  }

  /** A trigger is waiting for the gap to end. */
  get waiting(): boolean {
    return this.timer !== null
  }

  cancel() {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  reset() {
    this.cancel()
    this.last = -Infinity
  }
}

/** One of each per page: there is one editor. */
export const completionGate = new RateGate()
export const completionCache = new CompletionCache()

/** For tests: no waiting trigger, no recent start, nothing cached. */
export function resetCompletionRate() {
  completionGate.reset()
  completionCache.clear()
}
