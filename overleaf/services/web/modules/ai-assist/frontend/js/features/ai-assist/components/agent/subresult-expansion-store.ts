const PREFIX = 'ai-assist:expand:'
const memoryFallback = new Map<string, string>()

/**
 * Persistent store for user fold/unfold intent of one activity line.
 *
 * Every line starts folded and only a user click changes it. Keys are built
 * from transcript positions (`a3-subresults-1`), which repeat across chats,
 * regenerations and rewinds, so each saved choice also records a signature of
 * the content it was made on. A choice is only honoured when the signature
 * still matches; a new line that happens to reuse the key stays folded.
 */
function readRaw(key: string): string | null {
  const fullKey = PREFIX + key
  try {
    const val = window.sessionStorage.getItem(fullKey)
    if (val !== null) return val
  } catch {}
  return memoryFallback.get(fullKey) ?? null
}

export const subresultExpansionStore = {
  /** The user's saved choice for this line, or null when they made none. */
  read(key: string, signature: string): boolean | null {
    if (!signature) return null
    const raw = readRaw(key)
    if (!raw) return null
    try {
      const saved = JSON.parse(raw)
      if (
        typeof saved?.s === 'string' &&
        typeof saved.v === 'boolean' &&
        sameContent(saved.s, signature)
      ) {
        return saved.v
      }
    } catch {}
    return null
  },
  write(key: string, value: boolean, signature: string) {
    if (!signature) return
    const fullKey = PREFIX + key
    const val = JSON.stringify({ v: value, s: signature })
    memoryFallback.set(fullKey, val)
    try {
      window.sessionStorage.setItem(fullKey, val)
    } catch {}
  },
  clear() {
    memoryFallback.clear()
    try {
      const keysToRemove: string[] = []
      for (let i = 0; i < window.sessionStorage.length; i++) {
        const k = window.sessionStorage.key(i)
        if (k && k.startsWith(PREFIX)) keysToRemove.push(k)
      }
      for (const k of keysToRemove) window.sessionStorage.removeItem(k)
    } catch {}
  },
}

/**
 * Streaming only appends, so a line clicked mid-stream is recognised once its
 * text has grown: one signature extending the other counts as the same line.
 */
function sameContent(saved: string, current: string): boolean {
  return saved.startsWith(current) || current.startsWith(saved)
}

/** Signature of a thinking block: its opening text. */
export function thinkingSignature(thinking: string): string {
  return thinking ? `think:${thinking.slice(0, 64)}` : ''
}

/** Signature of a tool call: its id, closed so one id never prefixes another. */
export function toolCallSignature(call: { id?: string; name?: string }): string {
  return call?.id ? `tool:${call.name ?? ''}:${call.id};` : ''
}
