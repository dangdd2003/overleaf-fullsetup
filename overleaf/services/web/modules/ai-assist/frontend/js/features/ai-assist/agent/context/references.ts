import { MAX_INDEXED_BYTES, uncomment } from './outline'

export type LabelDefinition = { key: string; path: string; line: number }
// A key a bibliography defines: a .bib entry, or a \bibitem in a hand-rolled
// thebibliography environment
export type BibKey = LabelDefinition & { bibitem?: true }
export type IncompleteBibEntry = {
  key: string
  type: string
  path: string
  line: number
  missing: string[]
}
export type ReferenceUse = {
  key: string
  path: string
  line: number
  command: string
  resolved: boolean
}

export type References = {
  labels: LabelDefinition[]
  refs: ReferenceUse[]
  citations: ReferenceUse[]
  bibKeys: BibKey[]
  duplicateLabels: string[]
  duplicateBibKeys: string[]
  incompleteBibEntries: IncompleteBibEntry[]
}

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
const REQUIRED_BIB_FIELDS: Record<string, (string | string[])[]> = {
  article: ['author', 'title', 'journal', 'year'],
  book: [['author', 'editor'], 'title', 'publisher', 'year'],
  inproceedings: ['author', 'title', 'booktitle', 'year'],
}

function keysOf(group: string): string[] {
  return group
    .split(',')
    .map(key => key.trim())
    .filter(Boolean)
}

type BibEntry = {
  type: string
  key: string
  path: string
  line: number
  fields: Set<string>
}

/**
 * Splits a .bib file into entries and reports the ones that are incomplete.
 * Entries are cut at each line that opens with "@"; a field is a name followed
 * by "=". Good enough for the entries the model edits, and cheap.
 */
function bibEntriesOf(path: string, contents: string): BibEntry[] {
  const entries: BibEntry[] = []
  let current: BibEntry | null = null
  contents.split('\n').forEach((line, index) => {
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
      for (const field of line.matchAll(
        /(?:^|[\s,{])([A-Za-z][A-Za-z_-]*)\s*=/g
      )) {
        current.fields.add(field[1].toLowerCase())
      }
    }
  })
  return entries.filter(
    e => !['comment', 'string', 'preamble'].includes(e.type)
  )
}

function missingBibFields(entry: BibEntry): string[] {
  const required = REQUIRED_BIB_FIELDS[entry.type]
  if (!required) return []
  return required
    .filter(need => {
      const alternatives = Array.isArray(need) ? need : [need]
      return !alternatives.some(name => entry.fields.has(name))
    })
    .map(need => (Array.isArray(need) ? need.join(' or ') : need))
}

/**
 * True when any document hand-rolls its entries in a `thebibliography`
 * environment. Such a project needs no `.bib` file, so "citations with no
 * bibliography" is not a problem there.
 */
export function hasThebibliographyEnvironment({
  docs,
}: {
  docs: Record<string, string>
}): boolean {
  return Object.values(docs).some(
    content => content.length <= MAX_INDEXED_BYTES && THEBIB_RE.test(content)
  )
}

/**
 * Finds every label, reference and citation, with whether it resolves.
 *
 * Undefined references and missing citations are the most common LaTeX
 * failure, and this answers them without reading a single file into the model's
 * context.
 */
export function extractReferences({
  docs,
}: {
  docs: Record<string, string>
}): References {
  const labels: LabelDefinition[] = []
  const bibKeys: BibKey[] = []
  const bibEntries: BibEntry[] = []
  const rawRefs: Omit<ReferenceUse, 'resolved'>[] = []
  const rawCitations: Omit<ReferenceUse, 'resolved'>[] = []

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

  const seen = new Set<string>()
  const duplicateSet = new Set<string>()
  const duplicateLabels: string[] = []
  for (const label of labels) {
    if (seen.has(label.key) && !duplicateSet.has(label.key)) {
      duplicateSet.add(label.key)
      duplicateLabels.push(label.key)
    }
    seen.add(label.key)
  }

  // Keys defined by more than one .bib entry: BibTeX keeps one and drops the rest
  const bibSeen = new Map<string, number>()
  for (const entry of bibKeys.filter(e => !e.bibitem)) {
    bibSeen.set(entry.key, (bibSeen.get(entry.key) || 0) + 1)
  }
  const duplicateBibKeys = [...bibSeen]
    .filter(([, count]) => count > 1)
    .map(([key]) => key)

  const incompleteBibEntries: IncompleteBibEntry[] = bibEntries
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
    duplicateLabels,
    duplicateBibKeys,
    incompleteBibEntries,
    refs: rawRefs.map(use => ({ ...use, resolved: labelKeys.has(use.key) })),
    citations: rawCitations.map(use => ({
      ...use,
      resolved: bibKeySet.has(use.key),
    })),
  }
}
