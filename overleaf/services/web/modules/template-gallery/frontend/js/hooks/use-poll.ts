import { useEffect, useRef } from 'react'

// Calls fn every intervalMs while enabled. Ticks are skipped while the page
// is hidden and while a previous tick is still in flight. The callback owns
// its error state, so a failed tick never stops the polling.
export function usePoll(
  fn: () => Promise<void>,
  intervalMs: number,
  enabled: boolean
) {
  const fnRef = useRef(fn)

  useEffect(() => {
    fnRef.current = fn
  })

  useEffect(() => {
    if (!enabled) {
      return
    }
    let inFlight = false
    const tick = () => {
      if (document.hidden || inFlight) {
        return
      }
      inFlight = true
      fnRef
        .current()
        .catch(() => {
          // Reported by the caller's own state
        })
        .finally(() => {
          inFlight = false
        })
    }
    const onVisibilityChange = () => {
      if (!document.hidden) {
        tick()
      }
    }

    const timer = window.setInterval(tick, intervalMs)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [intervalMs, enabled])
}

export default usePoll
