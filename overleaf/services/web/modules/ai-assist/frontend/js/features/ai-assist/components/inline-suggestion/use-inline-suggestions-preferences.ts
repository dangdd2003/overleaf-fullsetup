import { useCallback, useEffect, useState } from 'react'
import { INLINE_SUGGESTIONS_CHANGED_EVENT } from '../../provider-store'
import {
  InlineSuggestionsPreferences,
  readInlineSuggestionsPreferences,
  updateInlineSuggestionsPreferences,
} from '../../inline-suggestion/preferences'

/** The preferences, kept current when anything on the page changes them. */
export function useInlineSuggestionsPreferences(): [
  InlineSuggestionsPreferences,
  (patch: Partial<InlineSuggestionsPreferences>) => void,
] {
  const [preferences, setPreferences] = useState(readInlineSuggestionsPreferences)

  useEffect(() => {
    const onChange = () => setPreferences(readInlineSuggestionsPreferences())
    window.addEventListener(INLINE_SUGGESTIONS_CHANGED_EVENT, onChange)
    return () =>
      window.removeEventListener(INLINE_SUGGESTIONS_CHANGED_EVENT, onChange)
  }, [])

  const update = useCallback(
    (patch: Partial<InlineSuggestionsPreferences>) =>
      setPreferences(updateInlineSuggestionsPreferences(patch)),
    []
  )

  return [preferences, update]
}
