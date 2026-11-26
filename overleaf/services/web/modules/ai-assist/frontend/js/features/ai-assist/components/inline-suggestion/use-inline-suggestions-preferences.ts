import { useCallback, useEffect, useState } from 'react'
import { INLINE_SUGGESTIONS_CHANGED_EVENT } from '../../provider-store'
import {
  InlineSuggestionsPreferences,
  readInlineSuggestionsPreferences,
  updateInlineSuggestionsPreferences,
} from '../../inline-suggestion/preferences'

const DEFAULT_PREFERENCES: InlineSuggestionsPreferences = {
  emptyLineShortcut: false,
  completionMode: 'disabled',
  completionDelayMs: 300,
}

/** The preferences, kept current when anything on the page changes them. */
export function useInlineSuggestionsPreferences(
  enabled: boolean = true
): [
  InlineSuggestionsPreferences,
  (patch: Partial<InlineSuggestionsPreferences>) => void,
] {
  const [preferences, setPreferences] = useState(() =>
    enabled ? readInlineSuggestionsPreferences() : DEFAULT_PREFERENCES
  )

  useEffect(() => {
    if (!enabled) return
    setPreferences(readInlineSuggestionsPreferences())
    const onChange = () => setPreferences(readInlineSuggestionsPreferences())
    window.addEventListener(INLINE_SUGGESTIONS_CHANGED_EVENT, onChange)
    return () =>
      window.removeEventListener(INLINE_SUGGESTIONS_CHANGED_EVENT, onChange)
  }, [enabled])

  const update = useCallback(
    (patch: Partial<InlineSuggestionsPreferences>) =>
      setPreferences(updateInlineSuggestionsPreferences(patch)),
    []
  )

  return [preferences, update]
}
