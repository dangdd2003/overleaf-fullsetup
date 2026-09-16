export type OutlineSection = {
  path: string
  line: number
  level: number
  title: string
  numbered: boolean
}

export type OutlineInclude = {
  from: string
  to: string
  line: number
  resolved: boolean
}

export type Outline = {
  documentClass: string | null
  packages: string[]
  sections: OutlineSection[]
  includes: OutlineInclude[]
  notes: string[]
  /** Whether any document declares a `\title{...}`. */
  hasTitle: boolean
}

const LEVELS: Record<string, number> = {
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
function uncomment(line: string): string {
  const index = line.search(/(?<!\\)%/)
  return index === -1 ? line : line.slice(0, index)
}

/**
 * Reads a brace group starting at `openIndex`, honouring nesting.
 *
 * A regex cannot do this: section titles routinely contain \textbf{...}, and a
 * lazy [^}]* would cut the title in half.
 */
export function readBraceGroup(
  text: string,
  openIndex: number
): { body: string; end: number } | null {
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

function resolveInclude(target: string, docs: Record<string, string>) {
  const candidates = [target, `${target}.tex`, target.replace(/\.tex$/, '')]
  const hit = candidates.find(candidate => candidate in docs)
  return hit ?? (target.endsWith('.tex') ? target : `${target}.tex`)
}

/**
 * Parses project structure without reading whole files into the model.
 *
 * Never throws: a partial outline of a malformed project is more useful to the
 * agent than an error, so problems are reported in `notes`.
 */
export function parseOutline({
  docs,
  rootPath,
}: {
  docs: Record<string, string>
  rootPath: string | null
}): Outline {
  const sections: OutlineSection[] = []
  const includes: OutlineInclude[] = []
  const packages: string[] = []
  const notes: string[] = []
  let documentClass: string | null = null
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
