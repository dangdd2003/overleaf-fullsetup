import { FC, ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import OLTooltip from '@/shared/components/ol/ol-tooltip'
import { copyToClipboard } from '../../utils/copy-to-clipboard'

export type MessageActionButtonProps = {
  id: string
  label: string
  icon: ReactNode
  onClick: () => void
  disabled?: boolean
  tone?: 'default' | 'success'
}

/** Icon-only button under a user prompt or assistant response, with a tooltip. */
export const MessageActionButton: FC<MessageActionButtonProps> = ({
  id,
  label,
  icon,
  onClick,
  disabled,
  tone = 'default',
}) => {
  return (
    <OLTooltip id={id} description={label} overlayProps={{ placement: 'top' }}>
      <button
        type="button"
        className={`ai-assist-msg-action-btn${tone === 'success' ? ' is-copied' : ''}`}
        aria-label={label}
        // aria-disabled rather than disabled, so the tooltip still shows
        aria-disabled={disabled || undefined}
        onClick={disabled ? undefined : onClick}
      >
        {icon}
      </button>
    </OLTooltip>
  )
}

/** Copies text and flags `copied` for a short time after the click. */
export function useCopyFeedback(timeoutMs = 2000) {
  const [copied, setCopied] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [])

  const copy = useCallback(
    (text: string) => {
      void copyToClipboard(text)
      setCopied(true)
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      timeoutRef.current = setTimeout(() => {
        setCopied(false)
      }, timeoutMs)
    },
    [timeoutMs]
  )

  return { copied, copy }
}
