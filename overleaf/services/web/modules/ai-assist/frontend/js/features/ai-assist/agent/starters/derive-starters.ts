import { LastCompile, ProjectFile } from '../project-handle'
import { ProjectIndex } from '../context/project-index'

/**
 * The project-derived starter prompts shown in the empty chat state.
 *
 * Every rule here is deterministic and reads only what the browser already
 * holds — the structural index, the file listing, the last compile — so a
 * fresh chat can offer suggestions about *this* project on first paint, with
 * no provider call and no latency. The labels are translated UI copy; the
 * prompts are untranslated English, because they are instructions sent to the
 * model rather than text shown to the user.
 */

export type StarterRuleId =
  | 'fix_compile_errors'
  | 'resolve_warnings'
  | 'add_missing_package'
  | 'add_bibliography'
  | 'add_missing_bib_entries'
  | 'fix_duplicate_labels'
  | 'resolve_broken_refs'
  | 'init_document_structure'
  | 'draft_conclusion'
  | 'draft_abstract_title'
  | 'proofread_active_file'
  | 'add_summary_table'
  | 'add_figure_placeholder'
  | 'what_can_you_do'
  | 'beamer'
  | 'generate_table'
  | 'manage_bibliography'
  | 'generate_tikz'
  | 'insert_equation'
  | 'summarize'

export type Starter = {
  id: StarterRuleId
  /** Interpolation values for the translated label. */
  params: Record<string, string | number>
  /** Sent verbatim to the model when the user picks this starter. */
  prompt: string
  priority: number
  /**
   * True for concrete project-derived rules, false for open-ended fallbacks.
   * One-shot starters wrap their prompt in a task block so the model acts
   * immediately rather than conversing.
   */
  oneShot: boolean
}

export type StarterSignals = {
  index: ProjectIndex | null
  files: ProjectFile[]
  lastCompile: LastCompile | null
  openFile: { path: string; cursorLine: number | null } | null
}

/** The empty state always shows exactly this many starters (5 to match Overleaf Cloud). */
export const MAX_STARTERS = 5

/** Long names interpolated into a label are clamped so the rail never wraps. */
const MAX_NAME_CHARS = 24

/** Environments and the package that provides them, when not class-built-in. */
const ENV_PACKAGE: Record<string, string> = {
  tikzpicture: 'tikz',
  algorithm: 'algorithm',
  lstlisting: 'listings',
}

/** Classes that provide these environments themselves. */
const CLASS_PROVIDES: Record<string, string[]> = {
  beamer: ['algorithm', 'theorem'],
  acmart: ['algorithm', 'theorem', 'abstract'],
  IEEEtran: ['theorem', 'abstract'],
  llncs: ['theorem', 'abstract'],
  revtex4: ['abstract'],
  elsarticle: ['abstract'],
}

function clampName(name: string): string {
  return name.length > MAX_NAME_CHARS
    ? `${name.slice(0, MAX_NAME_CHARS - 1)}…`
    : name
}

function basename(path: string): string {
  return path.split('/').pop() ?? path
}

function joinKeys(keys: string[], max = 5): string {
  const shown = keys.slice(0, max)
  const rest = keys.length - shown.length
  return rest > 0 ? `${shown.join(', ')} +${rest} more` : shown.join(', ')
}

function envCounts(index: ProjectIndex): Map<string, number> {
  const counts = new Map<string, number>()
  for (const file of index.files) {
    for (const env of file.environments) {
      counts.set(env.name, (counts.get(env.name) ?? 0) + env.count)
    }
  }
  return counts
}

function fileWithEnvironment(index: ProjectIndex, name: string): string | null {
  const hit = index.files.find(file =>
    file.environments.some(env => env.name === name)
  )
  return hit ? hit.path : null
}

function envCount(counts: Map<string, number>, ...names: string[]): number {
  return names.reduce((total, name) => total + (counts.get(name) ?? 0), 0)
}

function sectionTitles(index: ProjectIndex): string[] {
  return index.outline.sections.map(section =>
    section.title.replace(/\\[a-zA-Z]+\*?(\{[^}]*\})?/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
  )
}

function hasSection(index: ProjectIndex, wanted: string): boolean {
  return sectionTitles(index).some(title => title.includes(wanted))
}

function docLines(files: ProjectFile[]): number {
  return files
    .filter(file => file.type === 'doc')
    .reduce((total, file) => total + (file.lines ?? 0), 0)
}

export type StarterRuleResult = Omit<Starter, 'oneShot'>

/**
 * The rules, in priority order. Each returns at most one starter; the first
 * four that fire are what the user sees, so the order is the ranking.
 */
const RULES: Array<(signals: StarterSignals) => StarterRuleResult | null> = [
  // A failing build is the one thing blocking everything else.
  ({ lastCompile }) => {
    if (!lastCompile || lastCompile.errors.length === 0) return null
    const count = lastCompile.errors.length
    return {
      id: 'fix_compile_errors',
      params: { error_count: count },
      prompt: `Inspect the compile log and resolve the ${count} compile-blocking error${count === 1 ? '' : 's'} with minimal targeted edits across the affected files. Verify the fix with a clean compilation without modifying non-blocking warnings or hallucinating missing citations.`,
      priority: 100,
    }
  },

  // An environment the preamble never loaded cannot compile; the fix is one line.
  ({ index }) => {
    if (!index) return null
    const counts = envCounts(index)
    const loaded = new Set(index.packages.map(use => use.name))
    const provided = CLASS_PROVIDES[index.outline.documentClass ?? ''] ?? []
    const missing = Object.entries(ENV_PACKAGE).find(
      ([env, pkg]) =>
        (counts.get(env) ?? 0) > 0 && !loaded.has(pkg) && !provided.includes(env)
    )
    if (!missing) return null
    const [env, pkg] = missing
    const file = fileWithEnvironment(index, env) ?? index.rootPath ?? 'main.tex'
    const root = index.rootPath ?? 'main.tex'
    return {
      id: 'add_missing_package',
      params: { package_name: pkg },
      prompt: `Add \\usepackage{${pkg}} to the preamble in ${root} to support the ${env} environment in ${file}. Do not modify other files or fix unrelated compile errors.`,
      priority: 95,
    }
  },

  // Citations that resolve against nothing: the bibliography does not exist.
  ({ index, files }) => {
    if (!index) return null
    const cites = index.references.citations
    if (cites.length === 0 || index.hasThebibliography) return null
    if (files.some(file => file.path.endsWith('.bib'))) return null
    const keys = [...new Set(cites.map(cite => cite.key))]
    const root = index.rootPath ?? 'main.tex'
    return {
      id: 'add_bibliography',
      params: { cite_count: keys.length },
      prompt: `Create references.bib containing BibTeX entries for ${joinKeys(keys)}, read ${root} to add \\bibliographystyle{plain} and \\bibliography{references} before \\end{document}, and run compile_project to verify.`,
      priority: 90,
    }
  },

  // A .bib file exists but does not define every key the document cites —
  // distinct from add_bibliography above, which only fires when there is no
  // .bib file at all. index.references.citations[].resolved already checks
  // each cite against the project's actual bibKeys, so this needs no new
  // parsing, just a comparison nothing currently makes.
  ({ index, files }) => {
    if (!index || index.hasThebibliography) return null
    if (!files.some(file => file.path.endsWith('.bib'))) return null
    const unresolved = index.references.citations.filter(cite => !cite.resolved)
    if (unresolved.length === 0) return null
    const keys = [...new Set(unresolved.map(cite => cite.key))]
    const root = index.rootPath ?? 'main.tex'
    return {
      id: 'add_missing_bib_entries',
      params: { cite_count: keys.length },
      prompt: `Read the project's .bib file and add BibTeX entries for the citation keys it is missing (${joinKeys(keys)}), cited in ${root}, with accurate metadata for each. Do not modify entries that already exist, and run compile_project to verify no citation warnings remain.`,
      priority: 88,
    }
  },

  // Duplicate \label definitions make \ref silently point to the wrong location.
  ({ index }) => {
    if (!index) return null
    const dups = index.references?.duplicateLabels ?? []
    if (dups.length === 0) return null
    const keys = [...new Set(dups)]
    return {
      id: 'fix_duplicate_labels',
      params: { count: keys.length },
      prompt: `Fix ${keys.length} duplicate \\label definition${keys.length > 1 ? 's' : ''} in this project (${joinKeys(keys)}). Each \\label must be unique so cross-references resolve to the intended target. Update duplicate labels and their corresponding \\ref calls.`,
      priority: 87,
    }
  },

  // Undefined \ref targets: real keys the document never labels.
  ({ index }) => {
    if (!index) return null
    const broken = index.references.refs.filter(ref => !ref.resolved)
    if (broken.length === 0) return null
    const keys = [...new Set(broken.map(ref => ref.key))]
    return {
      id: 'resolve_broken_refs',
      params: { unresolved_ref_count: keys.length },
      prompt: `Resolve unresolved cross-references (${joinKeys(keys)}) by adding \\label tags to existing matching targets without inventing placeholder sections or tables. For references lacking an existing target in the document, identify them plainly and compile to verify any applied edits.`,
      priority: 85,
    }
  },

  // A build that passes but warns is the next cheapest win.
  ({ lastCompile, index }) => {
    if (!lastCompile || lastCompile.errors.length > 0) return null
    const count = lastCompile.warnings.length
    if (count === 0) return null
    const root = index?.rootPath ?? 'main.tex'
    return {
      id: 'resolve_warnings',
      params: { warning_count: count },
      prompt: `Inspect the build warnings and resolve the underlying issues across ${root} with minimal edits, avoiding unnecessary prose refactoring. Recompile to verify that the warnings are resolved.`,
      priority: 80,
    }
  },

  // Nothing but an empty shell: the only useful move is a first draft.
  // Needs the file listing: an unloaded listing is not evidence of emptiness.
  ({ index, files }) => {
    if (files.length === 0) return null
    const texFiles = files.filter(file => file.path.endsWith('.tex'))
    if (texFiles.length !== 1 || docLines(files) > 15) return null
    if (index && (index.outline.sections.length > 0 || index.outline.hasTitle)) {
      return null
    }
    const root = index?.rootPath ?? texFiles[0]?.path ?? 'main.tex'
    return {
      id: 'init_document_structure',
      params: {},
      prompt: `Add a standard starter structure (title, author, abstract, and introduction) to ${root} and compile the document to verify the first build.`,
      priority: 75,
    }
  },

  // A paper with a discussion but no conclusion is one section short.
  ({ index, openFile }) => {
    if (!index || index.outline.sections.length < 3) return null
    if (hasSection(index, 'conclusion') || hasSection(index, 'summary')) {
      return null
    }
    if (!hasSection(index, 'discussion') && !hasSection(index, 'result')) {
      return null
    }
    const file = openFile?.path ?? index.rootPath ?? 'main.tex'
    return {
      id: 'draft_conclusion',
      params: { file: clampName(basename(file)) },
      prompt: `Draft and append a concise Conclusion section to ${file} synthesizing the key findings and discussion points. Make minimal edits without inventing citations or unverified claims, and do not recompile for prose-only additions.`,
      priority: 70,
    }
  },

  // Complete structure but no abstract or title yet.
  ({ index }) => {
    if (!index || index.outline.sections.length < 3) return null
    const counts = envCounts(index)
    const hasAbstract = (counts.get('abstract') ?? 0) > 0
    if (hasAbstract && index.outline.hasTitle) return null
    const root = index.rootPath ?? 'main.tex'
    return {
      id: 'draft_abstract_title',
      params: { root_file: clampName(basename(root)) },
      prompt: hasAbstract
        ? `Suggest 3 candidate titles for this paper in your reply based on its section structure, without editing any file.`
        : `Draft a concise 200-word abstract in the abstract environment of ${root} based on the paper's section structure${index.outline.hasTitle ? '' : ', and suggest 3 candidate titles in your reply'}, without recompiling.`,
      priority: 65,
    }
  },

  // A substantial open file with nothing visually explaining it.
  ({ index, files, openFile }) => {
    if (!index || !openFile || !openFile.path.endsWith('.tex')) return null
    const counts = envCounts(index)
    if (envCount(counts, 'figure', 'table', 'tikzpicture') > 0) return null
    const open = files.find(file => file.path === openFile.path)
    if (!open || (open.lines ?? 0) < 100) return null
    return {
      id: 'add_summary_table',
      params: { file: clampName(basename(openFile.path)) },
      prompt: `Read ${openFile.path} and decide whether anything it describes in prose - parameters, comparisons, repeated measurements, results - would read better as a table. If so, build the table out of the values the text actually states, insert it in the passage that discusses them, and match the caption and label conventions the project already uses, adding any package it needs to ${index.rootPath ?? 'main.tex'}. Do not invent values and do not insert an empty skeleton: if nothing in the file is tabular, say so and insert nothing.`,
      priority: 60,
    }
  },

  // Same signal, weaker file: offer a figure instead of a table.
  ({ index, files, openFile }) => {
    if (!index || !openFile || !openFile.path.endsWith('.tex')) return null
    const counts = envCounts(index)
    if (envCount(counts, 'figure', 'tikzpicture') > 0) return null
    const open = files.find(file => file.path === openFile.path)
    if (!open || (open.lines ?? 0) < 60) return null
    return {
      id: 'add_figure_placeholder',
      params: { file: clampName(basename(openFile.path)) },
      prompt: `Read ${openFile.path}, find the one process or relationship the text describes but never shows, and insert a figure for it at the point where the text discusses it. Write the caption and label from the document's own wording, and draw the content from what the text says using whatever the preamble already loads. If the project loads nothing you can draw with, name the package you would add and why, and insert nothing.`,
      priority: 55,
    }
  },

  // Polishing prose is safe only once the build is clean.
  ({ index, files, openFile, lastCompile }) => {
    if (!index || !openFile || !openFile.path.endsWith('.tex')) return null
    if (lastCompile && lastCompile.errors.length > 0) return null
    const open = files.find(file => file.path === openFile.path)
    if (!open || (open.lines ?? 0) < 40) return null
    return {
      id: 'proofread_active_file',
      params: { file: clampName(basename(openFile.path)) },
      prompt: `Edit ${openFile.path} to tighten passive phrasing and fix grammar with minimal localized changes, preserving all citation keys, labels, and structure intact. Do not compile after these prose-only edits.`,
      priority: 50,
    }
  },
]

/** Shown only to fill empty slots, in this order, skipping collided twins. */
const FALLBACKS: Array<{
  id: StarterRuleId
  params: Record<string, string | number>
  /**
   * A function when the prompt needs to name the file the user is in. The
   * prompt tells the model what to read and what to ground the content in;
   * it never dictates the content itself or a line to insert at.
   */
  prompt: string | ((signals: StarterSignals) => string)
  /** Dynamic rules whose firing makes this fallback redundant. */
  collidesWith: StarterRuleId[]
}> = [
  {
    id: 'what_can_you_do',
    params: {},
    prompt:
      'List your primary capabilities and project editing tools for this LaTeX document, highlighting how you can help fix compile issues, refine prose, and manage cross-references.',
    collidesWith: [],
  },
  {
    id: 'beamer',
    params: {},
    prompt:
      'Help me create a clean, modern Beamer presentation slide deck with a title slide, agenda, and structured section frames.',
    collidesWith: [],
  },
  {
    id: 'generate_table',
    params: {},
    prompt: ({ openFile, index }) =>
      `Read ${openFile?.path ?? index?.rootPath ?? 'the root document'} and find content that is written as prose but is really tabular - parameters, comparisons, results. Build a table from those actual values, insert it where the text discusses them, and follow the caption, label and column conventions the document already uses, adding any package it needs to the preamble. If nothing in the file is tabular, say so instead of inserting a generic table.`,
    collidesWith: ['add_summary_table'],
  },
  {
    id: 'manage_bibliography',
    params: {},
    prompt:
      'Inspect the citations in this project and ensure all \\cite keys are properly defined in a .bib file with standard BibTeX entries and connected in the root document.',
    collidesWith: ['add_bibliography', 'add_missing_bib_entries'],
  },
  {
    id: 'generate_tikz',
    params: {},
    prompt: ({ openFile, index }) =>
      `Read ${openFile?.path ?? index?.rootPath ?? 'the root document'} and draw the structure or process it describes as a TikZ figure, using the real node labels and relationships the text names rather than a generic diagram. Insert it where the text discusses that structure, add \\usepackage{tikz} to the preamble if it is missing, and compile to verify.`,
    collidesWith: ['add_missing_package', 'add_figure_placeholder'],
  },
  {
    id: 'insert_equation',
    params: {},
    prompt: ({ openFile, index }) =>
      `Read ${openFile?.path ?? index?.rootPath ?? 'the root document'} and find a relationship it states in words but never sets as mathematics. Typeset that relationship as a display equation in the passage that states it, reusing the symbols and notation the document already defines, and number and label it only if the surrounding text refers to equations that way. If everything is already typeset, say so and change nothing.`,
    collidesWith: [],
  },
  {
    id: 'summarize',
    params: {},
    prompt:
      'Provide a concise executive summary of this project, its structure, key equations, and overall arguments.',
    collidesWith: [],
  },
]

/**
 * Derives the starters for a fresh chat from the project's current state.
 *
 * Returns exactly MAX_STARTERS: the highest-priority rules that fire, then
 * fallbacks for the remaining slots.
 */
export function deriveStarters(
  signals: StarterSignals,
  options?: { shuffle?: boolean }
): Starter[] {
  const safeSignals = { ...signals, files: signals.files ?? [] }
  const fired: Starter[] = RULES.map(rule => rule(safeSignals))
    .filter((starter): starter is StarterRuleResult => starter !== null)
    .map(starter => ({ ...starter, oneShot: true }))

  const picked: Starter[] = fired.slice(0, MAX_STARTERS)
  const firedIds = new Set(picked.map(starter => starter.id))

  let availableFallbacks = FALLBACKS.filter(
    fb => !fb.collidesWith.some(id => firedIds.has(id)) && !firedIds.has(fb.id)
  )

  if (options?.shuffle && availableFallbacks.length > 0) {
    const offset = Math.floor(Math.random() * availableFallbacks.length)
    availableFallbacks = [
      ...availableFallbacks.slice(offset),
      ...availableFallbacks.slice(0, offset),
    ]
  }

  for (const fallback of availableFallbacks) {
    if (picked.length >= MAX_STARTERS) break
    picked.push({
      id: fallback.id,
      params: fallback.params,
      prompt:
        typeof fallback.prompt === 'function'
          ? fallback.prompt(safeSignals)
          : fallback.prompt,
      priority: 0,
      oneShot: false,
    })
  }

  return picked
}
