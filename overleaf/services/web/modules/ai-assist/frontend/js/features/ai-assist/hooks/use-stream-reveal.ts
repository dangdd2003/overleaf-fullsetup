import { useEffect, useRef, useState } from 'react'

/**
 * How far behind the stream the reveal runs. The reveal speed is the backlog
 * divided by this, so a steady stream is shown at its own speed and a burst
 * is spread over roughly this long instead of landing at once.
 */
const TARGET_LAG_SEC = 0.4
/** Floor while streaming, so the tail of a burst doesn't crawl. */
const MIN_LIVE_CHARS_PER_SEC = 40
/** Once the stream has ended, whatever is left drains at least this fast. */
const MIN_DRAIN_CHARS_PER_SEC = 300
/** A run of text without whitespace longer than this is revealed mid-word. */
const MAX_WORD_CHARS = 24
/** Must match the duration of the `ai-assist-stream-fade` animation. */
export const STREAM_FADE_MS = 400

const FENCE_LINE = /^\s{0,3}(```|~~~)/
const PARTIAL_FENCE_CLOSE = /^\s{0,3}[`~]{1,3}$/
const TABLE_LINE = /^\s*\|/
const MARKER_ONLY_LINE = /^\s*(?:[-*+>]|\d+[.)]|#{1,6})?\s*$/
// Same environments the markdown renderer draws as display math
const DISPLAY_MATH_OPEN =
  /\$\$|\\\[|\\begin\{((?:equation|align|alignat|gather|multline|matrix|pmatrix|bmatrix|vmatrix|Vmatrix|cases|aligned|gathered)\*?)\}/g

function lineStartBefore(text: string, pos: number) {
  return text.lastIndexOf('\n', pos - 1) + 1
}

/** [start, end) ranges covered by fenced code blocks, open ones included. */
function fencedRanges(text: string) {
  const ranges: [number, number][] = []
  let openAt = -1
  let lineStart = 0
  while (lineStart <= text.length) {
    const lineEnd = text.indexOf('\n', lineStart)
    const end = lineEnd === -1 ? text.length : lineEnd
    if (FENCE_LINE.test(text.slice(lineStart, end))) {
      if (openAt === -1) {
        openAt = lineStart
      } else {
        ranges.push([openAt, end])
        openAt = -1
      }
    }
    if (lineEnd === -1) break
    lineStart = lineEnd + 1
  }
  if (openAt !== -1) ranges.push([openAt, Infinity])
  return ranges
}

function inRanges(ranges: [number, number][], pos: number) {
  return ranges.some(([start, end]) => pos > start && pos <= end)
}

/** Start of a display-math block that is still open at the end, or -1. */
function openDisplayMathStart(head: string, fenced: [number, number][]) {
  DISPLAY_MATH_OPEN.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = DISPLAY_MATH_OPEN.exec(head))) {
    if (inRanges(fenced, m.index)) continue
    const closer =
      m[0] === '$$' ? '$$' : m[0] === '\\[' ? '\\]' : `\\end{${m[1]}}`
    const close = head.indexOf(closer, m.index + m[0].length)
    if (close === -1) return m.index
    DISPLAY_MATH_OPEN.lastIndex = close + closer.length
  }
  return -1
}

/** Offset of an inline marker left unclosed in `line`, or -1. */
function unclosedInlineStart(line: string) {
  let cut = -1
  for (const marker of ['**', '`', '$']) {
    const positions: number[] = []
    for (let i = 0; i < line.length; i++) {
      if (line[i - 1] === '\\' || !line.startsWith(marker, i)) continue
      if (marker !== '**' && (line[i + 1] === marker || line[i - 1] === marker))
        continue
      positions.push(i)
      i += marker.length - 1
    }
    if (positions.length % 2 === 0) continue
    const last = positions[positions.length - 1]
    // `$10` style currency is not math
    if (marker === '$' && /^\$\d/.test(line.slice(last))) continue
    cut = cut === -1 ? last : Math.min(cut, last)
  }
  return cut
}

/**
 * Start of a trailing table that can't render yet because its delimiter row
 * isn't complete, or -1. Until then marked would draw it as a paragraph of
 * pipes.
 */
function unrenderedTableStart(head: string) {
  const complete = head.endsWith('\n')
  const lines = head.split('\n')
  if (complete) lines.pop()
  let count = 0
  while (count < lines.length && TABLE_LINE.test(lines[lines.length - 1 - count]))
    count++
  if (count === 0 || (complete ? count : count - 1) >= 2) return -1
  const before = lines.slice(0, lines.length - count)
  return before.length ? before.join('\n').length + 1 : 0
}

/**
 * Moves `end` back so the revealed text never stops half-way through
 * something the markdown renderer draws differently once it is complete: an
 * open display-math block, a table without its delimiter row, a partial
 * fence line, a bare list or heading marker, or an unclosed inline `**`,
 * `` ` `` or `$`.
 */
export function holdBackIncomplete(text: string, end: number) {
  const fenced = fencedRanges(text.slice(0, end))

  const mathStart = openDisplayMathStart(text.slice(0, end), fenced)
  if (mathStart !== -1) end = mathStart

  const lineStart = lineStartBefore(text, end)
  if (lineStart < end) {
    const line = text.slice(lineStart, end)
    if (inRanges(fenced, lineStart)) {
      if (PARTIAL_FENCE_CLOSE.test(line)) end = lineStart
    } else if (FENCE_LINE.test(line) || MARKER_ONLY_LINE.test(line)) {
      end = lineStart
    } else {
      const inline = unclosedInlineStart(line)
      if (inline !== -1) end = lineStart + inline
    }
  }

  const tableStart = unrenderedTableStart(text.slice(0, end))
  if (tableStart !== -1) end = tableStart

  return end
}

function lastWordBreak(text: string, from: number, limit: number) {
  for (let i = limit; i > from; i--) {
    if (/\s/.test(text[i - 1])) return i
  }
  return -1
}

function commonPrefixLength(a: string, b: string) {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

/**
 * Decouples what is on screen from how the stream arrives. Incoming text is
 * buffered and revealed a word at a time on every animation frame, at a speed
 * proportional to the backlog, so network bursts and pauses come out as one
 * even flow a fraction of a second behind the stream. Text is only revealed
 * once the markdown around it renders in its final shape.
 *
 * A message that is not live when it mounts (history) is never animated.
 */
export function useStreamReveal(content: string, isLive: boolean) {
  const [shown, setShown] = useState(() => (isLive ? '' : content))
  const [settled, setSettled] = useState(!isLive)

  const contentRef = useRef(content)
  contentRef.current = content
  const liveRef = useRef(isLive)
  liveRef.current = isLive
  const shownRef = useRef(shown)

  // A finished message that starts streaming again only animates what's new
  useEffect(() => {
    if (isLive && settled) {
      shownRef.current = contentRef.current
      setShown(contentRef.current)
      setSettled(false)
    }
  }, [isLive, settled])

  useEffect(() => {
    if (settled) return

    let frame = 0
    let settleTimer = 0
    let last = 0
    let budget = 0

    const step = (now: number) => {
      frame = window.requestAnimationFrame(step)

      const target = contentRef.current
      const from = commonPrefixLength(shownRef.current, target)
      const done = !liveRef.current
      const backlog = target.length - from

      if (backlog === 0) {
        last = budget = 0
        if (from < shownRef.current.length) {
          shownRef.current = target
          setShown(target)
        }
        if (done) {
          window.cancelAnimationFrame(frame)
          settleTimer = window.setTimeout(
            () => setSettled(true),
            STREAM_FADE_MS
          )
        }
        return
      }

      const dt = last ? Math.min(now - last, 100) : 16
      last = now
      const rate = Math.max(
        done ? MIN_DRAIN_CHARS_PER_SEC : MIN_LIVE_CHARS_PER_SEC,
        backlog / TARGET_LAG_SEC
      )
      budget = Math.min(budget + (rate * dt) / 1000, backlog)

      const limit = from + Math.floor(budget)
      let end = done && limit === target.length ? limit : -1
      if (end === -1) end = lastWordBreak(target, from, limit)
      if (end === -1 && limit - from >= MAX_WORD_CHARS) end = limit
      if (end !== -1 && !(done && end === target.length)) {
        end = holdBackIncomplete(target, end)
      }

      const moved = end > from
      if (!moved && from === shownRef.current.length) return

      const next = target.slice(0, moved ? end : from)
      budget = Math.max(0, budget - (next.length - from))
      shownRef.current = next
      setShown(next)
    }

    frame = window.requestAnimationFrame(step)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(settleTimer)
    }
  }, [settled, isLive])

  return settled
    ? { text: content, animating: false }
    : { text: shown, animating: true }
}
