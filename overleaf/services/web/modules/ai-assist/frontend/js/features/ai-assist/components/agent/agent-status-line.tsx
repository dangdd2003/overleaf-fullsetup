import { FC, useEffect, useRef, useState } from 'react'
import { AssistantBlock } from '../../agent/agent-messages'
import {
  formatElapsed,
  formatCompletedStatus,
  nextStatusWord,
  deriveDynamicStatus,
} from './status-words'

/** How long a status word stays up before rotating. */
const WORD_ROTATE_MS = 4000

/**
 * The Overleaf "O" mark, taken verbatim from `public/img/ol-brand/overleaf-o.svg`.
 */
const OVERLEAF_MARK =
  'M37.205 39.652C14.822 53.982 0 77.339 0 102.326 0 132.522 24.48 157 54.681 ' +
  '157c30.198 0 54.674-24.478 54.674-54.674 0-23.34-14.626-43.276-35.204-51.111' +
  '-3.958-1.505-12.556-4.213-19.421-3.635-9.806 6.234-21.751 19.044-27.411 ' +
  '31.809 8.416-10.093 21.537-14.488 33.17-12.619 17.126 2.777 30.208 17.638 ' +
  '30.208 35.551 0 19.896-16.126 36.021-36.016 36.021-10.962 0-20.785-4.896' +
  '-27.388-12.619C17.516 114.299 15 101.91 16.975 89.809c6.927-42.375 57.233' +
  '-66.53 94.636-75.799-12.207 6.458-34.227 17.074-49.626 28.63 44.924 17.341 ' +
  '52.184-20.517 73.217-37.459C114.038-3.07 37.33-6.117 37.205 39.652z'

/**
 * The status line, matching Claude Code's progressive activity display.
 * While running: reflects thinking, tool execution, or text generation with elapsed timer.
 * When completed: shows static Overleaf icon (no blinking) and total running time (e.g. "Brewed for 12s").
 */
export const AgentStatusLine: FC<{
  startedAt: number
  blocks?: AssistantBlock[]
  pendingApproval?: { id: string; edit: any } | null
  isRunning?: boolean
  durationMs?: number
  completedWord?: string
  onWordChange?: (word: string) => void
}> = ({
  startedAt,
  blocks = [],
  pendingApproval = null,
  isRunning = true,
  durationMs,
  completedWord,
  onWordChange,
}) => {
  const [word, setWord] = useState(() => nextStatusWord(null))
  const [elapsedMs, setElapsedMs] = useState(() =>
    durationMs !== undefined ? durationMs : Math.max(0, Date.now() - startedAt)
  )

  const onWordChangeRef = useRef(onWordChange)
  onWordChangeRef.current = onWordChange

  const wordRef = useRef(word)
  wordRef.current = word

  const prevStartedAtRef = useRef(startedAt)

  useEffect(() => {
    if (!isRunning) {
      if (durationMs !== undefined) {
        setElapsedMs(durationMs)
      }
      return
    }

    // Only pick a new word if a new run has actually started with a new startedAt
    if (prevStartedAtRef.current !== startedAt) {
      prevStartedAtRef.current = startedAt
      const newWord = nextStatusWord(null)
      setWord(newWord)
      onWordChangeRef.current?.(newWord)
    } else {
      onWordChangeRef.current?.(wordRef.current)
    }

    setElapsedMs(Math.max(0, Date.now() - startedAt))

    let ticks = 0
    const timer = setInterval(() => {
      ticks += 1
      setElapsedMs(Date.now() - startedAt)
      if ((ticks * 1000) % WORD_ROTATE_MS === 0) {
        setWord(current => {
          const next = nextStatusWord(current)
          onWordChangeRef.current?.(next)
          return next
        })
      }
    }, 1000)

    return () => clearInterval(timer)
  }, [startedAt, isRunning, durationMs])

  if (pendingApproval) {
    return null
  }

  if (!isRunning) {
    const finalElapsed = durationMs !== undefined ? durationMs : elapsedMs
    const statusText = formatCompletedStatus(completedWord || word, finalElapsed)

    return (
      <div className="ai-assist-status-line is-completed" role="status" aria-live="polite">
        <span className="ai-assist-status-icon ai-assist-status-icon-static" aria-hidden="true">
          <svg viewBox="0 0 136 157">
            <path className="ai-assist-status-mark ai-assist-status-mark-static" d={OVERLEAF_MARK} />
          </svg>
        </span>
        <span className="ai-assist-status-text">{statusText}</span>
      </div>
    )
  }

  const elapsed = formatElapsed(elapsedMs)
  const statusText = deriveDynamicStatus({
    blocks,
    elapsedMs,
    fancyWord: word,
    pendingApproval,
  })

  return (
    <div className="ai-assist-status-line" role="status" aria-live="polite">
      <span className="ai-assist-status-spinner" aria-hidden="true">
        <svg viewBox="0 0 136 157">
          <path className="ai-assist-status-mark" d={OVERLEAF_MARK} />
        </svg>
      </span>
      <span className="ai-assist-status-text">
        {elapsed ? `${elapsed} · ` : ''}
        {statusText}
      </span>
    </div>
  )
}
