import { PaperPlaneRight } from '@phosphor-icons/react'
import { useTranslation } from 'react-i18next'
import classNames from 'classnames'

/**
 * The chat panel's round Send button, which turns into Stop while a request
 * runs. Shared by the chat composer and the TeXGPT prompt bars so they look
 * and behave the same.
 */
export function ChatSendButton({
  running,
  canSend,
  onSend,
  onStop,
  sendLabel,
}: {
  /** Show Stop instead of Send. */
  running: boolean
  canSend: boolean
  onSend: () => void
  onStop: () => void
  /** Defaults to "Send". */
  sendLabel?: string
}) {
  const { t } = useTranslation()
  if (running) {
    const stopLabel = t('stop_esc', 'Stop (Esc)')
    return (
      <button
        type="button"
        className="ai-assist-send-btn ai-assist-stop-btn"
        onClick={onStop}
        aria-label={stopLabel}
        title={stopLabel}
      >
        <svg
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="currentColor"
          aria-hidden="true"
        >
          <rect x="3" y="3" width="10" height="10" rx="2" />
        </svg>
      </button>
    )
  }
  const label = sendLabel ?? t('send', 'Send')
  return (
    <button
      type="button"
      className={classNames('ai-assist-send-btn', { 'is-active': canSend })}
      disabled={!canSend}
      onClick={onSend}
      aria-label={label}
      title={label}
    >
      <PaperPlaneRight size={16} weight="fill" />
    </button>
  )
}
