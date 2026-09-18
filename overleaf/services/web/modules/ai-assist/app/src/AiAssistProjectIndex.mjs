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

const SECTION_RE =
  /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*?)\s*(?:\[[^\]]*\])?\s*\{/
const INPUT_RE = /\\(?:input|include)\s*\{/
const CLASS_RE = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/
const TITLE_RE = /\\title\s*(?:\[[^\]]*\])?\s*\{/
const PACKAGE_RE = /\\usepackage\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g

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
  const hit = candidates.find(candidate => candidate in docs)
  return hit ?? (target.endsWith('.tex') ? target : `${target}.tex`)
}

export function parseOutline({ docs, rootPath }) {
  const sections = []
  const includes = []
  const packages = []
  const notes = []
  let documentClass = null
  let hasTitle = false

  const order =
    rootPath && rootPath in docs
      ? [rootPath, ...Object.keys(docs).filter(path => path !== rootPath)]
      : Object.keys(docs)

  for (const path of order) {
    if (!path.endsWith('.tex')) continue
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
          if (trimmed && !packages.includes(trimmed)) packages.push(trimmed)
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
            resolved: target in docs,
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
const CITE_RE =
  /\\(cite|citep|citet|citeauthor|citeyear|nocite)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g
const BIB_ENTRY_RE = /^\s*@\w+\s*\{\s*([^,\s}]+)\s*,/
const THEBIB_RE = /\\begin\{thebibliography\}/

function keysOf(group) {
  return group
    .split(',')
    .map(key => key.trim())
    .filter(Boolean)
}

export function hasThebibliographyEnvironment({ docs }) {
  return Object.values(docs).some(content => THEBIB_RE.test(content))
}

export function extractReferences({ docs }) {
  const labels = []
  const bibKeys = []
  const rawRefs = []
  const rawCitations = []

  for (const [path, contents] of Object.entries(docs)) {
    const isBib = path.endsWith('.bib')

    contents.split('\n').forEach((rawLine, index) => {
      const line = isBib ? rawLine : uncomment(rawLine)
      const lineNumber = index + 1

      if (isBib) {
        const entry = line.match(BIB_ENTRY_RE)
        if (entry) bibKeys.push({ key: entry[1], path, line: lineNumber })
        return
      }

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
        cite = CITE_RE.exec(line)
      }
    })
  }

  const labelKeys = new Set(labels.map(label => label.key))
  const bibKeySet = new Set(bibKeys.map(entry => entry.key))

  const seen = new Set()
  const duplicateLabels = []
  for (const label of labels) {
    if (seen.has(label.key) && !duplicateLabels.includes(label.key)) {
      duplicateLabels.push(label.key)
    }
    seen.add(label.key)
  }

  return {
    labels,
    bibKeys,
    duplicateLabels,
    refs: rawRefs.map(use => ({ ...use, resolved: labelKeys.has(use.key) })),
    citations: rawCitations.map(use => ({
      ...use,
      resolved: bibKeySet.has(use.key),
    })),
  }
}

// ---- project-index.ts ----

/** Above this a file is listed but never parsed; parsing it would cost more than it can return. */
export const MAX_INDEXED_BYTES = 512 * 1024

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

export function scanEnvironments(content) {
  const found = new Map()

  content.split('\n').forEach((rawLine, index) => {
    const line = uncomment(rawLine)
    for (const name of ENV_NAMES) {
      const re = new RegExp(`\\\\begin\\{${name}\\*?\\}`)
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

export function scanPackages(content) {
  const uses = []
  content.split('\n').forEach((rawLine, index) => {
    const line = rawLine.replace(/(?<!\\)%.*/, '')
    const re = /\\(?:usepackage|RequirePackage)\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/g
    let match = re.exec(line)
    while (match) {
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
      match = re.exec(line)
    }
  })
  return uses
}

const envCache = new Map()
const ENV_CACHE_MAX = 500

function environmentsFor(path, content) {
  if (!path.endsWith('.tex')) return []
  const hash = hashContent(content)
  const cached = envCache.get(hash)
  if (cached) return cached
  const scanned = scanEnvironments(content)
  if (envCache.size >= ENV_CACHE_MAX) envCache.clear()
  envCache.set(hash, scanned)
  return scanned
}

const pkgCache = new Map()
const PKG_CACHE_MAX = 500

function packagesFor(path, content) {
  if (!path.endsWith('.tex')) return []
  const hash = hashContent(content)
  let scanned = pkgCache.get(hash)
  if (!scanned) {
    scanned = scanPackages(content)
    if (pkgCache.size >= PKG_CACHE_MAX) pkgCache.clear()
    pkgCache.set(hash, scanned)
  }
  return scanned.map(u => ({ ...u, path }))
}

export function buildProjectIndex({ docs, rootPath }, previous) {
  const entries = Object.entries(docs)
  const hash = hashContent(
    entries
      .map(([path, content]) => `${path} ${hashContent(content)}`)
      .sort()
      .join(' ')
  )

  if (previous && previous.hash === hash && previous.rootPath === rootPath) {
    return previous
  }

  const files = entries
    .map(([path, content]) => ({
      path,
      hash: hashContent(content),
      tooLarge: content.length > MAX_INDEXED_BYTES,
      environments:
        content.length > MAX_INDEXED_BYTES
          ? []
          : environmentsFor(path, content),
    }))
    .sort((a, b) => a.path.localeCompare(b.path))

  const packages = entries.flatMap(([path, content]) =>
    content.length > MAX_INDEXED_BYTES ? [] : packagesFor(path, content)
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
