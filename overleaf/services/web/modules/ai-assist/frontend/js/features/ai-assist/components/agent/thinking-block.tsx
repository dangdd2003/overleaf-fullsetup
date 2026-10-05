import { FC, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Brain } from '@phosphor-icons/react'
import { useStickToBottom } from '../../hooks/use-stick-to-bottom'
import { useRevealLive, useStreamReveal } from '../../hooks/use-stream-reveal'
import { applyChunkFades, createFadeState, FadeState } from './stream-fade'
import { subresultExpansionStore } from './subresult-group'
import { reconcileContainerHtml, renderMarkdown } from './markdown-content'

export const ThinkingBlock: FC<{
  thinking: string
  isLive?: boolean
  elapsedMs?: number
  groupId?: string
  blockId?: string
}> = ({ thinking, isLive = false, elapsedMs, groupId, blockId }) => {
  const { t } = useTranslation()
  const uniqueId = blockId ?? (groupId ? `${groupId}-think` : undefined)
  const storageKey = uniqueId ? `think-item:${uniqueId}` : null

  const [expanded, setExpanded] = useState<boolean>(() => {
    if (storageKey && subresultExpansionStore.has(storageKey)) {
      return subresultExpansionStore.get(storageKey)!
    }
    return false
  })

  const contentRef = useRef<HTMLDivElement>(null)
  const { onScroll, scrollToBottom } = useStickToBottom(contentRef)

  // Thinking the run did before this chat was opened is shown at once
  const revealLive = useRevealLive(isLive)
  const { text: revealedText, animating } = useStreamReveal(
    thinking,
    revealLive && expanded
  )
  const displayText = revealLive && expanded ? revealedText : thinking

  const html = useMemo(
    () => renderMarkdown(displayText, undefined, undefined, { isThinking: true }),
    [displayText]
  )

  const fadeState = useRef<FadeState | null>(
    revealLive ? createFadeState() : null
  )

  useLayoutEffect(() => {
    if (!expanded) return
    const container = contentRef.current
    if (!container) return

    reconcileContainerHtml(container, html)

    if (animating) {
      fadeState.current ??= createFadeState(container)
      applyChunkFades(container, fadeState.current)
    } else {
      fadeState.current = null
    }
  }, [html, expanded, animating])

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
      if (storageKey) {
        subresultExpansionStore.set(storageKey, next)
      }
      if (next) {
        window.dispatchEvent(new CustomEvent('aiAssist:stickToBottom'))
        setTimeout(() => scrollToBottom({ smooth: false }), 0)
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
        <span className="ai-assist-thinking-icon" aria-hidden="true">
          {isLive ? (
            <span className="ai-assist-thinking-pulse" />
          ) : (
            <Brain size={14} />
          )}
        </span>

        <span className="ai-assist-thinking-title">{title}</span>

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
        className={`ai-assist-thinking-body ${expanded ? 'is-expanded' : ''}`}
        aria-hidden={!expanded}
      >
        <div
          ref={contentRef}
          onScroll={onScroll}
          className="ai-assist-thinking-content"
        />
      </div>
    </div>
  )
}
