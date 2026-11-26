import { useCallback, useEffect, useState } from 'react'
import { LANGUAGE_SUGGESTIONS_CHANGED_EVENT } from '../../provider-store'
import {
  LanguageSuggestionsPreferences,
  readLanguageSuggestionsPreferences,
  updateLanguageSuggestionsPreferences,
} from '../../language-suggestions/preferences'

const DEFAULT_PREFERENCES: LanguageSuggestionsPreferences = {
  enabled: false,
  englishVariant: 'en-US',
  model: null,
  blocked: [],
  types: 'all',
}

/** The preferences, kept current when anything on the page changes them. */
export function useLanguageSuggestionsPreferences(
  enabled: boolean = true
): [
  LanguageSuggestionsPreferences,
  (patch: Partial<LanguageSuggestionsPreferences>) => void,
] {
  const [preferences, setPreferences] = useState(() =>
    enabled ? readLanguageSuggestionsPreferences() : DEFAULT_PREFERENCES
  )

  useEffect(() => {
    if (!enabled) return
    setPreferences(readLanguageSuggestionsPreferences())
    const onChange = () => setPreferences(readLanguageSuggestionsPreferences())
    window.addEventListener(LANGUAGE_SUGGESTIONS_CHANGED_EVENT, onChange)
    return () =>
      window.removeEventListener(LANGUAGE_SUGGESTIONS_CHANGED_EVENT, onChange)
  }, [enabled])

  const update = useCallback(
    (patch: Partial<LanguageSuggestionsPreferences>) =>
      setPreferences(updateLanguageSuggestionsPreferences(patch)),
    []
  )

  return [preferences, update]
}
