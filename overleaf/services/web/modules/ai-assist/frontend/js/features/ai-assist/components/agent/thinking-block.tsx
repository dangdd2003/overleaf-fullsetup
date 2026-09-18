import { FC, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Brain } from '@phosphor-icons/react'
import { useStickToBottom } from '../../hooks/use-stick-to-bottom'

export const ThinkingBlock: FC<{
  thinking: string
  isLive?: boolean
  elapsedMs?: number
}> = ({ thinking, isLive = false, elapsedMs }) => {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const { onScroll, scrollToBottom } = useStickToBottom(bodyRef)

  useLayoutEffect(() => {
    if (expanded && isLive) {
      scrollToBottom({ smooth: false })
    }
  }, [expanded, isLive, scrollToBottom])

  if (!thinking) return null

  let title: string
  if (isLive) {
    title = t('ai_assist_thinking_live', 'Thinking…')
  } else if (elapsedMs != null && elapsedMs > 0) {
    const seconds = Math.max(1, Math.round(elapsedMs / 1000))
    title = t('ai_assist_thought_duration', {
      count: seconds,
      defaultValue: `Thought for ${seconds}s`,
    })
  } else {
    title = t('ai_assist_thought_summary', 'Thought process')
  }

  const handleToggle = () => {
    setExpanded(prev => {
      const next = !prev
      if (next) {
        window.dispatchEvent(new CustomEvent('aiAssist:stickToBottom'))
      }
      return next
    })
  }

  return (
    <div className="ai-assist-thinking-block">
      <button
        type="button"
        className="ai-assist-thinking-header"
        aria-expanded={expanded}
        onClick={handleToggle}
      >
        <span className="ai-assist-thinking-left">
          <span className="ai-assist-thinking-icon" aria-hidden="true">
            {isLive ? (
              <span className="ai-assist-thinking-pulse" />
            ) : (
              <Brain size={14} />
            )}
          </span>

          <span className="ai-assist-thinking-title">{title}</span>
        </span>

        <svg
          className={`ai-assist-thinking-chevron ${expanded ? 'is-expanded' : ''}`}
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 16 16"
          width="13"
          height="13"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="6 4 10 8 6 12" />
        </svg>
      </button>

      <div
        ref={bodyRef}
        onScroll={onScroll}
        className={`ai-assist-thinking-body ${expanded ? 'is-expanded' : ''}`}
        aria-hidden={!expanded}
      >
        <div className="ai-assist-thinking-content">{thinking}</div>
      </div>
    </div>
  )
}
