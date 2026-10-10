import customLocalStorage from '@/infrastructure/local-storage'
import {
  LANGUAGE_SUGGESTIONS_CHANGED_EVENT,
  LANGUAGE_SUGGESTIONS_KEY,
  saveComposerPreferences,
} from '../provider-store'

export type EnglishVariant = 'en-US' | 'en-GB'
export type ModelSlot = 'main' | 'fast'
/** Which suggestions are shown: corrections (orange), style (blue), or both. */
export type SuggestionTypes = 'all' | 'grammar' | 'style'
export type BlockedSuggestion = { from: string; to: string; at: number }

export type LanguageSuggestionsPreferences = {
  enabled: boolean
  englishVariant: EnglishVariant
  /** null: the fast model when one is set up, otherwise the main one. */
  model: ModelSlot | null
  /** Newest first. */
  blocked: BlockedSuggestion[]
  types: SuggestionTypes
}

export const MAX_BLOCKED = 500
export const MAX_BLOCKED_TEXT = 200
/** Fired on `window` to open the blocked-suggestions modal. */
export const OPEN_BLOCKED_SUGGESTIONS_EVENT = 'ai-assist:open-blocked-suggestions'

const VARIANTS: EnglishVariant[] = ['en-US', 'en-GB']
const SLOTS: ModelSlot[] = ['main', 'fast']
export const SUGGESTION_TYPES: SuggestionTypes[] = ['all', 'grammar', 'style']

/** The form a blocked pair is compared in. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function blockKey(from: string, to: string): string {
  return `${collapseWhitespace(from)}\u0000${collapseWhitespace(to)}`
}

function normalizeBlocked(raw: unknown): BlockedSuggestion[] {
  if (!Array.isArray(raw)) return []
  const valid: BlockedSuggestion[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    if (typeof entry.from !== 'string' || typeof entry.to !== 'string') continue
    const from = collapseWhitespace(entry.from)
    const to = collapseWhitespace(entry.to)
    if (!from && !to) continue
    if (from.length > MAX_BLOCKED_TEXT || to.length > MAX_BLOCKED_TEXT) continue
    const at =
      typeof entry.at === 'number' && Number.isFinite(entry.at) ? entry.at : 0
    valid.push({ from, to, at })
  }
  valid.sort((a, b) => b.at - a.at)
  const seen = new Set<string>()
  const blocked: BlockedSuggestion[] = []
  for (const entry of valid) {
    const key = blockKey(entry.from, entry.to)
    if (seen.has(key)) continue
    seen.add(key)
    blocked.push(entry)
    if (blocked.length === MAX_BLOCKED) break
  }
  return blocked
}

export function normalizeLanguageSuggestionsPreferences(
  raw: any
): LanguageSuggestionsPreferences {
  return {
    enabled: raw?.enabled === true,
    englishVariant: VARIANTS.includes(raw?.englishVariant)
      ? raw.englishVariant
      : 'en-US',
    model: SLOTS.includes(raw?.model) ? raw.model : null,
    blocked: normalizeBlocked(raw?.blocked),
    // `style: false` was the earlier way to turn style suggestions off
    types: SUGGESTION_TYPES.includes(raw?.types)
      ? raw.types
      : raw?.style === false
        ? 'grammar'
        : 'all',
  }
}

/** Whether checks ask for style rewording: for All and Style. */
export function wantsStyle(preferences: { types: SuggestionTypes }): boolean {
  return preferences.types !== 'grammar'
}

let memo: LanguageSuggestionsPreferences | null = null
let blockedKeys: { source: BlockedSuggestion[]; keys: Set<string> } | null =
  null

/** Drops the parsed copy; the next read parses this browser's copy again. */
export function forgetLanguageSuggestionsPreferences() {
  memo = null
  blockedKeys = null
}

if (typeof window !== 'undefined') {
  // Another tab, or the account's copy loaded into this browser
  window.addEventListener('storage', forgetLanguageSuggestionsPreferences)
  window.addEventListener(
    LANGUAGE_SUGGESTIONS_CHANGED_EVENT,
    forgetLanguageSuggestionsPreferences
  )
}

/** Parsed once and kept: the editor reads it on every redraw. */
export function readLanguageSuggestionsPreferences(): LanguageSuggestionsPreferences {
  if (!memo) {
    memo = normalizeLanguageSuggestionsPreferences(
      customLocalStorage.getItem(LANGUAGE_SUGGESTIONS_KEY)
    )
  }
  return memo
}

/** Stores in this browser, saves to the account, and tells the page. */
export function writeLanguageSuggestionsPreferences(
  preferences: LanguageSuggestionsPreferences
): LanguageSuggestionsPreferences {
  const normalized = normalizeLanguageSuggestionsPreferences(preferences)
  customLocalStorage.setItem(LANGUAGE_SUGGESTIONS_KEY, normalized)
  saveComposerPreferences()
  window.dispatchEvent(new CustomEvent(LANGUAGE_SUGGESTIONS_CHANGED_EVENT))
  memo = normalized
  return normalized
}

export function updateLanguageSuggestionsPreferences(
  patch: Partial<LanguageSuggestionsPreferences>
): LanguageSuggestionsPreferences {
  return writeLanguageSuggestionsPreferences({
    ...readLanguageSuggestionsPreferences(),
    ...patch,
  })
}

export function blockSuggestion(
  from: string,
  to: string,
  now = Date.now()
): LanguageSuggestionsPreferences {
  const current = readLanguageSuggestionsPreferences()
  return writeLanguageSuggestionsPreferences({
    ...current,
    blocked: [{ from, to, at: now }, ...current.blocked],
  })
}

export function unblockSuggestion(
  from: string,
  to: string
): LanguageSuggestionsPreferences {
  const key = blockKey(from, to)
  const current = readLanguageSuggestionsPreferences()
  return writeLanguageSuggestionsPreferences({
    ...current,
    blocked: current.blocked.filter(
      entry => blockKey(entry.from, entry.to) !== key
    ),
  })
}

/** Whether the exact old→new pair is on the blocked list. */
export function isBlocked(from: string, to: string): boolean {
  const { blocked } = readLanguageSuggestionsPreferences()
  if (!blockedKeys || blockedKeys.source !== blocked) {
    blockedKeys = {
      source: blocked,
      keys: new Set(blocked.map(entry => blockKey(entry.from, entry.to))),
    }
  }
  return blockedKeys.keys.has(blockKey(from, to))
}
