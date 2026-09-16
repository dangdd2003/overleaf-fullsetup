export type LabelDefinition = { key: string; path: string; line: number }
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
  bibKeys: LabelDefinition[]
  duplicateLabels: string[]
}

const LABEL_RE = /\\label\s*\{([^}]*)\}/g
const REF_RE = /\\(ref|eqref|autoref|cref|Cref|pageref)\s*\{([^}]*)\}/g
const CITE_RE =
  /\\(cite|citep|citet|citeauthor|citeyear|nocite)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g
const BIB_ENTRY_RE = /^\s*@\w+\s*\{\s*([^,\s}]+)\s*,/
const THEBIB_RE = /\\begin\{thebibliography\}/

function uncomment(line: string): string {
  const index = line.search(/(?<!\\)%/)
  return index === -1 ? line : line.slice(0, index)
}

function keysOf(group: string): string[] {
  return group
    .split(',')
    .map(key => key.trim())
    .filter(Boolean)
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
  return Object.values(docs).some(content => THEBIB_RE.test(content))
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
  const bibKeys: LabelDefinition[] = []
  const rawRefs: Omit<ReferenceUse, 'resolved'>[] = []
  const rawCitations: Omit<ReferenceUse, 'resolved'>[] = []

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

  const seen = new Set<string>()
  const duplicateLabels: string[] = []
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
