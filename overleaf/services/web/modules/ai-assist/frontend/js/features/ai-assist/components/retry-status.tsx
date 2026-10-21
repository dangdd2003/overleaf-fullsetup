import { FC } from 'react'
import { useTranslation } from 'react-i18next'
import type { RetryingState } from '../agent/agent-state'
import type { ProviderRetry } from '../providers/types'
import { useRetryCountdown } from '../hooks/use-retry-countdown'

type Translate = ReturnType<typeof useTranslation>['t']

/** A relay retry as the UI holds it: its countdown runs from now. */
export function retryingState(
  retry: ProviderRetry | null,
  now: number = Date.now()
): RetryingState | null {
  if (!retry) return null
  return {
    attempt: retry.attempt,
    maxRetries: retry.maxRetries,
    deadline: now + retry.retryInMs,
    message: retry.message,
    ...(retry.status !== undefined ? { status: retry.status } : {}),
  }
}

/**
 * "Retrying in 7s · attempt 2/10", and "Retrying now · …" once the countdown
 * reaches 0. `seconds` is what useRetryCountdown returned.
 */
export function retryLabel(
  t: Translate,
  retry: RetryingState,
  seconds: number
): string {
  const attempt = String(retry.attempt)
  const max = String(retry.maxRetries)
  if (seconds > 0) {
    return t('ai_assist_retrying_in', {
      seconds: String(seconds),
      attempt,
      max,
      defaultValue: `Retrying in ${seconds}s · attempt ${attempt}/${max}`,
    })
  }
  return t('ai_assist_retrying_now', {
    attempt,
    max,
    defaultValue: `Retrying now · attempt ${attempt}/${max}`,
  })
}

/**
 * The reason, in red, once retries have gone on a while or the provider is
 * rate limiting. Nothing before that: a first blip is not worth alarming over.
 */
export const RetryError: FC<{ retry: RetryingState }> = ({ retry }) => {
  const showError =
    retry.attempt >= Math.min(3, retry.maxRetries) || retry.status === 429
  if (!showError) return null
  return <span className="ai-assist-retry-error">{retry.message}</span>
}

/**
 * The retry notice for an editor feature's loading line, in the status line's
 * shape: a counting label and, when it matters, the reason under it.
 */
export const RetryNotice: FC<{ retry: RetryingState }> = ({ retry }) => {
  const { t } = useTranslation()
  const seconds = useRetryCountdown(retry.deadline) ?? 0
  return (
    <span className="ai-assist-retry-notice" role="status" aria-live="polite">
      <span className="ai-assist-retry-label">
        {retryLabel(t, retry, seconds)}
      </span>
      <RetryError retry={retry} />
    </span>
  )
}
