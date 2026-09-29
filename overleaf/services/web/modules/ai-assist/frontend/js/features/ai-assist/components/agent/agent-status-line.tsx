import { FC, Fragment, ReactNode, useEffect, useRef, useState } from 'react'
import { AssistantBlock } from '../../agent/agent-messages'
import {
  formatElapsed,
  formatCompletedStatus,
  nextStatusWord,
  deriveStatusMode,
  countOutputTokens,
  formatTokenCount,
  thinkingPhrase,
} from './status-words'

/** How long a status word stays up before rotating. */
const WORD_ROTATE_MS = 4000

/**
 * No new tokens for this long outside a tool call and the line drifts to the
 * danger colour, as Claude Code's spinner does.
 */
const STALL_MS = 3000

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
 * Text whose changed characters roll up to their new value, the way Claude's
 * timer ticks over to the next second. Characters line up from the right, so
 * "9s" → "10s" rolls the units digit and brings the tens digit in fresh.
 */
const RollingText: FC<{ text: string }> = ({ text }) => {
  // The text before the latest change, held until the next one so re-renders
  // between ticks (every streamed token) do not cut the roll short.
  const [roll, setRoll] = useState({ text, previous: text })
  if (roll.text !== text) {
    setRoll({ text, previous: roll.text })
  }
  const { previous } = roll

  const chars = [...text]
  return (
    <>
      {chars.map((char, index) => {
        const fromRight = chars.length - index
        const before = previous[previous.length - fromRight]
        const changed = before !== char
        return (
          <span key={fromRight} className="ai-assist-roll-slot">
            {changed && before !== undefined && (
              <span
                key={`out-${before}`}
                className="ai-assist-roll-out"
                aria-hidden="true"
              >
                {before}
              </span>
            )}
            <span
              key={`in-${char}`}
              className={changed ? 'ai-assist-roll-in' : undefined}
            >
              {char}
            </span>
          </span>
        )
      })}
    </>
  )
}

/**
 * The status line, in the Claude desktop app's shape. It switches between two
 * forms: `✳ Brewing…` while waiting on the provider or streaming the reply,
 * and `✳ 12s · ↓ 1.2k tokens · Thinking some more…` / `… · Running tools…`
 * while a thought streams or a tool runs.
 * While running, the mark and the word share the accent colour and the word's
 * shimmer follows the stream: a quick forward sweep while waiting on the
 * provider, a slow backward sweep while tokens arrive, a pulse while a tool
 * runs, and a drift to red when the stream goes quiet.
 * When completed: shows static Overleaf icon (no blinking) and total running time (e.g. "Brewed for 12s").
 * While the run waits on the user (a confirmation card), the line stops: the
 * mark holds still and the clock and word freeze, leaving the wait uncounted.
 */
export const AgentStatusLine: FC<{
  startedAt: number
  blocks?: AssistantBlock[]
  pendingApproval?: { id: string; edit: any } | null
  isRunning?: boolean
  /** The run is waiting on the user rather than working. */
  isPaused?: boolean
  durationMs?: number
  completedWord?: string
  onWordChange?: (word: string) => void
}> = ({
  startedAt,
  blocks = [],
  pendingApproval = null,
  isRunning = true,
  isPaused = false,
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

  // Time spent waiting on the user, which the clock leaves out
  const pausedRef = useRef({
    startedAt,
    total: 0,
    since: null as number | null,
  })
  if (pausedRef.current.startedAt !== startedAt) {
    pausedRef.current = { startedAt, total: 0, since: null }
  }

  const mode = deriveStatusMode(blocks)
  const tokens = countOutputTokens(blocks)

  // When the stream last moved: a new token, or a change of mode (a tool
  // finishing starts a fresh wait on the provider, not a stall).
  const activityKey = `${startedAt}:${mode}:${tokens}`
  const activityRef = useRef({ key: activityKey, at: Date.now() })
  if (activityRef.current.key !== activityKey) {
    activityRef.current = { key: activityKey, at: Date.now() }
  }

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

    const paused = pausedRef.current
    if (isPaused) {
      paused.since ??= Date.now()
    } else if (paused.since !== null) {
      paused.total += Date.now() - paused.since
      paused.since = null
    }
    const clock = () =>
      Math.max(0, (paused.since ?? Date.now()) - startedAt - paused.total)

    setElapsedMs(clock())
    if (isPaused) return

    let ticks = 0
    const timer = setInterval(() => {
      ticks += 1
      setElapsedMs(clock())
      if ((ticks * 1000) % WORD_ROTATE_MS === 0) {
        setWord(current => {
          const next = nextStatusWord(current)
          onWordChangeRef.current?.(next)
          return next
        })
      }
    }, 1000)

    return () => clearInterval(timer)
  }, [startedAt, isRunning, isPaused, durationMs])

  if (pendingApproval) {
    return null
  }

  if (isRunning && isPaused) {
    const elapsed = formatElapsed(elapsedMs)
    return (
      <div
        className="ai-assist-status-line is-paused"
        role="status"
        aria-live="polite"
      >
        <span
          className="ai-assist-status-icon ai-assist-status-icon-static"
          aria-hidden="true"
        >
          <svg viewBox="0 0 136 157">
            <path
              className="ai-assist-status-mark ai-assist-status-mark-static"
              d={OVERLEAF_MARK}
            />
          </svg>
        </span>
        <span className="ai-assist-status-text">
          {elapsed ? `${elapsed} · ` : ''}Waiting for approval
        </span>
      </div>
    )
  }

  if (!isRunning) {
    const finalElapsed = durationMs !== undefined ? durationMs : elapsedMs
    const statusText = formatCompletedStatus(
      completedWord || word,
      finalElapsed
    )

    return (
      <div
        className="ai-assist-status-line is-completed"
        role="status"
        aria-live="polite"
      >
        <span
          className="ai-assist-status-icon ai-assist-status-icon-static"
          aria-hidden="true"
        >
          <svg viewBox="0 0 136 157">
            <path
              className="ai-assist-status-mark ai-assist-status-mark-static"
              d={OVERLEAF_MARK}
            />
          </svg>
        </span>
        <span className="ai-assist-status-text">{statusText}</span>
      </div>
    )
  }

  const now = Date.now()
  const stalled = mode !== 'tool' && now - activityRef.current.at >= STALL_MS

  // Claude's two forms, never mixed: the rotating word on its own, or — while
  // the model is visibly doing something — the counters followed by what it
  // is doing ("49s · Thinking some more…", "2m 41s · Running tools…").
  const last = blocks.at(-1)
  let activity: string | null = null
  if (mode === 'thinking' && last?.type === 'thinking') {
    activity = thinkingPhrase(now - (last.startedAt ?? startedAt))
  } else if (mode === 'tool') {
    activity = 'Running tools'
  }

  const meta: { key: string; content: ReactNode }[] = []
  if (activity) {
    const elapsed = formatElapsed(elapsedMs)
    if (elapsed) {
      meta.push({ key: 'elapsed', content: <RollingText text={elapsed} /> })
    }
    if (tokens > 0) {
      meta.push({
        key: 'tokens',
        content: `↓ ${formatTokenCount(tokens)} tokens`,
      })
    }
  }

  return (
    <div
      className={`ai-assist-status-line is-${mode}${stalled ? ' is-stalled' : ''}`}
      role="status"
      aria-live="polite"
    >
      <span className="ai-assist-status-spinner" aria-hidden="true">
        <svg viewBox="0 0 136 157">
          <path className="ai-assist-status-mark" d={OVERLEAF_MARK} />
        </svg>
      </span>
      <span className="ai-assist-status-body">
        {meta.length > 0 && (
          <span className="ai-assist-status-meta">
            {meta.map(segment => (
              <Fragment key={segment.key}>{segment.content} · </Fragment>
            ))}
          </span>
        )}
        <span className="ai-assist-status-verb">{activity ?? word}…</span>
      </span>
    </div>
  )
}
