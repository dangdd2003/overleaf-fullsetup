// The text of a compiled PDF as a reader sees it: macros expanded, \ref and
// \cite resolved, section and equation numbers in place, ligatures as plain
// letters. None of that is in the .tex, so a search of the source for "Table
// 1" or "Smith et al." misses what the page prints, and a model that cannot
// take images has no other way to read a page.
//
// pdftotext -bbox-layout gives every word with its box. A page's words are
// joined into one string, so a query can run across a line break and a word
// hyphenated at a line end still matches. A match maps back to the boxes it
// covers and to a point on the page, which the caller hands to SyncTeX to find
// its source line. The same string shows what LaTeX could not resolve: "??"
// where a \ref has no label and "[?]" where a \cite has no entry.
//
// Pure text in, text out: the caller runs pdftotext and SyncTeX, so this module
// needs neither a process nor a file to be tested.

const SOFT_HYPHEN = '­'
const SOFT_HYPHEN_RE = /­/g
const SOFT_HYPHEN_OPTIONAL = '\\u00ad?'
const CONTEXT_CHARS = 60
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g
const NON_ASCII = /[\u0080-￿]/
const ENTITY = /&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos));/g
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
// A word at a line end that ends in a hyphen, followed by a line that goes on
// in lowercase, is a word TeX broke: the hyphen goes and the halves join. A
// hyphen followed by anything else is part of the word ("COVID-" then "19"),
// so it stays and the lines join with no space, as TeX sets them.
const ENDS_IN_HYPHEN = /\p{L}-$/u
const STARTS_LOWERCASE = /^\p{Ll}/u
const UNRESOLVED_REF = /\?{2,}/g
const UNRESOLVED_CITE = /\[\?(?:\s*,\s*\?)*\]/g

const joinedPages = new WeakMap()

/** The value of a numeric attribute, or 0 when the tag does not carry it. */
// Least and greatest of `pick` over the items. Written as loops: spreading a
// long list into Math.min or Math.max runs out of stack on a very wide line.
export function minOf(items, pick) {
  let best = Infinity
  for (const item of items) best = Math.min(best, pick(item))
  return best
}

export function maxOf(items, pick) {
  let best = -Infinity
  for (const item of items) best = Math.max(best, pick(item))
  return best
}

function numberAttr(attrs, key) {
  const start = attrs.indexOf(key)
  if (start < 0) return 0
  const from = start + key.length
  return parseFloat(attrs.slice(from, attrs.indexOf('"', from))) || 0
}

function boxAttrs(attrs) {
  return {
    xMin: numberAttr(attrs, ' xMin="'),
    yMin: numberAttr(attrs, ' yMin="'),
    xMax: numberAttr(attrs, ' xMax="'),
    yMax: numberAttr(attrs, ' yMax="'),
  }
}

function decodeEntity(match, hex, decimal, name) {
  if (name) return NAMED_ENTITIES[name]
  const code = hex ? parseInt(hex, 16) : parseInt(decimal, 10)
  return code <= 0x10ffff ? String.fromCodePoint(code) : match
}

/**
 * The text of a word as a reader reads it. Compatibility forms are folded
 * here, so "ﬁ" is searched and shown as "fi".
 */
function decodeText(raw) {
  const text = raw.includes('&') ? raw.replace(ENTITY, decodeEntity) : raw
  // ASCII is unchanged by NFKC, and most words are ASCII.
  return NON_ASCII.test(text) ? text.normalize('NFKC') : text
}

/**
 * Pages of a `pdftotext -bbox-layout` document, in document order. Coordinates
 * are points from the top left, as pdftotext writes them.
 *
 * A page is `{ width, height, lines, blocks }`. A line is `{ text, xMin, yMin,
 * xMax, yMax, words, blockEnd }`, where `text` joins its words with a space and
 * `blockEnd` marks the last line of its block, which is where a paragraph
 * ends. A word is `{ text, xMin, yMin, xMax, yMax }`. A block is `{ xMin, yMin,
 * xMax, yMax, lines }` with the same line objects as `lines`, in order.
 *
 * @param {string} html
 * @returns {Array<{width: number, height: number, lines: Array<object>}>}
 */
export function parseBboxLayout(html) {
  const text = String(html ?? '')
  const pages = []
  // A scan over every tag, with the text up to the next tag: the text after a
  // <word> tag is the word. XML escaping keeps '<' out of that text, so the
  // scan never has to look inside a word.
  const tag = /<(\/?)(page|block|line|word)\b([^>]*)>([^<]*)/g
  let page = null
  let line = null
  let block = null
  let blockStart = 0
  for (let m = tag.exec(text); m; m = tag.exec(text)) {
    const [, closing, name, attrs, body] = m
    if (closing) {
      if (name === 'line' && line) {
        line.text = line.words.map(word => word.text).join(' ')
        // A line with no box of its own takes the extent of its words.
        if (
          line.words.length > 0 &&
          !(line.xMax > line.xMin && line.yMax > line.yMin)
        ) {
          line.xMin = minOf(line.words, word => word.xMin)
          line.yMin = minOf(line.words, word => word.yMin)
          line.xMax = maxOf(line.words, word => word.xMax)
          line.yMax = maxOf(line.words, word => word.yMax)
        }
        line = null
      } else if (name === 'block' && page && page.lines.length > blockStart) {
        page.lines[page.lines.length - 1].blockEnd = true
        block = null
      } else if (name === 'block') {
        block = null
      } else if (name === 'page') {
        page = null
      }
    } else if (name === 'page') {
      page = {
        width: numberAttr(attrs, ' width="'),
        height: numberAttr(attrs, ' height="'),
        lines: [],
        blocks: [],
      }
      pages.push(page)
    } else if (name === 'block') {
      blockStart = page ? page.lines.length : 0
      block = { ...boxAttrs(attrs), lines: [] }
      if (page) page.blocks.push(block)
    } else if (name === 'line' && page) {
      line = { text: '', ...boxAttrs(attrs), words: [], blockEnd: false }
      page.lines.push(line)
      if (block) block.lines.push(line)
    } else if (name === 'word' && line) {
      line.words.push({ text: decodeText(body), ...boxAttrs(attrs) })
    }
  }
  return pages
}

/**
 * The page text as one string, and for each character the index of the word
 * it belongs to. Words in a line are joined by a space. At a line end inside a
 * block: a hyphen after a letter with the next line in lowercase becomes a soft
 * hyphen (the hyphen is dropped); any other hyphen after a letter stays and
 * joins with nothing; a line ending in anything else joins with a space.
 * Blocks are separated by a newline. A separator maps to the word before it.
 */
function joinPage(page) {
  let joined = joinedPages.get(page)
  if (joined) return joined
  const lines = page.lines.filter(line => line.words.length > 0)
  const words = []
  const parts = []
  const partWord = []
  for (let i = 0; i < lines.length; i++) {
    const { words: lineWords, blockEnd } = lines[i]
    const next = lines[i + 1]
    const last = lineWords.length - 1
    let lineEnd = ''
    let hyphenated = false
    if (next) {
      const hyphen = ENDS_IN_HYPHEN.test(lineWords[last].text)
      if (blockEnd) lineEnd = '\n'
      else if (hyphen && STARTS_LOWERCASE.test(next.words[0].text)) {
        lineEnd = SOFT_HYPHEN
        hyphenated = true
      } else if (!hyphen) lineEnd = ' '
    }
    for (let j = 0; j < lineWords.length; j++) {
      const index = words.length
      const word = lineWords[j]
      words.push(word)
      const isLast = j === last
      const text = isLast && hyphenated ? word.text.slice(0, -1) : word.text
      parts.push(text, isLast ? lineEnd : ' ')
      partWord.push(index, index)
    }
  }
  const text = parts.join('')
  const owner = new Int32Array(text.length)
  let at = 0
  for (let k = 0; k < parts.length; k++) {
    owner.fill(partWord[k], at, at + parts[k].length)
    at += parts[k].length
  }
  joined = { text, owner, words }
  joinedPages.set(page, joined)
  return joined
}

/**
 * Up to CONTEXT_CHARS of page text either side of a match, tidied for a
 * reader, with '…' where the page text goes on past it.
 */
function contextAround(text, start, end) {
  const from = Math.max(0, start - CONTEXT_CHARS)
  const to = Math.min(text.length, end + CONTEXT_CHARS)
  const body = text
    .slice(from, to)
    .replace(SOFT_HYPHEN_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
  return `${from > 0 ? '…' : ''}${body}${to < text.length ? '…' : ''}`
}

function matchAt(text, owner, words, start, end, matched) {
  const first = owner[start]
  const last = owner[end - 1]
  let xMin = Infinity
  let yMin = Infinity
  let xMax = -Infinity
  let yMax = -Infinity
  for (let i = first; i <= last; i++) {
    const word = words[i]
    if (word.xMin < xMin) xMin = word.xMin
    if (word.yMin < yMin) yMin = word.yMin
    if (word.xMax > xMax) xMax = word.xMax
    if (word.yMax > yMax) yMax = word.yMax
  }
  const head = words[first]
  return {
    text: matched.replace(SOFT_HYPHEN_RE, ''),
    context: contextAround(text, start, end),
    xMin,
    yMin,
    xMax,
    yMax,
    anchor: {
      x: (head.xMin + head.xMax) / 2,
      y: (head.yMin + head.yMax) / 2,
    },
  }
}

/** One character of a query as a pattern. '-' also matches a soft hyphen. */
function escapeChar(char) {
  return char === '-' ? '[-\\u00ad]' : char.replace(REGEX_SPECIAL, '\\$&')
}

/**
 * A RegExp that finds `query` as plain text, or null when the query is blank.
 * Case is ignored unless `caseSensitive`. Any run of whitespace in the query
 * matches any run of whitespace in the page, line breaks included. A soft
 * hyphen may sit between any two characters, so a word hyphenated at a line
 * end still matches whole, and a hyphen in the query matches either kind.
 *
 * @param {string} query
 * @param {{caseSensitive?: boolean}} [options]
 * @returns {RegExp|null}
 */
export function compileQuery(query, { caseSensitive = false } = {}) {
  const plain = String(query ?? '')
    .normalize('NFKC')
    .replace(SOFT_HYPHEN_RE, '')
    .trim()
  if (!plain) return null
  const pattern = plain
    .split(/\s+/)
    .map(word => Array.from(word, escapeChar).join(SOFT_HYPHEN_OPTIONAL))
    .join('\\s+')
  return new RegExp(pattern, caseSensitive ? 'gu' : 'giu')
}

/**
 * Every match of `regex` on a page, in reading order. A match carries its
 * text (soft hyphens removed), the text around it, the union box of the words
 * it touches, and the centre of its first word, which the caller passes to
 * SyncTeX. A null regex, from a blank query, matches nothing.
 *
 * @param {object} page
 * @param {RegExp|null} regex
 * @returns {Array<{text: string, context: string, xMin: number, yMin: number,
 *   xMax: number, yMax: number, anchor: {x: number, y: number}}>}
 */
export function searchPage(page, regex) {
  const found = []
  if (!regex) return found
  const { text, owner, words } = joinPage(page)
  const re = regex.global ? regex : new RegExp(regex.source, `${regex.flags}g`)
  re.lastIndex = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = m.index
    const end = start + m[0].length
    if (end === start) {
      // Stepping past a zero-length match is what keeps the loop from stalling.
      re.lastIndex = start + (text.codePointAt(start) > 0xffff ? 2 : 1)
      continue
    }
    found.push(matchAt(text, owner, words, start, end, m[0]))
  }
  re.lastIndex = 0
  return found
}

/**
 * The lines of a page from the top, for a reader that sees only text. `y` is
 * the line's position as a percentage of the page height.
 *
 * @param {object} page
 * @returns {{lines: Array<{y: number, text: string}>}}
 */
export function pageLines(page) {
  return {
    lines: page.lines.map(line => ({
      y: Math.round((100 * ((line.yMin + line.yMax) / 2)) / page.height),
      text: line.text,
    })),
  }
}

/**
 * How many references and citations on a page LaTeX could not resolve. An
 * undefined \ref prints "??", and a run of question marks counts once. An
 * undefined \cite with numeric styles prints "[?]", or "[?, ?]" for several
 * keys, which counts once.
 *
 * @param {object} page
 * @returns {{refs: number, cites: number}}
 */
export function unresolvedMarkers(page) {
  const { text } = joinPage(page)
  return {
    refs: (text.match(UNRESOLVED_REF) ?? []).length,
    cites: (text.match(UNRESOLVED_CITE) ?? []).length,
  }
}

// A gutter is a stretch of the page that no row of words reaches. Words in a
// line never leave a gap, so a two-column gutter (about 10pt) is under 2% of an
// A4 width: GUTTER_SHARE is the least gutter that splits the page.
const GUTTER_SHARE = 0.01
// A column is a run of text at least this share of the width, with a few lines.
const COLUMN_SHARE = 0.12
const COLUMN_MIN_ROWS = 3
// A point is text when at least this share of the text rows reach it: a
// heading or a float across the page covers the gutter in its own row only.
const ROW_SHARE = 0.2
const MAX_COLUMN_BINS = 14401

/**
 * The text columns of a page, left to right, found from where its words reach
 * row by row. Two columns need a gutter that (nearly) no row crosses and at
 * least COLUMN_MIN_ROWS rows of words in each. Anything else is one column
 * spanning the body. Each column is `{ left, right, top, bottom, lines }` in
 * points, from its own words. Empty when the page has no text.
 *
 * pdftotext joins the words of two columns that share a baseline into one line,
 * so the columns are read from the words, and splitByColumns cuts the lines.
 *
 * @param {object} page a page from parseBboxLayout
 * @returns {Array<{left: number, right: number, top: number, bottom: number, lines: number}>}
 */
export function pageColumns(page) {
  const lines = (page?.lines ?? []).filter(line => line.words.length > 0)
  if (lines.length === 0) return []
  const span = (group, count) => ({
    left: minOf(group, word => word.xMin),
    right: maxOf(group, word => word.xMax),
    top: minOf(group, word => word.yMin),
    bottom: maxOf(group, word => word.yMax),
    lines: count,
  })
  const whole = [span(lines.flatMap(line => line.words), lines.length)]
  const width = page.width || Math.max(maxOf(lines, line => line.xMax), 1)
  const bins = Math.ceil(width) + 1
  // The width comes from the PDF. A PDF page is at most 14400 pt, so a wider one
  // is not split into columns.
  if (bins > MAX_COLUMN_BINS) return whole

  // The points each row covers, from its words: a row is keyed by the rounded
  // top edge of its words. Kept as spans, so memory follows the words on the
  // page, not rows times width.
  const rows = new Map()
  for (const line of lines) {
    for (const word of line.words) {
      const key = Math.round(word.yMin)
      if (!rows.has(key)) rows.set(key, [])
      const from = Math.max(0, Math.floor(word.xMin))
      const to = Math.min(bins - 1, Math.ceil(word.xMax))
      if (to >= from) rows.get(key).push([from, to])
    }
  }
  // hits[x] counts the rows that cover point x. A row's spans are merged first,
  // so a row counts once wherever its words overlap; a difference array then
  // adds each merged span in O(1).
  const diff = new Int32Array(bins + 1)
  for (const spans of rows.values()) {
    spans.sort((a, b) => a[0] - b[0])
    let start = -1
    let end = -2
    for (const [from, to] of spans) {
      if (from > end + 1) {
        if (start >= 0) {
          diff[start]++
          diff[end + 1]--
        }
        start = from
        end = to
      } else if (to > end) {
        end = to
      }
    }
    if (start >= 0) {
      diff[start]++
      diff[end + 1]--
    }
  }
  const hits = new Int32Array(bins)
  let running = 0
  for (let x = 0; x < bins; x++) {
    running += diff[x]
    hits[x] = running
  }
  const needed = Math.max(2, ROW_SHARE * rows.size)
  const runs = []
  for (let x = 0; x < bins; x++) {
    if (hits[x] < needed) continue
    const last = runs.at(-1)
    if (last && x - last.end <= GUTTER_SHARE * width) last.end = x + 1
    else runs.push({ start: x, end: x + 1 })
  }
  // A column's edges are where its runs of coverage end: a heading across
  // the page does not stretch them.
  const columns = runs
    .filter(run => run.end - run.start >= COLUMN_SHARE * width)
    .map(run => ({ left: run.start, right: run.end }))
  if (columns.length < 2) return whole

  // A word in a gutter (a page number, a footnote mark) is no column's text.
  const groups = columns.map(() => [])
  for (const line of lines) {
    for (const word of line.words) {
      const centre = (word.xMin + word.xMax) / 2
      const index = columnIndexOf(columns, centre)
      const column = columns[index]
      if (centre >= column.left && centre <= column.right)
        groups[index].push(word)
    }
  }
  const rowsIn = group => new Set(group.map(word => Math.round(word.yMin))).size
  if (groups.some(group => rowsIn(group) < COLUMN_MIN_ROWS)) return whole
  return groups.map((group, index) => ({
    left: columns[index].left,
    right: columns[index].right,
    top: minOf(group, word => word.yMin),
    bottom: maxOf(group, word => word.yMax),
    lines: rowsIn(group),
  }))
}

/** The column a point falls in, or the nearest one when it falls in a gutter. */
function columnIndexOf(columns, x) {
  let best = 0
  let bestDistance = Infinity
  columns.forEach((column, index) => {
    if (x >= column.left && x <= column.right) {
      best = index
      bestDistance = 0
      return
    }
    const distance = Math.min(
      Math.abs(x - column.left),
      Math.abs(x - column.right)
    )
    if (distance < bestDistance) {
      best = index
      bestDistance = distance
    }
  })
  return best
}

/**
 * The page with each line cut where it changes column, so that every line lies
 * in one column. Returns `{ columns, page }`: the columns of pageColumns and a
 * copy of the page whose lines (and blocks) are those pieces. A page with one
 * column comes back as it is.
 *
 * @param {object} page a page from parseBboxLayout
 * @returns {{columns: Array<object>, page: object}}
 */
export function splitByColumns(page) {
  const columns = pageColumns(page)
  if (columns.length < 2) return { columns, page }
  const pieces = new Map()
  for (const line of page.lines) {
    const groups = []
    for (const word of line.words) {
      const index = columnIndexOf(columns, (word.xMin + word.xMax) / 2)
      const last = groups.at(-1)
      if (last && last.index === index) last.words.push(word)
      else groups.push({ index, words: [word] })
    }
    if (groups.length <= 1) {
      pieces.set(line, [line])
      continue
    }
    pieces.set(
      line,
      groups.map(({ words }, k) => {
        const piece = {
          text: words.map(word => word.text).join(' '),
          xMin: minOf(words, word => word.xMin),
          yMin: minOf(words, word => word.yMin),
          xMax: maxOf(words, word => word.xMax),
          yMax: maxOf(words, word => word.yMax),
          words,
          blockEnd: k === groups.length - 1 ? line.blockEnd : false,
        }
        return piece
      })
    )
  }
  const lines = page.lines.flatMap(line => pieces.get(line))
  const blocks = (page.blocks ?? []).map(block => ({
    ...block,
    lines: block.lines.flatMap(line => pieces.get(line) ?? [line]),
  }))
  return { columns, page: { ...page, lines, blocks } }
}
