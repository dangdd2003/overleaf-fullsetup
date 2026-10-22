import customLocalStorage from '@/infrastructure/local-storage'
import { saveComposerPreferences, WRITING_TOOLS_KEY } from '../provider-store'
import type { RephraseLength, RephraseLevel, RephraseStyle } from './prompt'

export type WritingToolsPreferences = {
  /** Most recent first. */
  recentLanguages: string[]
  rephrase: {
    level: RephraseLevel
    style: RephraseStyle | null
    length: RephraseLength | null
  }
  /** The card's diff toggle: diff (true) or the clean result (false). */
  showDiff: boolean
}

const MAX_RECENT_LANGUAGES = 3

const LEVELS: RephraseLevel[] = ['low', 'medium', 'high']
const STYLES: RephraseStyle[] = ['scientific', 'concise', 'punchy']
const LENGTHS: RephraseLength[] = ['shorten', 'lengthen']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function pick<T extends string>(options: T[], value: unknown): T | undefined {
  return options.find(option => option === value)
}

export function normalizeWritingToolsPreferences(
  raw: unknown
): WritingToolsPreferences {
  const data = isRecord(raw) ? raw : {}
  const rephrase = isRecord(data.rephrase) ? data.rephrase : {}
  return {
    recentLanguages: Array.isArray(data.recentLanguages)
      ? data.recentLanguages
          .filter(
            (language: unknown): language is string =>
              typeof language === 'string'
          )
          .slice(0, MAX_RECENT_LANGUAGES)
      : [],
    rephrase: {
      level: pick(LEVELS, rephrase.level) ?? 'medium',
      style: pick(STYLES, rephrase.style) ?? null,
      length: pick(LENGTHS, rephrase.length) ?? null,
    },
    showDiff: data.showDiff !== false,
  }
}

export function readWritingToolsPreferences(): WritingToolsPreferences {
  return normalizeWritingToolsPreferences(
    customLocalStorage.getItem(WRITING_TOOLS_KEY)
  )
}

/** Stores in this browser, then saves to the account with the other AI choices. */
export function writeWritingToolsPreferences(
  preferences: WritingToolsPreferences
) {
  customLocalStorage.setItem(WRITING_TOOLS_KEY, preferences)
  saveComposerPreferences()
}

/** Moves `language` to the top of the recent list and saves. */
export function rememberLanguage(language: string): WritingToolsPreferences {
  const current = readWritingToolsPreferences()
  const next = {
    ...current,
    recentLanguages: [
      language,
      ...current.recentLanguages.filter(l => l !== language),
    ].slice(0, MAX_RECENT_LANGUAGES),
  }
  writeWritingToolsPreferences(next)
  return next
}
