import { FC, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Brain } from '@phosphor-icons/react'
import { useStickToBottom } from '../../hooks/use-stick-to-bottom'
import {
  STREAM_FADE_MS,
  MAX_FADE_LEAD_MS,
  useStreamReveal,
} from '../../hooks/use-stream-reveal'
import { subresultExpansionStore } from './subresult-group'
import { renderMarkdown } from './markdown-content'

type FadeChunk = { start: number; at: number }
type FadeState = { text: string; chunks: FadeChunk[] }

function fadeElement(el: Element, ageMs: number) {
  el.classList.add('ai-assist-stream-fade')
  const delayMs = Math.round(-ageMs)
  ;(el as HTMLElement).style.animationDelay = `${delayMs}ms`
}

function applyChunkFades(container: HTMLElement, state: FadeState) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)

  const text = nodes.map(node => node.data).join('')
  const now = performance.now()
  let kept = 0
  const max = Math.min(text.length, state.text.length)
  while (kept < max && text[kept] === state.text[kept]) kept++

  const chunks = state.chunks.filter(
    chunk =>
      chunk.start < kept && now - chunk.at < STREAM_FADE_MS + MAX_FADE_LEAD_MS
  )
  if (text.length > kept) {
    const newText = text.slice(kept)
    const tokenRegex = /\S+\s*/g
    let match: RegExpExecArray | null
    let tokenIndex = 0
    let addedAny = false
    while ((match = tokenRegex.exec(newText)) !== null) {
      const start = kept + match.index
      const stagger = Math.min(tokenIndex * 24, MAX_FADE_LEAD_MS)
      chunks.push({ start, at: now + stagger })
      tokenIndex++
      addedAny = true
    }
    if (!addedAny) {
      chunks.push({ start: kept, at: now })
    }
  }
  state.text = text
  state.chunks = chunks
  if (chunks.length === 0) return

  let offset = 0
  for (const node of nodes) {
    const nodeStart = offset
    offset += node.data.length

    if (offset <= chunks[0].start || !node.data.trim()) continue

    let current: Text = node
    let currentStart = nodeStart
    for (let i = 0; i < chunks.length; i++) {
      const start = Math.max(chunks[i].start, currentStart)
      const end = Math.min(chunks[i + 1]?.start ?? Infinity, offset)
      if (end <= start) continue
      if (start > currentStart) {
        current = current.splitText(start - currentStart)
        currentStart = start
      }
      const rest = end < offset ? current.splitText(end - currentStart) : null
      const span = document.createElement('span')
      fadeElement(span, now - chunks[i].at)
      current.parentNode!.insertBefore(span, current)
      span.appendChild(current)
      if (!rest) break
      current = rest
      currentStart = end
    }
  }
}

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

  const { text: revealedText, animating } = useStreamReveal(
    thinking,
    isLive && expanded
  )
  const displayText = isLive && expanded ? revealedText : thinking

  const html = useMemo(
    () => renderMarkdown(displayText, undefined, undefined, { isThinking: true }),
    [displayText]
  )

  const fadeState = useRef<FadeState | null>(
    isLive ? { text: '', chunks: [] } : null
  )

  useLayoutEffect(() => {
    if (!expanded) return
    const container = contentRef.current
    if (!container) return

    const template = document.createElement('template')
    template.innerHTML = html
    const newNodes = Array.from(template.content.childNodes)
    const currentNodes = Array.from(container.childNodes)

    let i = 0
    const maxCommon = Math.min(currentNodes.length, newNodes.length)
    while (i < maxCommon && currentNodes[i].isEqualNode(newNodes[i])) {
      i++
    }

    for (let j = i; j < newNodes.length; j++) {
      if (j < container.childNodes.length) {
        if (!container.childNodes[j].isEqualNode(newNodes[j])) {
          container.replaceChild(newNodes[j], container.childNodes[j])
        }
      } else {
        container.appendChild(newNodes[j])
      }
    }

    while (container.childNodes.length > newNodes.length) {
      container.removeChild(container.lastChild!)
    }

    if (animating) {
      fadeState.current ??= {
        text: container.textContent ?? '',
        chunks: [],
      }
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
