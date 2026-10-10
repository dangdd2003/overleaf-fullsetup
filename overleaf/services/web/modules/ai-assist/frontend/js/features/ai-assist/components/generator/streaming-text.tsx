import {
  FC,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react'
import classNames from 'classnames'
import {
  MAX_FADE_LEAD_MS,
  STREAM_FADE_MS,
  useStreamReveal,
} from '../../hooks/use-stream-reveal'
import { useStickToBottom } from '../../hooks/use-stick-to-bottom'
import {
  highlightCodeHtml,
  SYSTEM_CODE_CLASS,
  useSystemHighlightStyle,
} from '../../hooks/use-editor-code-highlight'
import { renderMarkdown } from '../agent/markdown-content'

/**
 * The Overleaf "O" mark, taken verbatim from `public/img/ol-brand/overleaf-o.svg`.
 */
export const OVERLEAF_MARK =
  'M37.205 39.652C14.822 53.982 0 77.339 0 102.326 0 132.522 24.48 157 54.681 ' +
  '157c30.198 0 54.674-24.478 54.674-54.674 0-23.34-14.626-43.276-35.204-51.111' +
  '-3.958-1.505-12.556-4.213-19.421-3.635-9.806 6.234-21.751 19.044-27.411 ' +
  '31.809 8.416-10.093 21.537-14.488 33.17-12.619 17.126 2.777 30.208 17.638 ' +
  '30.208 35.551 0 19.896-16.126 36.021-36.016 36.021-10.962 0-20.785-4.896' +
  '-27.388-12.619C17.516 114.299 15 101.91 16.975 89.809c6.927-42.375 57.233' +
  '-66.53 94.636-75.799-12.207 6.458-34.227 17.074-49.626 28.63 44.924 17.341 ' +
  '52.184-20.517 73.217-37.459C114.038-3.07 37.33-6.117 37.205 39.652z'

const PAST_TENSE_WORDS: Record<string, string> = {
  Write: 'Written',
  Writing: 'Written',
  Generate: 'Generated',
  Generating: 'Generated',
  Brew: 'Brewed',
  Brewing: 'Brewed',
  Boil: 'Boiled',
  Boiling: 'Boiled',
  Bioled: 'Boiled',
  Typeset: 'Typeset',
  Typesetting: 'Typeset',
  Translate: 'Translated',
  Translating: 'Translated',
  Rephrase: 'Rephrased',
  Rephrasing: 'Rephrased',
  Proofread: 'Proofread',
  Proofreading: 'Proofread',
  Find: 'Found',
  Finding: 'Found',
  Fix: 'Fixed',
  Fixing: 'Fixed',
  Repair: 'Repaired',
  Repairing: 'Repaired',
  Shorten: 'Shortened',
  Shortening: 'Shortened',
  Lengthen: 'Lengthened',
  Lengthening: 'Lengthened',
  Simplify: 'Simplified',
  Simplifying: 'Simplified',
}

export function toPastTense(word: string): string {
  if (!word) return 'Written'
  const trimmed = word.replace(/…$/, '').trim()
  if (PAST_TENSE_WORDS[trimmed]) return PAST_TENSE_WORDS[trimmed]
  if (Object.values(PAST_TENSE_WORDS).includes(trimmed)) return trimmed
  if (trimmed.endsWith('ed')) return trimmed
  if (trimmed.endsWith('ing')) {
    const base = trimmed.slice(0, -3)
    if (base.endsWith('e')) return `${base}d`
    return `${base}ed`
  }
  return `${trimmed}ed`
}

export function formatDuration(elapsedMs: number): string {
  const totalSeconds = Math.round(elapsedMs / 1000)
  if (totalSeconds <= 1) return '1s'
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const remainingSeconds = totalSeconds % 60
  if (remainingSeconds === 0) return `${minutes}m`
  return `${minutes}m ${remainingSeconds}s`
}

export function formatCompletedStatus(word: string, elapsedMs: number): string {
  const pastWord = toPastTense(word)
  const duration = formatDuration(elapsedMs)
  return `${pastWord} for ${duration}`
}

/**
 * Animated status line for popups matching the main AI chat panel:
 * - Running: Blooming Overleaf mark + shimmering verb.
 * - Completed: Static green Overleaf mark + completed duration (e.g. "Written for 2s").
 */
export const PopupStatusLine: FC<{
  text?: string
  subtext?: string
  className?: string
  completed?: boolean
  verb?: string
  durationMs?: number
}> = ({ text, subtext, className, completed = false, verb, durationMs }) => {
  if (completed) {
    const statusText =
      text || formatCompletedStatus(verb || 'Written', durationMs ?? 1000)
    return (
      <div
        className={classNames(
          'ai-assist-status-line is-completed ai-popup-status-line',
          className
        )}
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

  return (
    <div
      className={classNames(
        'ai-assist-status-line is-responding ai-popup-status-line',
        className
      )}
      role="status"
      aria-live="polite"
    >
      <span className="ai-assist-status-spinner" aria-hidden="true">
        <svg viewBox="0 0 136 157">
          <path className="ai-assist-status-mark" d={OVERLEAF_MARK} />
        </svg>
      </span>
      <span className="ai-assist-status-body">
        <span className="ai-assist-status-verb">{text}</span>
        {subtext && (
          <span className="ai-assist-status-subtext"> · {subtext}</span>
        )}
      </span>
    </div>
  )
}

type FadeChunk = { start: number; at: number }
export type PopupFadeState = {
  text: string
  chunks: FadeChunk[]
  rules: number[]
}

const WORD_STAGGER_MS = 24

const FADE_UNIT_SELECTOR = [
  '.ai-assist-table-wrapper',
  '.ai-assist-code-block',
  '.ai-assist-thinking-code-block',
  '.ai-texgpt-code',
  '.ai-generator-latex',
  '.ai-writing-tools-text',
  'blockquote',
  'tr',
  'li',
  '.katex',
  '.ai-assist-citation',
].join(', ')

const ATOMIC_SELECTOR = '.katex, button, svg, .ai-assist-citation'

export function createPopupFadeState(
  container?: HTMLElement | null
): PopupFadeState {
  return {
    text: container?.textContent ?? '',
    chunks: [],
    rules: Array.from(container?.querySelectorAll('hr') ?? [], () => -Infinity),
  }
}

function fadeElement(el: Element, ageMs: number) {
  el.classList.add('ai-assist-stream-fade')
  ;(el as HTMLElement).style.animationDelay = `${Math.round(-ageMs)}ms`
}

function fadeRules(
  container: HTMLElement,
  state: PopupFadeState,
  now: number,
  windowMs: number
) {
  const rules = container.querySelectorAll('hr')
  state.rules.length = Math.min(state.rules.length, rules.length)
  rules.forEach((rule, i) => {
    if (i >= state.rules.length) state.rules.push(now)
    if (now - state.rules[i] < windowMs) fadeElement(rule, now - state.rules[i])
  })
}

export function applyPopupChunkFades(
  container: HTMLElement,
  state: PopupFadeState
) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)

  const text = nodes.map(node => node.data).join('')
  const now = performance.now()
  const windowMs = STREAM_FADE_MS + MAX_FADE_LEAD_MS
  let kept = 0
  const max = Math.min(text.length, state.text.length)
  while (kept < max && text[kept] === state.text[kept]) kept++

  const chunks = state.chunks.filter(
    chunk => chunk.start < kept && now - chunk.at < windowMs
  )
  if (text.length > kept) {
    const tokenRegex = /\S+\s*/g
    const newText = text.slice(kept)
    let match: RegExpExecArray | null
    let tokenIndex = 0
    while ((match = tokenRegex.exec(newText)) !== null) {
      const stagger = Math.min(tokenIndex * WORD_STAGGER_MS, MAX_FADE_LEAD_MS)
      chunks.push({ start: kept + match.index, at: now + stagger })
      tokenIndex++
    }
    if (tokenIndex === 0) chunks.push({ start: kept, at: now })
  }
  state.text = text
  state.chunks = chunks

  fadeRules(container, state, now, windowMs)
  if (chunks.length === 0) return

  const chunkAt = (offset: number) => {
    for (let i = chunks.length - 1; i >= 0; i--) {
      if (offset >= chunks[i].start) return chunks[i]
    }
    return null
  }

  const unitChunks = new Map<Element, FadeChunk | null>()
  let offset = 0
  for (const node of nodes) {
    const nodeStart = offset
    offset += node.data.length

    const covering = new Set<FadeChunk>()
    let el = node.parentElement
    while (el && el !== container) {
      if (el.matches(FADE_UNIT_SELECTOR)) {
        if (!unitChunks.has(el)) {
          const chunk = chunkAt(nodeStart)
          unitChunks.set(el, chunk)
          if (chunk) fadeElement(el, now - chunk.at)
        }
        const chunk = unitChunks.get(el)
        if (chunk) covering.add(chunk)
      }
      el = el.parentElement
    }

    if (offset <= chunks[0].start || !node.data.trim()) continue
    if (node.parentElement?.closest(ATOMIC_SELECTOR)) continue

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
      if (!covering.has(chunks[i])) {
        const span = document.createElement('span')
        fadeElement(span, now - chunks[i].at)
        current.parentNode!.insertBefore(span, current)
        span.appendChild(current)
      }
      if (!rest) break
      current = rest
      currentStart = end
    }
  }
}

function nodesMatch(a: Node, b: Node): boolean {
  if (a.isEqualNode(b)) return true
  if (a.nodeType !== b.nodeType) return false
  if (a instanceof HTMLElement && b instanceof HTMLElement) {
    if (a.tagName !== b.tagName) return false
    if (
      a.textContent === b.textContent &&
      a.children.length === b.children.length
    ) {
      const cleanA = a.innerHTML
        .replace(/\b(ai-assist-stream-fade|is-streaming)\b/g, '')
        .trim()
      const cleanB = b.innerHTML
        .replace(/\b(ai-assist-stream-fade|is-streaming)\b/g, '')
        .trim()
      if (cleanA === cleanB) return true
    }
  }
  return false
}

export function reconcilePopupContainerHtml(
  container: HTMLElement,
  newHtml: string
) {
  const template = document.createElement('template')
  template.innerHTML = newHtml
  const newNodes = Array.from(template.content.childNodes)
  const currentNodes = Array.from(container.childNodes)

  let i = 0
  const maxCommon = Math.min(currentNodes.length, newNodes.length)

  while (i < maxCommon && nodesMatch(currentNodes[i], newNodes[i])) {
    i++
  }

  for (let j = i; j < newNodes.length; j++) {
    if (j < container.childNodes.length) {
      const current = container.childNodes[j]
      const next = newNodes[j]
      if (!nodesMatch(current, next)) {
        container.replaceChild(next, current)
      }
    } else {
      container.appendChild(newNodes[j])
    }
  }

  while (container.childNodes.length > newNodes.length) {
    container.removeChild(container.lastChild!)
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/**
 * Animated streaming plain text component with stick-to-bottom follow.
 */
export const StreamingText: FC<{
  text: string
  isLive?: boolean
  className?: string
}> = ({ text, isLive = true, className }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const { text: revealed, animating } = useStreamReveal(text, isLive)
  const fadeState = useRef<PopupFadeState | null>(null)

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return

    const html = escapeHtml(revealed)
    reconcilePopupContainerHtml(container, html)

    if (animating) {
      fadeState.current ??= createPopupFadeState(container)
      applyPopupChunkFades(container, fadeState.current)
      window.dispatchEvent(new CustomEvent('aiAssist:stickToBottom'))
    } else {
      fadeState.current = null
    }
  }, [revealed, animating])

  return (
    <div
      ref={containerRef}
      className={classNames(
        'ai-writing-tools-text',
        { 'is-streaming': animating },
        className
      )}
    />
  )
}

/**
 * LaTeX / code block with streaming token animations in editor syntax token colors,
 * supporting auto-scrolling following text generation.
 */
export const StreamingCodeBlock: FC<{
  code: string
  isLive?: boolean
  language?: string
  className?: string
}> = ({ code, isLive = true, language = 'latex', className }) => {
  const containerRef = useRef<HTMLPreElement>(null)
  useSystemHighlightStyle()

  const { onScroll } = useStickToBottom(containerRef)
  const { text: revealed, animating } = useStreamReveal(code, isLive)
  const fadeState = useRef<PopupFadeState | null>(null)

  const highlighted = useMemo(() => {
    return highlightCodeHtml(revealed, language)
  }, [revealed, language])

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return

    const html = highlighted !== null ? highlighted : escapeHtml(revealed)
    reconcilePopupContainerHtml(container, html)

    if (animating) {
      fadeState.current ??= createPopupFadeState(container)
      applyPopupChunkFades(container, fadeState.current)
      window.dispatchEvent(new CustomEvent('aiAssist:stickToBottom'))
    } else {
      fadeState.current = null
    }
  }, [highlighted, revealed, animating])

  return (
    <pre
      ref={containerRef}
      onScroll={onScroll}
      className={classNames(
        'ai-texgpt-code',
        SYSTEM_CODE_CLASS,
        { 'is-streaming': animating },
        className
      )}
    />
  )
}

/**
 * Markdown answer with streaming reveal and chunk fade animation.
 */
export const StreamingMarkdownAnswer: FC<{
  text: string
  isLive?: boolean
  className?: string
}> = ({ text, isLive = true, className }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const { text: revealed, animating } = useStreamReveal(text, isLive)
  const fadeState = useRef<PopupFadeState | null>(null)
  useSystemHighlightStyle()

  const html = useMemo(() => {
    return renderMarkdown(revealed, undefined, undefined, {
      codeClass: SYSTEM_CODE_CLASS,
    })
  }, [revealed])

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return

    reconcilePopupContainerHtml(container, html)

    if (animating) {
      fadeState.current ??= createPopupFadeState(container)
      applyPopupChunkFades(container, fadeState.current)
      window.dispatchEvent(new CustomEvent('aiAssist:stickToBottom'))
    } else {
      fadeState.current = null
    }
  }, [html, animating])

  return (
    <div
      ref={containerRef}
      className={classNames(
        'ai-assist-markdown',
        'ai-texgpt-answer',
        { 'is-streaming': animating },
        className
      )}
    />
  )
}

/**
 * Streaming options list with fade animation.
 */
export const StreamingOptions: FC<{
  options: string[]
  isLive?: boolean
  className?: string
}> = ({ options, isLive = true, className }) => {
  useLayoutEffect(() => {
    if (isLive) {
      window.dispatchEvent(new CustomEvent('aiAssist:stickToBottom'))
    }
  }, [options, isLive])

  return (
    <ul className={classNames('ai-texgpt-streaming-options', className)}>
      {options.map(option => (
        <li
          key={option}
          className={classNames({ 'ai-assist-stream-fade': isLive })}
        >
          {option}
        </li>
      ))}
    </ul>
  )
}
