import { useEffect, useRef } from 'react'

/** How long a passing test result stays up. Failures stay until a pass. */
export const TEST_RESULT_MS = { success: 6000 }

/**
 * Calls `onDismiss` once `delay` ms after `active` turns true. Starting
 * again, or turning false, cancels the pending call.
 */
export function useAutoDismiss(
  active: boolean,
  onDismiss: () => void,
  delay: number,
  key?: unknown
) {
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss

  useEffect(() => {
    if (!active) return
    const timer = window.setTimeout(() => dismiss.current(), delay)
    return () => window.clearTimeout(timer)
  }, [active, delay, key])
}
