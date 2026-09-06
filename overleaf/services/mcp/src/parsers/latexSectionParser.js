const SECTION_LEVELS = new Map([
  ['part', 0],
  ['chapter', 1],
  ['section', 2],
  ['subsection', 3],
  ['subsubsection', 4],
  ['paragraph', 5],
  ['subparagraph', 6],
])

const CITE_COMMANDS = [
  'cite',
  'citep',
  'citet',
  'citeauthor',
  'citeyear',
  'autocite',
  'parencite',
  'textcite',
  'footcite',
  'nocite',
]

const REF_COMMANDS = ['ref', 'eqref', 'autoref', 'cref', 'Cref', 'pageref', 'nameref']

const INCLUDE_COMMANDS = [
  'input',
  'include',
  'subfile',
  'includeonly',
  'bibliography',
  'addbibresource',
]

const DEFINE_COMMANDS = [
  'newcommand',
  'renewcommand',
  'providecommand',
  'DeclareMathOperator',
]

const TODO_COMMENT = /(?:^|\s)(TODO|FIXME|XXX|HACK|NOTE)\b[:\s-]*(.*)$/

/** 1-indexed line number of a character offset. */
function lineAt(text, index) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') line++
  }
  return line
}

/**
 * Read a balanced {...} group starting at openIndex.
 *
 * @returns {{ content: string, endIndex: number }|null}
 */
function readBraceGroup(text, openIndex) {
  if (text[openIndex] !== '{') return null
  let depth = 0
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return { content: text.slice(openIndex + 1, i), endIndex: i }
    }
  }
  return null
}

/** Skip whitespace and an optional [..] argument, returning the next index. */
function skipOptional(text, index) {
  let i = index
  while (i < text.length && /\s/.test(text[i])) i++
  if (text[i] === '[') {
    let depth = 1
    i++
    while (i < text.length && depth > 0) {
      if (text[i] === '\\') {
        i += 2
        continue
      }
      if (text[i] === '[') depth++
      else if (text[i] === ']') depth--
      i++
    }
    while (i < text.length && /\s/.test(text[i])) i++
  }
  return i
}

/**
 * Remove LaTeX comments while preserving the line count, so every line number
 * this module reports still matches the document the user sees.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripComments(text) {
  return String(text ?? '')
    .split('\n')
    .map(line => {
      let out = ''
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (ch === '\\' && i + 1 < line.length) {
          out += ch + line[i + 1]
          i++
          continue
        }
        if (ch === '%') break
        out += ch
      }
      return out
    })
    .join('\n')
}

/**
 * List every sectioning command in document order.
 *
 * Each entry carries the line range of its body: from the heading itself up to
 * the line before the next section at the same or a higher level, or the end of
 * the document. The range is what a caller feeds straight back to a line-sliced
 * document read, so the outline alone is enough to fetch any section.
 *
 * @param {string} text
 * @returns {{ level: number, name: string, title: string, startLine: number, endLine: number, starred: boolean }[]}
 */
export function parseSections(text) {
  const source = stripComments(text)
  const pattern = new RegExp(`\\\\(${[...SECTION_LEVELS.keys()].join('|')})(\\*)?`, 'g')
  const sections = []
  for (const match of source.matchAll(pattern)) {
    const braceIndex = skipOptional(source, match.index + match[0].length)
    const group = readBraceGroup(source, braceIndex)
    if (!group) continue
    sections.push({
      level: SECTION_LEVELS.get(match[1]),
      name: match[1],
      title: group.content.trim(),
      startLine: lineAt(source, match.index),
      starred: Boolean(match[2]),
    })
  }

  // stripComments preserves line breaks, so line numbers agree with the source.
  const totalLines = source.split('\n').length
  for (const [index, section] of sections.entries()) {
    const next = sections.slice(index + 1).find(later => later.level <= section.level)
    section.endLine = next ? next.startLine - 1 : totalLines
  }
  return sections
}

/**
 * List \input, \include and bibliography-resource commands.
 *
 * @param {string} text
 * @returns {{ command: string, path: string, line: number }[]}
 */
export function parseIncludes(text) {
  const source = stripComments(text)
  const pattern = new RegExp(`\\\\(${INCLUDE_COMMANDS.join('|')})\\s*\\{`, 'g')
  const includes = []
  for (const match of source.matchAll(pattern)) {
    const group = readBraceGroup(source, match.index + match[0].length - 1)
    if (!group) continue
    for (const path of group.content.split(',')) {
      const trimmed = path.trim()
      if (trimmed) {
        includes.push({
          command: match[1],
          path: trimmed,
          line: lineAt(source, match.index),
        })
      }
    }
  }
  return includes
}

/**
 * List every citation key, one entry per key in a multi-key citation.
 *
 * @param {string} text
 * @returns {{ key: string, command: string, line: number }[]}
 */
export function parseCitations(text) {
  const source = stripComments(text)
  const pattern = new RegExp(`\\\\(${CITE_COMMANDS.join('|')})\\s*(?:\\[[^\\]]*\\])*\\s*\\{`, 'g')
  const citations = []
  for (const match of source.matchAll(pattern)) {
    const group = readBraceGroup(source, match.index + match[0].length - 1)
    if (!group) continue
    for (const key of group.content.split(',')) {
      const trimmed = key.trim()
      if (trimmed) {
        citations.push({
          key: trimmed,
          command: match[1],
          line: lineAt(source, match.index),
        })
      }
    }
  }
  return citations
}

/**
 * Collect \label definitions and the commands that reference them.
 *
 * @param {string} text
 * @returns {{ labels: { name: string, line: number }[], refs: { name: string, command: string, line: number }[] }}
 */
export function parseLabelsAndRefs(text) {
  const source = stripComments(text)
  const labels = []
  const refs = []

  for (const match of source.matchAll(/\\label\s*\{/g)) {
    const group = readBraceGroup(source, match.index + match[0].length - 1)
    if (group) {
      labels.push({ name: group.content.trim(), line: lineAt(source, match.index) })
    }
  }

  const refPattern = new RegExp(`\\\\(${REF_COMMANDS.join('|')})\\s*\\{`, 'g')
  for (const match of source.matchAll(refPattern)) {
    const group = readBraceGroup(source, match.index + match[0].length - 1)
    if (!group) continue
    for (const name of group.content.split(',')) {
      const trimmed = name.trim()
      if (trimmed) {
        refs.push({ name: trimmed, command: match[1], line: lineAt(source, match.index) })
      }
    }
  }

  return { labels, refs }
}

/**
 * Find each occurrence of the named environments, nesting-aware.
 *
 * @param {string} text
 * @param {string[]} names environment names, e.g. ['figure', 'table']
 * @returns {{ name: string, line: number, endLine: number, body: string, label: string|null, caption: string|null }[]}
 */
export function parseEnvironments(text, names) {
  const source = stripComments(text)
  const found = []

  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const begin = new RegExp(`\\\\begin\\s*\\{${escaped}\\*?\\}`, 'g')
    const end = new RegExp(`\\\\end\\s*\\{${escaped}\\*?\\}`, 'g')

    const starts = [...source.matchAll(begin)].map(m => ({
      index: m.index,
      after: m.index + m[0].length,
    }))
    const ends = [...source.matchAll(end)].map(m => ({
      index: m.index,
      after: m.index + m[0].length,
    }))

    // Pair each \end with the nearest unmatched \begin before it.
    const open = []
    const pairs = []
    let s = 0
    for (const e of ends) {
      while (s < starts.length && starts[s].index < e.index) open.push(starts[s++])
      const start = open.pop()
      if (start) pairs.push({ start, end: e })
    }

    for (const { start, end: close } of pairs) {
      const body = source.slice(start.after, close.index)
      const labelMatch = /\\label\s*\{([^}]*)\}/.exec(body)
      let caption = null
      const captionMatch = /\\caption\b/.exec(body)
      if (captionMatch) {
        const afterCmd = captionMatch.index + captionMatch[0].length
        const braceIndex = skipOptional(body, afterCmd)
        if (body[braceIndex] === '{') {
          const group = readBraceGroup(body, braceIndex)
          if (group) caption = group.content.trim()
        }
      }
      found.push({
        name,
        line: lineAt(source, start.index),
        endLine: lineAt(source, close.after - 1),
        body,
        label: labelMatch ? labelMatch[1].trim() : null,
        caption,
      })
    }
  }

  return found.sort((a, b) => a.line - b.line)
}

/**
 * List user-defined commands and math operators.
 *
 * @param {string} text
 * @returns {{ command: string, name: string, arity: number, definition: string, line: number }[]}
 */
export function parseCustomCommands(text) {
  const source = stripComments(text)
  const pattern = new RegExp(`\\\\(${DEFINE_COMMANDS.join('|')})\\s*`, 'g')
  const commands = []

  for (const match of source.matchAll(pattern)) {
    let i = match.index + match[0].length
    let name

    if (source[i] === '{') {
      const group = readBraceGroup(source, i)
      if (!group) continue
      name = group.content.trim()
      i = group.endIndex + 1
    } else {
      const nameMatch = /^\\[A-Za-z@]+\*?/.exec(source.slice(i))
      if (!nameMatch) continue
      name = nameMatch[0]
      i += nameMatch[0].length
    }

    let arity = 0
    while (i < source.length && /\s/.test(source[i])) i++
    if (source[i] === '[') {
      const close = source.indexOf(']', i)
      if (close !== -1) {
        arity = parseInt(source.slice(i + 1, close), 10) || 0
        i = close + 1
      }
    }
    // A \newcommand may carry a second optional argument (a default value).
    i = skipOptional(source, i)

    const definition = readBraceGroup(source, i)
    commands.push({
      command: match[1],
      name,
      arity,
      definition: definition ? definition.content : '',
      line: lineAt(source, match.index),
    })
  }

  return commands
}

/**
 * Find TODO-style notes, both in comments and in \todo macros.
 *
 * Runs on the raw text: stripping comments would discard most of them.
 *
 * @param {string} text
 * @returns {{ kind: string, text: string, line: number }[]}
 */
export function parseTodoNotes(text) {
  const raw = String(text ?? '')
  const notes = []

  raw.split('\n').forEach((line, index) => {
    let commentIndex = -1
    for (let c = 0; c < line.length; c++) {
      if (line[c] === '\\' && c + 1 < line.length) {
        c++
        continue
      }
      if (line[c] === '%') {
        commentIndex = c
        break
      }
    }
    if (commentIndex !== -1) {
      const match = TODO_COMMENT.exec(line.slice(commentIndex + 1))
      if (match) {
        notes.push({ kind: match[1], text: match[2].trim(), line: index + 1 })
      }
    }
  })

  for (const match of raw.matchAll(/\\(todo|TODO)\s*(?:\[[^\]]*\])?\s*\{/g)) {
    const group = readBraceGroup(raw, match.index + match[0].length - 1)
    if (group) {
      notes.push({
        kind: match[1],
        text: group.content.trim(),
        line: lineAt(raw, match.index),
      })
    }
  }

  return notes.sort((a, b) => a.line - b.line)
}
