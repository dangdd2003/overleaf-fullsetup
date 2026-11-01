import { useCallback, useRef, useState } from 'react'
import { toTemplateAdminApiError, TemplateAdminApiError } from '../api/errors'

// Runs one write at a time. A call made while another is pending is ignored,
// which prevents double submits. Errors are kept in `error` rather than thrown.
export function useAsyncAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<TemplateAdminApiError | null>(null)
  // A ref, not state, so a second click in the same tick is rejected too
  const busyRef = useRef(false)

  const run = useCallback(
    async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
      if (busyRef.current) {
        return undefined
      }
      busyRef.current = true
      setBusy(true)
      setError(null)
      try {
        return await fn()
      } catch (err) {
        setError(toTemplateAdminApiError(err))
        return undefined
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    },
    []
  )

  const clearError = useCallback(() => setError(null), [])

  return { run, busy, error, clearError }
}

export default useAsyncAction
