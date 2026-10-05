import { STREAM_FADE_MS, MAX_FADE_LEAD_MS } from '../../hooks/use-stream-reveal'

type FadeChunk = { start: number; at: number }
export type FadeState = {
  text: string
  chunks: FadeChunk[]
  /** When each horizontal rule on screen first appeared, in document order. */
  rules: number[]
}

/** Delay between the fades of consecutive words revealed together. */
const WORD_STAGGER_MS = 24

/**
 * Structures that fade in as a whole when they first appear, so their frame
 * (borders, backgrounds, bullets) arrives together with their first words.
 * Text added to them afterwards still fades in word by word like any other.
 */
const FADE_UNIT_SELECTOR = [
  '.ai-assist-table-wrapper',
  '.ai-assist-code-block',
  '.ai-assist-thinking-code-block',
  'blockquote',
  'tr',
  'li',
  '.katex',
  '.ai-assist-citation',
].join(', ')
/** Structures whose text must not be split into spans. */
const ATOMIC_SELECTOR = '.katex, button, svg, .ai-assist-citation'

export function createFadeState(container?: HTMLElement | null): FadeState {
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

/**
 * Fades in whatever a streaming render added since the previous one. The
 * rendered text is compared with what was on screen before: everything after
 * the common prefix is new, and each of its words is a chunk that fades in a
 * moment after the one before. Chunks still inside their fade window are
 * re-applied after every render with a negative animation delay, so replacing
 * the markup never restarts a fade that is already under way.
 *
 * Structures with a frame of their own (tables, rows, code blocks, quotes,
 * list items, formulas, rules) fade in whole along with their first word; any
 * later word inside them gets its own fade.
 */
export function applyChunkFades(container: HTMLElement, state: FadeState) {
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

    // Chunks of the enclosing structures that are fading in whole
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

    // Wrap each part of the node that belongs to a chunk still fading, unless
    // an enclosing structure is already fading that very chunk
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

/** Rules have no text to anchor a chunk to, so they are tracked by position. */
function fadeRules(
  container: HTMLElement,
  state: FadeState,
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
