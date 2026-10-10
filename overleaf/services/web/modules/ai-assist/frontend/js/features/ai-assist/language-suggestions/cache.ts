import customLocalStorage from '@/infrastructure/local-storage'
import type { MaskedEdit } from './edits'
import type { KeyContext } from './model-choice'
import { PROMPT_VERSION } from './prompt'
import { normalizeForCheck } from './semantic'

/** A sentence's checked edits ([] = clean) and those rejected this session. */
export type CacheEntry = {
  edits: MaskedEdit[]
  rejected: MaskedEdit[]
  /** The masked text the edits were made for, when it has any. */
  text?: string
  /** The neighbours' words where it was checked, one per place it stands (semantic.ts); absent: any. */
  contexts?: string[]
}

export const CACHE_SIZE = 5000
/** Checked sentences kept in this browser across reloads (with the edits dismissed on them), newest first kept. */
export const PERSISTED_SIZE = 2000
export const PERSIST_KEY = 'ai-assist:language-suggestions:checked'
/** Results arrive in bursts; they are written together. */
export const PERSIST_DELAY_MS = 2000

/** What a browser keeps: each sentence's result and the edits dismissed on it. */
type PersistedEntry = [string, MaskedEdit[], string | null, string[] | null, MaskedEdit[]?]
type Persisted = { v: 2; entries: PersistedEntry[] }

export type CacheStorage = {
  getItem: (key: string) => any
  setItem: (key: string, value: any) => void
}

export function cacheKey(context: KeyContext, hash: string): string {
  return `${context.slot}:${context.model}|${context.variant}|${context.style ? 'style' : 'grammar'}|${PROMPT_VERSION}|${hash}`
}

export function sameEdit(a: MaskedEdit, b: MaskedEdit): boolean {
  return a.from === b.from && a.to === b.to && a.insert === b.insert
}

/** The same words replaced the same way, wherever they are. */
export function sameChange(a: MaskedEdit, b: MaskedEdit): boolean {
  return (
    a.insert === b.insert &&
    normalizeForCheck(a.original).text === normalizeForCheck(b.original).text
  )
}

/**
 * In memory, least recently used entries forgotten first. With `storage`,
 * also kept in this browser: a reload, another tab or reopening the project
 * shows what was checked before without asking the model again.
 */
export class SuggestionCache {
  private entries = new Map<string, CacheEntry>()
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly max = CACHE_SIZE,
    private readonly storage: CacheStorage | null = null
  ) {
    this.load()
  }

  private load() {
    if (!this.storage) return
    let stored: Persisted | null = null
    try {
      stored = this.storage.getItem(PERSIST_KEY)
    } catch {
      return
    }
    if (stored?.v !== 2 || !Array.isArray(stored.entries)) return
    for (const entry of stored.entries) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Array.isArray(entry[1])) {
        continue
      }
      const [key, edits, text, contexts, rejected] = entry
      this.entries.set(key, {
        edits,
        rejected: Array.isArray(rejected) ? rejected : [],
        ...(typeof text === 'string' ? { text } : {}),
        ...(Array.isArray(contexts) ? { contexts } : {}),
      })
    }
  }

  private persistSoon() {
    if (!this.storage || this.saveTimer) return
    this.saveTimer = setTimeout(() => this.persistNow(), PERSIST_DELAY_MS)
  }

  /** Writes the most recently used entries now. */
  persistNow() {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    if (!this.storage) return
    const entries: Persisted['entries'] = []
    for (const [key, entry] of this.entries) {
      // The text is needed only to move edits; a clean sentence has none
      const text = entry.edits.length > 0 ? (entry.text ?? null) : null
      const contexts = entry.contexts ?? null
      entries.push(
        entry.rejected.length > 0
          ? [key, entry.edits, text, contexts, entry.rejected]
          : [key, entry.edits, text, contexts]
      )
    }
    try {
      this.storage.setItem(PERSIST_KEY, {
        v: 2,
        entries: entries.slice(-PERSISTED_SIZE),
      } satisfies Persisted)
    } catch {
      // Full or blocked: the cache still works for this tab
    }
  }

  get size(): number {
    return this.entries.size
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  get(key: string): CacheEntry | undefined {
    const entry = this.entries.get(key)
    if (entry) {
      this.entries.delete(key)
      this.entries.set(key, entry)
    }
    return entry
  }

  set(key: string, entry: CacheEntry) {
    this.entries.delete(key)
    this.entries.set(key, entry)
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    this.persistSoon()
  }

  /**
   * The entry's edits without those rejected this session. A rejection is
   * matched by what it changes, not where: the same sentence may sit in the
   * text with other spacing than when it was checked.
   */
  visible(key: string): MaskedEdit[] | undefined {
    const entry = this.get(key)
    return entry?.edits.filter(
      edit => !entry.rejected.some(rejected => sameChange(rejected, edit))
    )
  }

  reject(key: string, edits: MaskedEdit[]) {
    const entry = this.get(key)
    if (entry) this.set(key, { ...entry, rejected: [...entry.rejected, ...edits] })
  }

  clear() {
    this.entries.clear()
    this.persistSoon()
  }
}

/** One cache per tab, shared by every editor view, kept in this browser. */
export const suggestionCache = new SuggestionCache(CACHE_SIZE, customLocalStorage)

if (typeof window !== 'undefined') {
  // A save still waiting when the tab closes is written now
  window.addEventListener('pagehide', () => suggestionCache.persistNow())
}
