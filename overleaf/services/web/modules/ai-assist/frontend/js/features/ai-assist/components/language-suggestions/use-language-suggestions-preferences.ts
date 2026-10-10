import { useCallback, useEffect, useState } from 'react'
import { LANGUAGE_SUGGESTIONS_CHANGED_EVENT } from '../../provider-store'
import {
  LanguageSuggestionsPreferences,
  readLanguageSuggestionsPreferences,
  updateLanguageSuggestionsPreferences,
} from '../../language-suggestions/preferences'

/** The preferences, kept current when anything on the page changes them. */
export function useLanguageSuggestionsPreferences(): [
  LanguageSuggestionsPreferences,
  (patch: Partial<LanguageSuggestionsPreferences>) => void,
] {
  const [preferences, setPreferences] = useState(readLanguageSuggestionsPreferences)

  useEffect(() => {
    const onChange = () => setPreferences(readLanguageSuggestionsPreferences())
    window.addEventListener(LANGUAGE_SUGGESTIONS_CHANGED_EVENT, onChange)
    return () =>
      window.removeEventListener(LANGUAGE_SUGGESTIONS_CHANGED_EVENT, onChange)
  }, [])

  const update = useCallback(
    (patch: Partial<LanguageSuggestionsPreferences>) =>
      setPreferences(updateLanguageSuggestionsPreferences(patch)),
    []
  )

  return [preferences, update]
}
