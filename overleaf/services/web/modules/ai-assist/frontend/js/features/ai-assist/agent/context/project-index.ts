import { Outline, OutlineSection, parseOutline, uncomment } from './outline'
import {
  References,
  extractReferences,
  hasThebibliographyEnvironment,
} from './references'

/** Above this, environments and packages skip oversize files; parsing them would cost more than it can return. */
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

const ENV_PATTERNS = ENV_NAMES.map(name => ({
  name,
  re: new RegExp(`\\\\begin\\{${name}\\*?\\}`),
}))

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

/**
 * Counts the environments a reader of a paper asks about ("where are the
 * figures?") that the section tree does not show. One regex pass per file.
 */
export function scanEnvironments(content: string): EnvironmentCount[] {
  const found = new Map<string, { count: number; lines: number[] }>()

  content.split('\n').forEach((rawLine, index) => {
    const line = uncomment(rawLine)
    for (const { name, re } of ENV_PATTERNS) {
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
  const re = /\\(?:usepackage|RequirePackage)\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/g
  content.split('\n').forEach((rawLine, index) => {
    const line = uncomment(rawLine)
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

// Per-file caches, keyed by content hash. A keystroke reparses one file;
// everything else is a map hit. Bounded so a long session cannot grow them
// without limit.
const envCache = new Map<string, EnvironmentCount[]>()
const ENV_CACHE_MAX = 500
const pkgCache = new Map<string, Array<Omit<PackageUse, 'path'>>>()
const PKG_CACHE_MAX = 500

function memoByHash<T>(
  cache: Map<string, T>,
  max: number,
  hash: string,
  scan: () => T
): T {
  const cached = cache.get(hash)
  if (cached) return cached
  const scanned = scan()
  if (cache.size >= max) cache.clear()
  cache.set(hash, scanned)
  return scanned
}

function environmentsFor(
  path: string,
  content: string,
  hash: string
): EnvironmentCount[] {
  if (!path.endsWith('.tex')) return []
  return memoByHash(envCache, ENV_CACHE_MAX, hash, () =>
    scanEnvironments(content)
  )
}

function packagesFor(path: string, content: string, hash: string): PackageUse[] {
  if (!path.endsWith('.tex')) return []
  return memoByHash(pkgCache, PKG_CACHE_MAX, hash, () =>
    scanPackages(content)
  ).map(u => ({ ...u, path }))
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

  const files: FileIndex[] = entries
    .map(({ path, content, hash: contentHash }) => ({
      path,
      hash: contentHash,
      tooLarge: content.length > MAX_INDEXED_BYTES,
      environments:
        content.length > MAX_INDEXED_BYTES
          ? []
          : environmentsFor(path, content, contentHash),
    }))
    .sort((a, b) => a.path.localeCompare(b.path))

  const packages: PackageUse[] = entries.flatMap(
    ({ path, content, hash: contentHash }) =>
      content.length > MAX_INDEXED_BYTES
        ? []
        : packagesFor(path, content, contentHash)
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
