const memoryFallback = new Map<string, string>()

/**
 * Persistent store for user fold/unfold intent keyed by group ID or item ID.
 * This guarantees that when a user unfolds or folds an activity group or sub-activity line,
 * subsequent AI actions (new tool calls, chunk streams, UI re-renders, mode transitions)
 * never automatically flip or collapse the user's chosen expansion state.
 */
export const subresultExpansionStore = {
  get(key: string): boolean {
    if (typeof window === 'undefined' || !window.sessionStorage) {
      return memoryFallback.get(`ai-assist:expand:${key}`) === '1'
    }
    try {
      const val = window.sessionStorage.getItem(`ai-assist:expand:${key}`)
      if (val !== null) return val === '1'
      return memoryFallback.get(`ai-assist:expand:${key}`) === '1'
    } catch {
      return memoryFallback.get(`ai-assist:expand:${key}`) === '1'
    }
  },
  set(key: string, value: boolean) {
    const val = value ? '1' : '0'
    memoryFallback.set(`ai-assist:expand:${key}`, val)
    if (typeof window === 'undefined' || !window.sessionStorage) return
    try {
      window.sessionStorage.setItem(`ai-assist:expand:${key}`, val)
    } catch {}
  },
  has(key: string): boolean {
    if (typeof window === 'undefined' || !window.sessionStorage) {
      return memoryFallback.has(`ai-assist:expand:${key}`)
    }
    try {
      if (window.sessionStorage.getItem(`ai-assist:expand:${key}`) !== null) {
        return true
      }
      return memoryFallback.has(`ai-assist:expand:${key}`)
    } catch {
      return memoryFallback.has(`ai-assist:expand:${key}`)
    }
  },
  clear() {
    memoryFallback.clear()
    if (typeof window === 'undefined' || !window.sessionStorage) return
    try {
      const keysToRemove: string[] = []
      for (let i = 0; i < window.sessionStorage.length; i++) {
        const k = window.sessionStorage.key(i)
        if (k && k.startsWith('ai-assist:expand:')) {
          keysToRemove.push(k)
        }
      }
      for (const k of keysToRemove) {
        window.sessionStorage.removeItem(k)
      }
    } catch {}
  },
}
