/**
 * Server port of the browser's project index:
 * frontend/js/features/ai-assist/agent/context/{outline,references,project-index}.ts
 *
 * Pure functions, no I/O. AiAssistProjectIndex.test.mjs imports the TypeScript
 * originals and asserts identical output, so change both or neither.
 */

// ---- outline.ts ----

const LEVELS = {
  part: -1,
  chapter: 0,
  section: 1,
  subsection: 2,
  subsubsection: 3,
  paragraph: 4,
  subparagraph: 5,
}

export const MAX_INDEXED_BYTES = 512 * 1024

const SECTION_RE =
  /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*?)(?:\s*\[[^\]]*\])?\s*\{/
const INPUT_RE = /\\(?:input|include)\s*\{/
const CLASS_RE = /\\documentclass(?:\s*\[[^\]]*\])?\s*\{([^}]*)\}/
const TITLE_RE = /\\title(?:\s*\[[^\]]*\])?\s*\{/
const PACKAGE_RE = /\\usepackage(?:\s*\[[^\]]*\])?\s*\{([^}]*)\}/g

/** Strips a line comment, respecting an escaped percent sign. */
function uncomment(line) {
  const index = line.search(/(?<!\\)%/)
  return index === -1 ? line : line.slice(0, index)
}

export function readBraceGroup(text, openIndex) {
  if (text[openIndex] !== '{') return null
  let depth = 0
  for (let index = openIndex; index < text.length; index++) {
    const char = text[index]
    if (char === '{' && text[index - 1] !== '\\') depth += 1
    else if (char === '}' && text[index - 1] !== '\\') {
      depth -= 1
      if (depth === 0) {
        return { body: text.slice(openIndex + 1, index), end: index }
      }
    }
  }
  return null
}

function resolveInclude(target, docs) {
  const candidates = [target, `${target}.tex`, target.replace(/\.tex$/, '')]
  const hit = candidates.find(candidate => Object.hasOwn(docs, candidate))
  return hit ?? (target.endsWith('.tex') ? target : `${target}.tex`)
}

export function parseOutline({ docs, rootPath }) {
  const sections = []
  const includes = []
  const packages = []
  const seenPackages = new Set()
  const notes = []
  let documentClass = null
  let hasTitle = false

  const order =
    rootPath && Object.hasOwn(docs, rootPath)
      ? [rootPath, ...Object.keys(docs).filter(path => path !== rootPath)]
      : Object.keys(docs)

  for (const path of order) {
    if (!path.endsWith('.tex')) continue
    if (docs[path].length > MAX_INDEXED_BYTES) continue
    const lines = docs[path].split('\n')

    lines.forEach((rawLine, index) => {
      const line = uncomment(rawLine)
      const lineNumber = index + 1

      if (!documentClass) {
        const found = line.match(CLASS_RE)
        if (found) documentClass = found[1].trim()
      }

      if (!hasTitle && TITLE_RE.test(line)) hasTitle = true

      PACKAGE_RE.lastIndex = 0
      let pkg = PACKAGE_RE.exec(line)
      while (pkg) {
        for (const name of pkg[1].split(',')) {
          const trimmed = name.trim()
          if (trimmed && !seenPackages.has(trimmed)) {
            seenPackages.add(trimmed)
            packages.push(trimmed)
          }
        }
        pkg = PACKAGE_RE.exec(line)
      }

      const section = line.match(SECTION_RE)
      if (section && section.index !== undefined) {
        const open = section.index + section[0].length - 1
        const group = readBraceGroup(line, open)
        if (!group) {
          notes.push(`${path}:${lineNumber}: unterminated section title, skipped`)
        } else {
          sections.push({
            path,
            line: lineNumber,
            level: LEVELS[section[1]],
            title: group.body.trim(),
            numbered: section[2] !== '*',
          })
        }
      }

      const include = line.match(INPUT_RE)
      if (include && include.index !== undefined) {
        const open = include.index + include[0].length - 1
        const group = readBraceGroup(line, open)
        if (!group) {
          notes.push(`${path}:${lineNumber}: unterminated \\input, skipped`)
        } else {
          const target = resolveInclude(group.body.trim(), docs)
          includes.push({
            from: path,
            to: target,
            line: lineNumber,
            resolved: Object.hasOwn(docs, target),
          })
        }
      }
    })
  }

  return { documentClass, packages, sections, includes, notes, hasTitle }
}

// ---- references.ts ----

const LABEL_RE = /\\label\s*\{([^}]*)\}/g
const REF_RE = /\\(ref|eqref|autoref|cref|Cref|pageref)\s*\{([^}]*)\}/g
// Natbib and biblatex citation commands. Longer names come first so that
// \citep is not read as \cite followed by "p". Each may take up to two
// optional arguments (prenote, postnote) before its key list.
const CITE_COMMANDS = [
  'cite',
  'nocite',
  'citep',
  'citet',
  'citealt',
  'citealp',
  'citeauthor',
  'citeyear',
  'citeyearpar',
  'citetitle',
  'textcite',
  'textcites',
  'parencite',
  'parencites',
  'autocite',
  'autocites',
  'footcite',
  'footcites',
  'footcitet',
  'smartcite',
  'supercite',
  'fullcite',
  'Textcite',
  'Parencite',
  'Autocite',
  'Footcite',
]
  .sort((a, b) => b.length - a.length)
  .join('|')
const CITE_RE = new RegExp(
  `\\\\(${CITE_COMMANDS})\\*?(?:\\s*\\[[^\\]]*\\]){0,2}\\s*\\{([^}]*)\\}`,
  'g'
)
const EXTRA_CITE_GROUP_RE = /^(?:\s*\[[^\]]*\]){0,2}\s*\{([^}]*)\}/
const BIB_ENTRY_RE = /^\s*@\w+\s*\{\s*([^,\s}]+)\s*,/
const THEBIB_RE = /\\begin\{thebibliography\}/
const BIBITEM_RE = /\\bibitem(?:\s*\[[^\]]*\])?\s*\{([^}]*)\}/g

// Fields a complete entry needs, by entry type. An alternative in an array
// ("author or editor") is met by either name.
const REQUIRED_BIB_FIELDS = {
  article: ['author', 'title', 'journal', 'year'],
  book: [['author', 'editor'], 'title', 'publisher', 'year'],
  inproceedings: ['author', 'title', 'booktitle', 'year'],
}

function keysOf(group) {
  return group
    .split(',')
    .map(key => key.trim())
    .filter(Boolean)
}

export function hasThebibliographyEnvironment({ docs }) {
  return Object.values(docs).some(
    content => content.length <= MAX_INDEXED_BYTES && THEBIB_RE.test(content)
  )
}

/**
 * Splits a .bib file into entries and reports the ones that are incomplete.
 * Entries are cut at each line that opens with "@"; a field is a name followed
 * by "=". Good enough for the entries the model edits, and cheap.
 */
function bibEntriesOf(path, contents) {
  const entries = []
  const lines = contents.split('\n')
  let current = null
  lines.forEach((line, index) => {
    const head = line.match(/^\s*@(\w+)\s*\{\s*([^,\s}]*)/)
    if (head) {
      current = {
        type: head[1].toLowerCase(),
        key: head[2],
        path,
        line: index + 1,
        fields: new Set(),
      }
      entries.push(current)
    }
    if (current) {
      for (const field of line.matchAll(/(?:^|[\s,{])([A-Za-z][A-Za-z_-]*)\s*=/g)) {
        current.fields.add(field[1].toLowerCase())
      }
    }
  })
  return entries.filter(e => !['comment', 'string', 'preamble'].includes(e.type))
}

function missingBibFields(entry) {
  const required = REQUIRED_BIB_FIELDS[entry.type]
  if (!required) return []
  return required
    .filter(need => {
      const alternatives = Array.isArray(need) ? need : [need]
      return !alternatives.some(name => entry.fields.has(name))
    })
    .map(need => (Array.isArray(need) ? need.join(' or ') : need))
}

export function extractReferences({ docs }) {
  const labels = []
  const bibKeys = []
  const bibEntries = []
  const rawRefs = []
  const rawCitations = []

  for (const [path, contents] of Object.entries(docs)) {
    if (contents.length > MAX_INDEXED_BYTES) continue
    const isBib = path.endsWith('.bib')

    if (isBib) {
      bibEntries.push(...bibEntriesOf(path, contents))
      contents.split('\n').forEach((rawLine, index) => {
        const entry = rawLine.match(BIB_ENTRY_RE)
        if (entry) bibKeys.push({ key: entry[1], path, line: index + 1 })
      })
      continue
    }

    // \bibitem keys are the bibliography when the file has the environment
    const hasBibitems = THEBIB_RE.test(contents)

    contents.split('\n').forEach((rawLine, index) => {
      const line = uncomment(rawLine)
      const lineNumber = index + 1

      LABEL_RE.lastIndex = 0
      let label = LABEL_RE.exec(line)
      while (label) {
        for (const key of keysOf(label[1])) {
          labels.push({ key, path, line: lineNumber })
        }
        label = LABEL_RE.exec(line)
      }

      REF_RE.lastIndex = 0
      let ref = REF_RE.exec(line)
      while (ref) {
        for (const key of keysOf(ref[2])) {
          rawRefs.push({ key, path, line: lineNumber, command: ref[1] })
        }
        ref = REF_RE.exec(line)
      }

      CITE_RE.lastIndex = 0
      let cite = CITE_RE.exec(line)
      while (cite) {
        for (const key of keysOf(cite[2])) {
          rawCitations.push({ key, path, line: lineNumber, command: cite[1] })
        }
        if (cite[1].endsWith('cites')) {
          let pos = CITE_RE.lastIndex
          for (;;) {
            const extra = EXTRA_CITE_GROUP_RE.exec(line.slice(pos))
            if (!extra) break
            for (const key of keysOf(extra[1])) {
              rawCitations.push({
                key,
                path,
                line: lineNumber,
                command: cite[1],
              })
            }
            pos += extra[0].length
          }
          CITE_RE.lastIndex = pos
        }
        cite = CITE_RE.exec(line)
      }

      if (hasBibitems) {
        BIBITEM_RE.lastIndex = 0
        let item = BIBITEM_RE.exec(line)
        while (item) {
          for (const key of keysOf(item[1])) {
            bibKeys.push({ key, path, line: lineNumber, bibitem: true })
          }
          item = BIBITEM_RE.exec(line)
        }
      }
    })
  }

  const labelKeys = new Set(labels.map(label => label.key))
  const bibKeySet = new Set(bibKeys.map(entry => entry.key))

  const seen = new Set()
  const duplicateLabels = new Set()
  for (const label of labels) {
    if (seen.has(label.key)) duplicateLabels.add(label.key)
    seen.add(label.key)
  }

  // Keys defined by more than one .bib entry: BibTeX keeps one and drops the rest
  const bibSeen = new Map()
  for (const entry of bibKeys.filter(e => !e.bibitem)) {
    bibSeen.set(entry.key, (bibSeen.get(entry.key) || 0) + 1)
  }
  const duplicateBibKeys = [...bibSeen]
    .filter(([, count]) => count > 1)
    .map(([key]) => key)

  const incompleteBibEntries = bibEntries
    .map(entry => ({
      key: entry.key,
      type: entry.type,
      path: entry.path,
      line: entry.line,
      missing: missingBibFields(entry),
    }))
    .filter(entry => entry.missing.length > 0)

  return {
    labels,
    bibKeys,
    duplicateLabels: [...duplicateLabels],
    duplicateBibKeys,
    incompleteBibEntries,
    refs: rawRefs.map(use => ({ ...use, resolved: labelKeys.has(use.key) })),
    citations: rawCitations.map(use => ({
      ...use,
      resolved: bibKeySet.has(use.key),
    })),
  }
}

// ---- project-index.ts ----

/** Bounds the line list per environment so a figure-heavy paper cannot bloat the index. */
const MAX_ENV_LINES = 50

const ENV_NAMES = [
  'figure',
  'table',
  'equation',
  'align',
  'algorithm',
  'theorem',
  'lstlisting',
  'tikzpicture',
  'abstract',
]

/** djb2 with a length prefix: deterministic, cheap, collision-irrelevant here. */
export function hashContent(content) {
  let h = 5381
  for (let i = 0; i < content.length; i++) {
    h = ((h << 5) + h + content.charCodeAt(i)) | 0
  }
  return `${content.length}:${(h >>> 0).toString(16)}`
}

// One pattern per environment, compiled once rather than for every line
const ENV_PATTERNS = ENV_NAMES.map(name => [
  name,
  new RegExp(`\\\\begin\\{${name}\\*?\\}`),
])

export function scanEnvironments(content) {
  const found = new Map()

  content.split('\n').forEach((rawLine, index) => {
    const line = uncomment(rawLine)
    for (const [name, re] of ENV_PATTERNS) {
      if (re.test(line)) {
        const entry = found.get(name) ?? { count: 0, lines: [] }
        entry.count += 1
        if (entry.lines.length < MAX_ENV_LINES) entry.lines.push(index + 1)
        found.set(name, entry)
      }
    }
  })

  return [...found.entries()]
    .map(([name, entry]) => ({ name, count: entry.count, lines: entry.lines }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

const SCAN_PACKAGE_RE =
  /\\(?:usepackage|RequirePackage)(?:\s*\[([^\]]*)\])?\s*\{([^}]*)\}/g

export function scanPackages(content) {
  const uses = []
  content.split('\n').forEach((rawLine, index) => {
    const line = rawLine.replace(/(?<!\\)%.*/, '')
    for (const match of line.matchAll(SCAN_PACKAGE_RE)) {
      const options = match[1]?.trim() || undefined
      const pkgList = match[2]
      for (const name of pkgList.split(',')) {
        const trimmed = name.trim()
        if (trimmed) {
          uses.push({
            name: trimmed,
            ...(options ? { options } : {}),
            line: index + 1,
          })
        }
      }
    }
  })
  return uses
}

const envCache = new Map()
const ENV_CACHE_MAX = 500

function environmentsFor(path, content, hash) {
  if (!path.endsWith('.tex')) return []
  const cached = envCache.get(hash)
  if (cached) return cached
  const scanned = scanEnvironments(content)
  if (envCache.size >= ENV_CACHE_MAX) envCache.clear()
  envCache.set(hash, scanned)
  return scanned
}

const pkgCache = new Map()
const PKG_CACHE_MAX = 500

function packagesFor(path, content, hash) {
  if (!path.endsWith('.tex')) return []
  let scanned = pkgCache.get(hash)
  if (!scanned) {
    scanned = scanPackages(content)
    if (pkgCache.size >= PKG_CACHE_MAX) pkgCache.clear()
    pkgCache.set(hash, scanned)
  }
  return scanned.map(u => ({ ...u, path }))
}

export function buildProjectIndex({ docs, rootPath }, previous) {
  // Each file is hashed once: the index hash and the cache keys reuse it
  const entries = Object.entries(docs).map(([path, content]) => ({
    path,
    content,
    hash: hashContent(content),
  }))
  const hash = hashContent(
    entries
      .map(entry => `${entry.path} ${entry.hash}`)
      .sort()
      .join(' ')
  )

  if (previous && previous.hash === hash && previous.rootPath === rootPath) {
    return previous
  }

  const files = entries
    .map(({ path, content, hash: fileHash }) => ({
      path,
      hash: fileHash,
      tooLarge: content.length > MAX_INDEXED_BYTES,
      environments:
        content.length > MAX_INDEXED_BYTES
          ? []
          : environmentsFor(path, content, fileHash),
    }))
    .sort((a, b) => a.path.localeCompare(b.path))

  const packages = entries.flatMap(({ path, content, hash: fileHash }) =>
    content.length > MAX_INDEXED_BYTES
      ? []
      : packagesFor(path, content, fileHash)
  )

  return {
    hash,
    rootPath,
    outline: parseOutline({ docs, rootPath }),
    references: extractReferences({ docs }),
    files,
    packages,
    hasThebibliography: hasThebibliographyEnvironment({ docs }),
  }
}

/** Titles compared with LaTeX commands stripped, whitespace collapsed, case folded. */
export function normaliseSectionTitle(title) {
  return title
    .replace(/\\[a-zA-Z]+\*?(\{[^}]*\})?/g, ' ')
    .replace(/[{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export function matchSection(outline, query) {
  const wanted = normaliseSectionTitle(query)
  if (!wanted) return { kind: 'none' }

  const normalised = outline.sections.map(section => ({
    section,
    title: normaliseSectionTitle(section.title),
  }))

  const exactHits = normalised.filter(e => e.title === wanted)
  if (exactHits.length === 1) return { kind: 'exact', section: exactHits[0].section }
  if (exactHits.length > 1) return { kind: 'ambiguous', candidates: exactHits.map(e => e.section) }

  const prefixes = normalised.filter(e => e.title.startsWith(wanted))
  if (prefixes.length === 1) return { kind: 'exact', section: prefixes[0].section }
  if (prefixes.length > 1) return { kind: 'ambiguous', candidates: prefixes.map(e => e.section) }
  return { kind: 'none' }
}
