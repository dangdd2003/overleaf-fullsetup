import customSessionStorage from '@/infrastructure/session-storage'
import { WritingActionId } from './actions'
import { WritingWarning } from './generate'
import { EditUnit } from './apply'
import { RephraseSettings } from './prompt'
import { GeneratorId } from '../texgpt/generators'
import { TexGptVersion } from '../components/texgpt/texgpt-result'

export type WritingToolHistoryVersion = {
  text: string
  warnings: WritingWarning[]
  unit: EditUnit
}

export type WritingToolHistoryEntry = {
  kind: 'writing-tool'
  originalText: string
  action: WritingActionId
  targetLanguage?: string
  history: {
    versions: WritingToolHistoryVersion[]
    index: number
  }
  synonyms: string[]
  rephraseSettings?: RephraseSettings
  prompt?: string
  durationMs: number | null
  kept?: Array<[number, number[]]>
  timestamp: number
}

export type TexGptHistoryEntry = {
  kind: 'texgpt'
  originalText: string
  run: {
    title: string
    prompt: string
    generator: GeneratorId | null
  }
  versions: TexGptVersion[]
  index: number
  choice: number
  durationMs: number | null
  showDiff: boolean
  addPackages: boolean
  timestamp: number
}

export type SelectionHistoryEntry = WritingToolHistoryEntry | TexGptHistoryEntry

export function normalizeSelectionKey(text: string): string {
  return text.trim()
}

const MAX_CACHE_ENTRIES = 50
const SESSION_STORAGE_KEY = 'ai-assist:selection-history'

const memoryCache = new Map<string, SelectionHistoryEntry>()
let initialized = false
let menuRequested = false

/** Signals that the user clicked 'back' in a generation card and wants the menu open. */
export function signalMenuRequested() {
  menuRequested = true
}

/** Consumes the menu requested signal. */
export function consumeMenuRequested(): boolean {
  const value = menuRequested
  menuRequested = false
  return value
}

function initFromSessionStorage() {
  if (initialized) return
  initialized = true
  try {
    const raw = customSessionStorage.getItem(SESSION_STORAGE_KEY)
    if (raw && typeof raw === 'object' && Array.isArray((raw as any).entries)) {
      for (const [key, entry] of (raw as any).entries) {
        if (typeof key === 'string' && entry && typeof entry === 'object') {
          memoryCache.set(key, entry as SelectionHistoryEntry)
        }
      }
    }
  } catch {
    // sessionStorage might be restricted or unavailable; memoryCache remains primary
  }
}

function persistToSessionStorage() {
  try {
    const entries = Array.from(memoryCache.entries())
    customSessionStorage.setItem(SESSION_STORAGE_KEY, { entries })
  } catch {
    // Graceful fallback if storage fails
  }
}

export function saveSelectionHistory(entry: SelectionHistoryEntry): void {
  initFromSessionStorage()
  const key = normalizeSelectionKey(entry.originalText)
  if (!key) return
  memoryCache.delete(key)
  memoryCache.set(key, entry)
  while (memoryCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = memoryCache.keys().next().value
    if (oldestKey !== undefined) {
      memoryCache.delete(oldestKey)
    } else {
      break
    }
  }
  persistToSessionStorage()
}

export function saveWritingToolHistory(entry: WritingToolHistoryEntry): void {
  saveSelectionHistory(entry)
}

export function saveTexGptHistory(entry: TexGptHistoryEntry): void {
  saveSelectionHistory(entry)
}

export function getSelectionHistory(text: string): SelectionHistoryEntry | null {
  initFromSessionStorage()
  const key = normalizeSelectionKey(text)
  if (!key) return null
  const entry = memoryCache.get(key)
  if (!entry) return null
  // Refresh recency
  memoryCache.delete(key)
  memoryCache.set(key, entry)
  return entry
}

export function getWritingToolHistory(
  text: string,
  action?: WritingActionId
): WritingToolHistoryEntry | null {
  const entry = getSelectionHistory(text)
  if (!entry || entry.kind !== 'writing-tool') return null
  if (action && entry.action !== action) return null
  return entry
}

export function getTexGptHistory(text: string): TexGptHistoryEntry | null {
  const entry = getSelectionHistory(text)
  if (!entry || entry.kind !== 'texgpt') return null
  return entry
}

export function hasSelectionHistory(text: string): boolean {
  initFromSessionStorage()
  const key = normalizeSelectionKey(text)
  return Boolean(key && memoryCache.has(key))
}

export function clearSelectionHistory(text?: string): void {
  initFromSessionStorage()
  if (text !== undefined) {
    const key = normalizeSelectionKey(text)
    if (key) {
      memoryCache.delete(key)
      persistToSessionStorage()
    }
  } else {
    memoryCache.clear()
    try {
      customSessionStorage.removeItem(SESSION_STORAGE_KEY)
    } catch {
      // ignore
    }
  }
}
