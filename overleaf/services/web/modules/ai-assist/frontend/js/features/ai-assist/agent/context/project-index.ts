import { Outline, OutlineSection, parseOutline } from './outline'
import {
  References,
  extractReferences,
  hasThebibliographyEnvironment,
} from './references'

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

export type EnvironmentCount = { name: string; count: number; lines: number[] }

export type FileIndex = {
  path: string
  hash: string
  tooLarge: boolean
  environments: EnvironmentCount[]
}

export type PackageUse = {
  name: string
  options?: string
  path: string
  line: number
}

export type ProjectIndex = {
  /** Identity over every file's path and hash. Unchanged means reuse. */
  hash: string
  rootPath: string | null
  outline: Outline
  references: References
  files: FileIndex[]
  packages: PackageUse[]
  /** True when any document hand-rolls entries via `thebibliography`. */
  hasThebibliography: boolean
}

/** djb2 with a length prefix: deterministic, cheap, collision-irrelevant here. */
export function hashContent(content: string): string {
  let h = 5381
  for (let i = 0; i < content.length; i++) {
    h = ((h << 5) + h + content.charCodeAt(i)) | 0
  }
  return `${content.length}:${(h >>> 0).toString(16)}`
}

function uncomment(line: string): string {
  const index = line.search(/(?<!\\)%/)
  return index === -1 ? line : line.slice(0, index)
}

/**
 * Counts the environments a reader of a paper asks about ("where are the
 * figures?") that the section tree does not show. One regex pass per file.
 */
export function scanEnvironments(content: string): EnvironmentCount[] {
  const found = new Map<string, { count: number; lines: number[] }>()

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

export function scanPackages(
  content: string
): Array<Omit<PackageUse, 'path'>> {
  const uses: Array<Omit<PackageUse, 'path'>> = []
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

// Per-file environment cache, keyed by content hash. A keystroke reparses one
// file; everything else is a map hit. Bounded so a long session cannot grow it
// without limit.
const envCache = new Map<string, EnvironmentCount[]>()
const ENV_CACHE_MAX = 500

function environmentsFor(path: string, content: string): EnvironmentCount[] {
  if (!path.endsWith('.tex')) return []
  const hash = hashContent(content)
  const cached = envCache.get(hash)
  if (cached) return cached
  const scanned = scanEnvironments(content)
  if (envCache.size >= ENV_CACHE_MAX) envCache.clear()
  envCache.set(hash, scanned)
  return scanned
}

const pkgCache = new Map<string, Array<Omit<PackageUse, 'path'>>>()
const PKG_CACHE_MAX = 500

function packagesFor(path: string, content: string): PackageUse[] {
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

/**
 * Builds (or reuses) the structural index over the whole project.
 *
 * parseOutline and extractReferences are cross-file by nature — section order
 * follows the root document and resolution flags compare against every label
 * in the project — so they cannot be memoized per file without changing what
 * they mean. Memoization here is therefore two honest units: this identity
 * short-circuit, and the per-file environment cache above.
 */
export function buildProjectIndex(
  {
    docs,
    rootPath,
  }: { docs: Record<string, string>; rootPath: string | null },
  previous?: ProjectIndex | null
): ProjectIndex {
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

  const files: FileIndex[] = entries
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

  const packages: PackageUse[] = entries.flatMap(([path, content]) =>
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

export type SectionMatch =
  | { kind: 'exact'; section: OutlineSection }
  | { kind: 'ambiguous'; candidates: OutlineSection[] }
  | { kind: 'none' }

/** Titles compared with LaTeX commands stripped, whitespace collapsed, case folded. */
export function normaliseSectionTitle(title: string): string {
  return title
    .replace(/\\[a-zA-Z]+\*?(\{[^}]*\})?/g, ' ')
    .replace(/[{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Exact match wins, then a unique prefix. Ambiguity returns the candidates
 * with their line numbers and reads nothing — an unanswered question is
 * cheaper than a wrong read.
 */
export function matchSection(outline: Outline, query: string): SectionMatch {
  const wanted = normaliseSectionTitle(query)
  if (!wanted) return { kind: 'none' }

  const normalised = outline.sections.map(section => ({
    section,
    title: normaliseSectionTitle(section.title),
  }))

  // Exact phase: equal titles win first (even if that title is a prefix of another).
  const exactHits = normalised.filter(e => e.title === wanted)
  if (exactHits.length === 1) return { kind: 'exact', section: exactHits[0].section }
  if (exactHits.length > 1) return { kind: 'ambiguous', candidates: exactHits.map(e => e.section) }

  // Prefix phase: unique prefix wins; multiple prefixes are ambiguous.
  const prefixes = normalised.filter(e => e.title.startsWith(wanted))
  if (prefixes.length === 1) return { kind: 'exact', section: prefixes[0].section }
  if (prefixes.length > 1) return { kind: 'ambiguous', candidates: prefixes.map(e => e.section) }
  return { kind: 'none' }
}
