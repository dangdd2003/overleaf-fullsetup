import { KeyboardEvent, RefObject, useEffect, useLayoutEffect, useRef } from 'react'
import MaterialIcon from '@/shared/components/material-icon'
import { ChatSendButton } from '../agent/chat-send-button'

/** Height of a single line: the input's 24px line-height, no padding. */
const SINGLE_LINE_HEIGHT = 24
/** Five lines; longer prompts scroll. */
const MAX_INPUT_HEIGHT = 120

/**
 * The bar on top of the TeXGPT popup: an auto-growing textarea and a send
 * button, which turns into Stop while a request runs.
 */
export function TexGptPromptBar({
  value,
  placeholder,
  running,
  onChange,
  onSend,
  onStop,
  onArrowDown,
  inputRef,
}: {
  value: string
  placeholder: string
  running: boolean
  onChange: (value: string) => void
  onSend: () => void
  onStop: () => void
  /** Moves the focus into the list below; returns whether there was one. */
  onArrowDown?: () => boolean
  inputRef?: RefObject<HTMLTextAreaElement>
}) {
  const localRef = useRef<HTMLTextAreaElement>(null)
  const ref = inputRef ?? localRef
  const hasText = value.trim() !== ''

  useEffect(() => {
    ref.current?.focus({ preventScroll: true })
  }, [ref])

  useLayoutEffect(() => {
    const textarea = ref.current
    if (!textarea) return
    textarea.style.height = 'auto'
    if (!value) {
      textarea.style.height = `${SINGLE_LINE_HEIGHT}px`
      return
    }
    if (textarea.scrollHeight) {
      textarea.style.height = `${Math.min(
        Math.max(textarea.scrollHeight, SINGLE_LINE_HEIGHT),
        MAX_INPUT_HEIGHT
      )}px`
    }
  }, [value, ref])

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault()
      if (hasText && !running) onSend()
      return
    }
    if (
      event.key === 'ArrowDown' &&
      !value.slice(event.currentTarget.selectionStart ?? 0).includes('\n') &&
      onArrowDown?.()
    ) {
      event.preventDefault()
    }
  }

  return (
    <div className="ai-texgpt-bar">
      <MaterialIcon type="smart_toy" unfilled className="ai-texgpt-bar-icon" />
      <textarea
        ref={ref}
        className="ai-texgpt-input"
        rows={1}
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={event => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <ChatSendButton
        running={running}
        canSend={hasText}
        onSend={onSend}
        onStop={onStop}
      />
    </div>
  )
}
