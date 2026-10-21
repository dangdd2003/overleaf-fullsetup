import { useEffect, useState } from 'react'

/** Seconds until `deadline`, rounded up as Claude Code shows them; 0 once due. */
export function retrySecondsLeft(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000))
}

/**
 * Seconds left until a scheduled retry, ticking once a second. Null when no
 * retry is scheduled.
 */
export function useRetryCountdown(deadline: number | null): number | null {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (deadline === null) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [deadline])

  return deadline === null ? null : retrySecondsLeft(deadline, now)
}
