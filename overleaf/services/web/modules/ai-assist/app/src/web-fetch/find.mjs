import { closesFence, fenceMarker } from './extract/markdown-clean.mjs'
import {
  blocksOf,
  countOf,
  occurrences,
  searchText,
  termPattern,
  termsOf,
} from './blocks.mjs'
import { pageOf, splitPages } from './pages.mjs'
import { clip, collapse } from './util.mjs'

/**
 * web_fetch's `find`: the passages of a document that answer a search, the
 * most relevant first, each with the section it sits in and its page.
 *
 * Matching ignores what a page's Markdown adds and a model's query leaves
 * out (see searchText). The phrase as written ranks first. When no passage
 * has it, passages holding every word of it come back, then passages holding
 * most of them, each flagged, so the model knows how close the match is.
 *
 * Where the matches come from is a source: a scan of the text for a short
 * document, or a full-text index built once for a long one (doc-index.mjs),
 * so a search costs the same in a page or in a gigabyte. Either way a passage
 * is cut around its match, not from the start of its block: a long paragraph
 * is windowed on the matching line, a table keeps its header row and the
 * matching rows, a code block keeps its fences, a short match brings its
 * neighbours, and a matching heading brings the start of its section.
 */

const MAX_MATCHES = 12
const MAX_ALTERNATIVES = 5
const MAX_LISTED_PAGES = 40
/** A passage shorter than this share of its size takes in its neighbours. */
const FILL_SHARE = 0.4
const LEVELS = ['exact', 'all words', 'some words']

/**
 * What a block's shape adds to its score: a heading, or a section named
 * after the phrase, is about it; so is a block that repeats it verbatim.
 */
export function shapeBoost(block, phrase, view) {
  let boost = 0
  if (block.kind === 'heading') boost += 3
  else if (
    phrase &&
    searchText(block.path[block.path.length - 1] ?? '').includes(phrase)
  ) {
    boost += 1
  }
  if (phrase) boost += Math.min(3, occurrences(view, phrase))
  return boost
}

/** How few of a query's words still make a partial match. */
export function partialThreshold(count) {
  return count >= 3 ? Math.max(2, Math.ceil(count * 0.6)) : Infinity
}

/** The spellings an alternative is tried as: over-escaped `\\qty` is `\qty`. */
export function spellingsOf(alternative) {
  const display = alternative.replace(/\\\\/g, '\\')
  return [...new Set([display, display.replace(/^\\+/, '')])].filter(Boolean)
}

/** BM25 over the query's words, for a document held in memory. */
function scorer(views, terms) {
  const patterns = terms.map(termPattern)
  const average =
    views.reduce((sum, view) => sum + view.length, 0) /
    Math.max(1, views.length)
  const idf = patterns.map(pattern => {
    let df = 0
    for (const view of views) {
      pattern.lastIndex = 0
      if (pattern.test(view)) df++
    }
    return Math.log(1 + (views.length - df + 0.5) / (df + 0.5))
  })
  return index => {
    const view = views[index]
    const norm = 0.5 + (0.5 * view.length) / Math.max(1, average)
    let score = 0
    patterns.forEach((pattern, t) => {
      const tf = countOf(pattern, view)
      score += (idf[t] * tf * 2.2) / (tf + 1.2 * norm)
    })
    return score
  }
}

/** Matches by scanning every block: for a document short enough to scan. */
export function memorySource(doc) {
  const blocks = blocksOf(doc.text)
  const views = blocks.map(block => searchText(block.text))
  const sections = new Map()
  const pathViews = blocks.map(block => {
    const key = block.path.join('\n')
    if (!sections.has(key)) sections.set(key, searchText(block.path.join(' ')))
    return sections.get(key)
  })

  const search = alternative => {
    for (const spelling of spellingsOf(alternative)) {
      const phrase = searchText(spelling)
      if (!phrase) continue
      const ids = []
      views.forEach((view, index) => {
        if (view.includes(phrase)) ids.push(index)
      })
      if (ids.length > 0) {
        const score = scorer(views, termsOf(phrase))
        const hits = ids.map(index => ({
          index,
          level: 0,
          term: spelling,
          phrase,
          score: score(index) + shapeBoost(blocks[index], phrase, views[index]),
        }))
        return { hits, ids }
      }
    }

    const display = spellingsOf(alternative)[0] ?? ''
    const terms = termsOf(searchText(display))
    if (terms.length < 2) return { hits: [], ids: [] }
    const patterns = terms.map(termPattern)
    const needed = partialThreshold(terms.length)
    const score = scorer(views, terms)
    const hits = []
    views.forEach((view, index) => {
      let inBody = 0
      let covered = 0
      for (const pattern of patterns) {
        pattern.lastIndex = 0
        if (pattern.test(view)) {
          inBody++
          covered++
          continue
        }
        pattern.lastIndex = 0
        if (pattern.test(pathViews[index])) covered++
      }
      if (inBody === 0) return
      const level = covered === terms.length ? 1 : covered >= needed ? 2 : -1
      if (level === -1) return
      hits.push({
        index,
        level,
        term: display,
        terms,
        score: score(index) + covered + shapeBoost(blocks[index], null, view),
      })
    })
    const best = Math.min(...hits.map(hit => hit.level))
    const kept = hits.filter(hit => hit.level === best)
    return { hits: kept, ids: kept.map(hit => hit.index) }
  }

  return {
    count: blocks.length,
    block: index => blocks[index],
    startOf: index => blocks[index].start,
    search,
  }
}

/** The line of `lines` the match is on: the phrase, else the most query words. */
function focusLine(lines, hit) {
  const views = lines.map(searchText)
  if (hit.phrase) {
    const at = views.findIndex(view => view.includes(hit.phrase))
    if (at !== -1) return at
  }
  const patterns = (hit.terms ?? termsOf(hit.phrase ?? '')).map(termPattern)
  let best = 0
  let bestCount = 0
  views.forEach((view, index) => {
    const count = patterns.filter(pattern => {
      pattern.lastIndex = 0
      return pattern.test(view)
    }).length
    if (count > bestCount) {
      best = index
      bestCount = count
    }
  })
  return best
}

/** A window of one long line, centred on the first query word in it. */
function windowOfLine(line, hit, size) {
  const lower = line.toLowerCase()
  const words = hit.phrase ? termsOf(hit.phrase) : (hit.terms ?? [])
  const positions = words
    .map(word => lower.indexOf(word.replace(/^\\+/, '')))
    .filter(at => at !== -1)
  const at = positions.length > 0 ? Math.min(...positions) : 0
  let from = Math.max(0, at - Math.floor(size / 3))
  let to = Math.min(line.length, from + size)
  from = Math.max(0, to - size)
  if (from > 0) from = line.indexOf(' ', from) + 1 || from
  if (to < line.length) {
    const space = line.lastIndexOf(' ', to)
    if (space > from) to = space
  }
  return `${from > 0 ? '…' : ''}${line.slice(from, to).trim()}${to < line.length ? '…' : ''}`
}

function rowMatches(row, hit) {
  const view = searchText(row)
  if (hit.phrase) return view.includes(hit.phrase)
  return (hit.terms ?? []).some(term => termPattern(term).test(view))
}

/** Part of a block too long to show whole, around its match. */
function windowOf(block, hit, size) {
  const lines = block.text.split('\n')
  if (block.kind === 'table' && /^\|?\s*:?-{3,}/.test(lines[1] ?? '')) {
    const rows = []
    let length = lines[0].length + lines[1].length + 2
    for (const row of lines.slice(2)) {
      if (!rowMatches(row, hit) || length + row.length + 1 > size) continue
      rows.push(row)
      length += row.length + 1
    }
    if (rows.length > 0) return [lines[0], lines[1], ...rows].join('\n')
  }

  const fenced = block.kind === 'fence'
  const closed =
    fenced &&
    lines.length > 1 &&
    closesFence(fenceMarker(lines[0]), lines[lines.length - 1])
  const body = fenced ? lines.slice(1, closed ? -1 : undefined) : lines
  if (body.length === 0) return clip(block.text, size)
  const focus = focusLine(body, hit)
  if (body[focus].length > size) return windowOfLine(body[focus], hit, size)
  let from = focus
  let to = focus
  let length = body[focus].length
  for (let grew = true; grew; ) {
    grew = false
    if (to + 1 < body.length && length + body[to + 1].length + 1 <= size) {
      length += body[++to].length + 1
      grew = true
    }
    if (from > 0 && length + body[from - 1].length + 1 <= size) {
      length += body[--from].length + 1
      grew = true
    }
  }
  const shown = body.slice(from, to + 1).join('\n')
  if (fenced) return `${lines[0]}\n${shown}\n${fenceMarker(lines[0])}`
  return `${from > 0 ? '…\n' : ''}${shown}${to < body.length - 1 ? '\n…' : ''}`
}

/**
 * The passage shown for a hit: its block, cut or grown to about `size`.
 * Without `grow` it is the block alone, so it cannot overlap another passage.
 */
function passageFor(source, hit, size, { grow = true } = {}) {
  const index = hit.index
  const block = source.block(index)
  let first = index
  let last = index

  if (block.kind === 'heading' && grow) {
    // The start of the section the heading opens
    let length = block.text.length
    const parts = [block.text]
    for (let i = index + 1; i < source.count; i++) {
      const next = source.block(i)
      if (next.kind === 'heading' && next.level <= block.level) break
      if (length + next.text.length + 2 > size) {
        if (i === index + 1 && size - length > 200) {
          parts.push(
            windowOf(
              next,
              { ...hit, phrase: null, terms: [] },
              size - length - 2
            )
          )
          last = i
        }
        break
      }
      parts.push(next.text)
      length += next.text.length + 2
      last = i
    }
    return { first, last, text: parts.join('\n\n'), path: block.path }
  }

  if (block.text.length > size) {
    return { first, last, text: windowOf(block, hit, size), path: block.path }
  }

  // A short passage takes in the blocks around it in the same section
  const parts = [block.text]
  let length = block.text.length
  const target = grow ? size * FILL_SHARE : 0
  for (let turn = 0; length < target && turn < 8; turn++) {
    const after = turn % 2 === 0
    const at = after ? last + 1 : first - 1
    if (at < 0 || at >= source.count) continue
    const candidate = source.block(at)
    if (candidate.kind === 'heading') continue
    if (length + candidate.text.length + 2 > size) continue
    length += candidate.text.length + 2
    if (after) {
      parts.push(candidate.text)
      last = at
    } else {
      parts.unshift(candidate.text)
      first = at
    }
  }
  return { first, last, text: parts.join('\n\n'), path: block.path }
}

/**
 * Passages of `doc` for `find`: a phrase or words, or alternatives separated
 * by " | " (a bar without spaces is text, as in `\left|`). At most `budget`
 * characters of passages come back, in document order. `pages` are the page
 * starts the model reads the document by.
 */
export function findPassages(
  doc,
  find,
  { budget = 12_000, source, pages } = {}
) {
  const from = source ?? memorySource(doc)
  const starts = pages ?? doc.pages ?? splitPages(doc.text)
  const term = collapse(find)
  const alternatives = term
    .split(/\s+\|\s+/)
    .filter(Boolean)
    .slice(0, MAX_ALTERNATIVES)

  const best = new Map()
  const all = new Set()
  const found = []
  for (const alternative of alternatives) {
    const { hits, ids } = from.search(alternative)
    if (hits.length > 0 && !found.includes(hits[0].term))
      found.push(hits[0].term)
    for (const id of ids) all.add(id)
    for (const hit of hits) {
      const kept = best.get(hit.index)
      if (
        !kept ||
        hit.level < kept.level ||
        (hit.level === kept.level && hit.score > kept.score)
      ) {
        best.set(hit.index, hit)
      }
    }
  }
  if (all.size === 0) return { matches: [], total: 0, term, pages: [] }

  const ranked = [...best.values()].sort(
    (a, b) => a.level - b.level || b.score - a.score || a.index - b.index
  )
  const size = Math.min(2500, Math.max(1000, Math.round(budget / 8)))
  const chosen = []
  const overlaps = (first, last) =>
    chosen.some(passage => first <= passage.last && last >= passage.first)
  let used = 0
  for (const hit of ranked) {
    if (chosen.length >= MAX_MATCHES) break
    if (overlaps(hit.index, hit.index)) continue
    let passage = passageFor(from, hit, size)
    if (overlaps(passage.first, passage.last)) {
      passage = passageFor(from, hit, size, { grow: false })
    }
    if (used + passage.text.length > budget) continue
    used += passage.text.length
    chosen.push({ ...passage, hit })
  }
  chosen.sort((a, b) => a.first - b.first)

  // The pages that hold matches, first to last, for the model to read on.
  // Blocks are numbered in document order, so after each page the next is
  // found by bisection: a few lookups per page, however many matches.
  const startOf = from.startOf ?? (index => from.block(index).start)
  const sorted = [...all].sort((a, b) => a - b)
  const listed = []
  for (let i = 0; i < sorted.length && listed.length < MAX_LISTED_PAGES; ) {
    const page = pageOf(starts, startOf(sorted[i]))
    listed.push(page)
    if (page >= starts.length) break
    let low = i + 1
    let high = sorted.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (startOf(sorted[mid]) < starts[page]) low = mid + 1
      else high = mid
    }
    i = low
  }

  return {
    matches: chosen.map(passage => ({
      page: pageOf(starts, from.block(passage.first).start),
      ...(passage.path.length > 0 ? { heading: passage.path.join(' › ') } : {}),
      text: passage.text,
      ...(passage.hit.level > 0 ? { match: LEVELS[passage.hit.level] } : {}),
    })),
    total: all.size,
    term: found.join(' | '),
    pages: listed,
  }
}
