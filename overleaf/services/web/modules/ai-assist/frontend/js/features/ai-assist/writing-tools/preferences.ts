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

export const MAX_RECENT_LANGUAGES = 3

const LEVELS: RephraseLevel[] = ['low', 'medium', 'high']
const STYLES: RephraseStyle[] = ['scientific', 'concise', 'punchy']
const LENGTHS: RephraseLength[] = ['shorten', 'lengthen']

export function normalizeWritingToolsPreferences(
  raw: any
): WritingToolsPreferences {
  const rephrase = raw?.rephrase ?? {}
  return {
    recentLanguages: Array.isArray(raw?.recentLanguages)
      ? raw.recentLanguages
          .filter((language: unknown) => typeof language === 'string')
          .slice(0, MAX_RECENT_LANGUAGES)
      : [],
    rephrase: {
      level: LEVELS.includes(rephrase.level) ? rephrase.level : 'medium',
      style: STYLES.includes(rephrase.style) ? rephrase.style : null,
      length: LENGTHS.includes(rephrase.length) ? rephrase.length : null,
    },
    showDiff: raw?.showDiff !== false,
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
