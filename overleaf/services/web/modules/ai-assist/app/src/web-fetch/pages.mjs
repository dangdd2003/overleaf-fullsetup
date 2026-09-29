import { closesFence, fenceMarker } from './extract/markdown-clean.mjs'
import { clip, collapse } from './util.mjs'

/**
 * A document's pages, sized to the model reading it. Everything here is one
 * pass over the text, so it runs in a worker for a large document (see
 * doc-index.mjs) and costs the same for page 1 or page 10,000.
 */

/** About 3k tokens: the page size when the model's context window is unknown. */
export const PAGE_CHARS = 12_000
const MIN_PAGE_CHARS = 4000
const MAX_PAGE_CHARS = 24_000
const MAX_OUTLINE_ENTRIES = 30
const MAX_OUTLINE_CHARS = 1200
const HEADING_LINE = /^#{1,6} \S/

/**
 * Characters per page for a model with `contextWindow` tokens: about 8% of
 * the window at 4 characters a token, between 4,000 and 24,000.
 */
export function pageCharsFor(contextWindow) {
  const tokens = Number(contextWindow)
  if (!Number.isFinite(tokens) || tokens <= 0) return PAGE_CHARS
  return Math.min(
    MAX_PAGE_CHARS,
    Math.max(MIN_PAGE_CHARS, Math.round(tokens * 4 * 0.08))
  )
}

/**
 * Every line with where it ends, and whether a page may end right after it:
 * never inside a fenced code block, never between two table rows.
 */
function lineMap(text) {
  const lines = []
  let offset = 0
  let fence = null
  for (const line of text.split('\n')) {
    const start = offset
    offset += line.length + 1
    if (fence) {
      if (closesFence(fence, line)) fence = null
    } else {
      fence = fenceMarker(line)
    }
    lines.push({
      text: line,
      end: start + line.length,
      fenceOpen: fence !== null,
      table: fence === null && line.startsWith('|'),
    })
  }
  return lines
}

/**
 * Where the page starting at `pos` should end, at most `size` characters on.
 * `first` is the first line ending at or after `pos`, so each page scans only
 * its own lines and a long document splits in linear time.
 */
function chooseCut(lines, first, pos, size) {
  const limit = pos + size
  const earliest = pos + Math.floor(size * 0.6)
  let heading = -1
  let paragraph = -1
  let line = -1
  let anyLine = -1
  for (let i = first; i < lines.length; i++) {
    const { end } = lines[i]
    if (end > limit) break
    if (end < earliest) continue
    const next = lines[i + 1]
    anyLine = end
    const safe = !lines[i].fenceOpen && !(lines[i].table && next?.table)
    if (!safe || !lines[i].text.trim()) continue
    line = end
    if (next && !next.text.trim()) {
      paragraph = end
      if (HEADING_LINE.test(lines[i + 2]?.text ?? '')) heading = end
    }
  }
  for (const cut of [heading, paragraph, line, anyLine]) {
    if (cut > pos) return cut
  }
  return limit
}

export function splitPages(text, size = PAGE_CHARS) {
  const starts = [0]
  if (text.length <= size) return starts
  const lines = lineMap(text)
  let pos = 0
  let first = 0
  while (text.length - pos > size) {
    while (first < lines.length && lines[first].end < pos) first++
    pos = chooseCut(lines, first, pos, size)
    while (text[pos] === '\n') pos++
    if (pos >= text.length) break
    starts.push(pos)
  }
  return starts
}

/**
 * The fence open at each of `offsets` (its opening line) and the table
 * header rows around it, in one pass. `offsets` must be ascending.
 */
function openStructures(text, offsets) {
  const states = []
  let fence = null
  let table = null
  let pos = 0
  for (const offset of offsets) {
    while (pos < offset) {
      let newline = text.indexOf('\n', pos)
      if (newline === -1) newline = text.length
      const line = text.slice(pos, newline)
      pos = newline + 1
      if (fence) {
        if (closesFence(fence.marker, line)) fence = null
        continue
      }
      const marker = fenceMarker(line)
      if (marker) {
        fence = { opener: line.trim(), marker }
        table = null
        continue
      }
      if (line.startsWith('|')) {
        if (!table) table = [line]
        else if (table.length === 1) table.push(line)
      } else {
        table = null
      }
    }
    states.push({ fence, table: table?.length === 2 ? [...table] : null })
  }
  return states
}

/**
 * One page of the document. A page cut inside a code block gets the fence
 * re-opened at its start and closed at its end; a page that starts inside a
 * table gets the table's header rows again. `doc.open`, from pageMap, holds
 * the structure open at each page start; without it, it is worked out here.
 */
export function pageText(doc, page) {
  const start = doc.pages[page - 1]
  const end = doc.pages[page] ?? doc.text.length
  let body = doc.text.slice(start, end).trimEnd()
  const [before, after] = doc.open
    ? [doc.open[page - 1], doc.open[page]]
    : openStructures(doc.text, page < doc.pages.length ? [start, end] : [start])
  if (before?.fence) {
    body = `${before.fence.opener}\n${body}`
  } else if (before?.table && body.startsWith('|')) {
    body = `${before.table.join('\n')}\n${body}`
  }
  if (page < doc.pages.length && after?.fence) {
    body = `${body}\n${after.fence.marker}`
  }
  return body
}

/** The page `offset` falls on, 1-based. */
export function pageOf(pages, offset) {
  let low = 0
  let high = pages.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (pages[mid] <= offset) low = mid
    else high = mid - 1
  }
  return low + 1
}

function outlineFits(entries) {
  return (
    entries.length <= MAX_OUTLINE_ENTRIES &&
    entries.reduce((sum, entry) => sum + entry.title.length + 8, 0) <=
      MAX_OUTLINE_CHARS
  )
}

/**
 * The ## and ### headings of the document, each with the page it starts on.
 * When they do not all fit, the ## headings alone; when those do not fit
 * either, ## headings spread evenly over the whole document, so the contents
 * of a long document reach its last page.
 */
export function outline(text, pages) {
  const entries = []
  let offset = 0
  let fence = null
  for (const line of text.split('\n')) {
    const at = offset
    offset += line.length + 1
    if (fence) {
      if (closesFence(fence, line)) fence = null
      continue
    }
    const marker = fenceMarker(line)
    if (marker) {
      fence = marker
      continue
    }
    const heading = /^(#{2,3}) (\S.*)$/.exec(line)
    if (!heading) continue
    const title = clip(
      collapse(heading[2].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')),
      80
    )
    entries.push({ level: heading[1].length, title, page: pageOf(pages, at) })
  }
  if (outlineFits(entries)) return entries
  const top = entries.filter(entry => entry.level === 2)
  const pool = top.length >= 2 ? top : entries
  if (outlineFits(pool)) return pool
  for (
    let count = Math.min(pool.length, MAX_OUTLINE_ENTRIES);
    count > 1;
    count--
  ) {
    const spread = Array.from(
      { length: count },
      (_, i) => pool[Math.round((i * (pool.length - 1)) / (count - 1))]
    )
    if (outlineFits(spread)) return spread
  }
  return pool.slice(0, 1)
}

/**
 * Everything paging needs for pages of `size`: where each starts, the
 * structure open at each start, and the contents. Computed once per size.
 */
export function pageMap(text, size) {
  const starts = splitPages(text, size)
  return {
    size,
    starts,
    open: openStructures(text, starts),
    outline: starts.length > 1 ? outline(text, starts) : [],
  }
}
