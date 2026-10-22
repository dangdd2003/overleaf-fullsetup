import { ProjectIndex } from '../context/project-index'
import {
  envCount,
  envCounts,
  firedStarterIds,
  StarterRuleId,
  StarterSignals,
} from './derive-starters'

/**
 * The "Advanced tools" cards in the empty chat state.
 *
 * Starters are one concrete fix and selection actions are a local edit; an
 * advanced tool is a whole-project review pass, the kind a co-author or a
 * referee would do. Which two are shown follows the project: every rule reads
 * only the structural index and file listing the browser already holds, so
 * the cards are deterministic, need no provider call, and carry evidence from
 * the project in their description.
 *
 * Every prompt asks for a report first and edits nothing until the user picks
 * what to apply, so each card yields the same kind of answer every time.
 */

export type AdvancedToolId =
  | 'unsupported_statements'
  | 'reference_audit'
  | 'figures_tables'
  | 'notation'
  | 'unused_bib'
  | 'abstract_results'
  | 'structure_flow'
  | 'venue_format'
  | 'slide_density'

export type AdvancedTool = {
  id: AdvancedToolId
  /**
   * Interpolation values for the translated description. Empty for the
   * generic cards shown when the project offers no evidence.
   */
  params: Record<string, string | number>
  /** Sent verbatim to the model when the user picks this card. */
  prompt: string
  priority: number
}

/** Cards shown; the space is shared with the starters below them. */
export const MAX_ADVANCED_TOOLS = 2

/** Below this many lines of source, a whole-project audit has nothing to find. */
export const MIN_AUDIT_LINES = 40

/** Classes whose venue has submission rules worth checking against. */
const VENUES: Record<string, string> = {
  IEEEtran: 'IEEE',
  acmart: 'ACM',
  llncs: 'Springer LNCS',
  elsarticle: 'Elsevier',
  'revtex4-1': 'REVTeX (APS/AIP)',
  'revtex4-2': 'REVTeX (APS/AIP)',
}

/** Label prefixes that name a figure or a table. */
const FLOAT_LABEL = /^(?:fig|figure|tab|table|subfig)[:._-]/i

const RESULT_SECTION = /result|evaluation|experiment|discussion|conclusion|finding/
const MIN_FLOATS = 2
const MIN_EQUATIONS = 10
const MIN_SECTIONS = 4
const MIN_STRUCTURE_LINES = 300
/** A prose project citing less often than this many lines per citation is thinly referenced. */
const SPARSE_CITATION_LINES = 60

/** Starters whose concrete fix makes the reference audit a duplicate. */
const REFERENCE_STARTERS: StarterRuleId[] = [
  'add_bibliography',
  'add_missing_bib_entries',
  'fix_duplicate_labels',
  'resolve_broken_refs',
]

/** The report format every audit asks for. */
const REPORT =
  'Report the findings as a numbered list ordered by importance, each with its file:line, the problem, and the fix you suggest. Do not edit any file until I say which fixes to apply. If you find nothing, say so plainly.'

type Context = {
  index: ProjectIndex
  counts: Map<string, number>
  lines: number
  root: string
  beamer: boolean
  starterIds: Set<StarterRuleId>
}

function docLines(signals: StarterSignals): number {
  return signals.files
    .filter(file => file.type === 'doc' && /\.(tex|ltx)$/i.test(file.path))
    .reduce((total, file) => total + (file.lines ?? 0), 0)
}

function filesWithEnv(index: ProjectIndex, ...names: string[]): number {
  return index.files.filter(file =>
    file.environments.some(env => names.includes(env.name))
  ).length
}

function sectionTitles(index: ProjectIndex): string[] {
  return index.outline.sections.map(section => section.title.toLowerCase())
}

function referencedKeys(index: ProjectIndex): Set<string> {
  return new Set(index.references.refs.map(ref => ref.key))
}

const RULES: Array<(context: Context) => AdvancedTool | null> = [
  // A deck is reviewed slide by slide, not as a paper.
  ({ beamer, root }) => {
    if (!beamer) return null
    return {
      id: 'slide_density',
      params: {},
      prompt: `Review this Beamer presentation (${root}) slide by slide for density: frames with too much text or too many bullets, equations or tables too large to read from the back of a room, and sections with too many or too few frames. ${REPORT}`,
      priority: 100,
    }
  },

  // Floats the text never points to are the commonest referee complaint about figures.
  ({ index, counts }) => {
    const floats = envCount(counts, 'figure', 'table')
    if (floats < MIN_FLOATS) return null
    const referenced = referencedKeys(index)
    const unreferenced = index.references.labels.filter(
      label => FLOAT_LABEL.test(label.key) && !referenced.has(label.key)
    ).length
    return {
      id: 'figures_tables',
      params: { float_count: floats, unreferenced_count: unreferenced },
      prompt: `Audit every figure and table in this project: each one is referenced in the text before or near where it appears, its \\label comes after its \\caption, its caption stands on its own, and its placement and width suit the page. ${REPORT}`,
      priority: unreferenced > 0 ? 85 : 60,
    }
  },

  // The parser already sees broken refs and missing keys; starters fix those.
  // This pass checks what it cannot: placement, style and unused labels.
  ({ index, starterIds }) => {
    if (REFERENCE_STARTERS.some(id => starterIds.has(id))) return null
    const { labels, refs, citations } = index.references
    if (labels.length + refs.length + citations.length === 0) return null
    const referenced = referencedKeys(index)
    const unreferenced = labels.filter(label => !referenced.has(label.key)).length
    return {
      id: 'reference_audit',
      params: { label_count: labels.length, unreferenced_count: unreferenced },
      prompt: `Audit this project's cross-references and citations beyond what fails to compile: call get_references, then check for labels nothing refers to, \\label placed before \\caption, a missing non-breaking space before \\ref and \\cite, mixed \\ref, \\cref and \\autoref styles, and citation commands used inconsistently. ${REPORT}`,
      priority: unreferenced > 0 ? 80 : 50,
    }
  },

  // A thinly cited paper is what "unsupported statements" exists for.
  ({ index, lines, beamer }) => {
    if (beamer) return null
    const cites = index.references.citations.length
    const perCite = cites === 0 ? 0 : Math.round(lines / cites)
    const sparse = cites === 0 || perCite >= SPARSE_CITATION_LINES
    return {
      id: 'unsupported_statements',
      params: { line_count: lines, citation_count: cites, lines_per_citation: perCite },
      prompt: `Scan this project for statements that need a citation and have none: claims about prior work, the state of the art, widely held facts, and figures or statistics taken from elsewhere. Leave the paper's own results and definitions alone, and check the project's .bib files before proposing any new source. ${REPORT}`,
      priority: sparse ? 75 : 45,
    }
  },

  // Cited-but-never-used entries inflate the bibliography some styles print.
  ({ index }) => {
    const bibKeys = new Set(index.references.bibKeys.map(entry => entry.key))
    if (bibKeys.size === 0) return null
    const cited = new Set(index.references.citations.map(cite => cite.key))
    const unused = [...bibKeys].filter(key => !cited.has(key)).length
    if (unused === 0) return null
    return {
      id: 'unused_bib',
      params: { unused_count: unused, entry_count: bibKeys.size },
      prompt: `Audit the project's .bib files: entries never cited in the document, duplicate entries for the same work under different keys, and entries missing fields their type requires (author, title, year, venue, DOI where one exists). Never invent publication details. ${REPORT}`,
      priority: 70,
    }
  },

  // An abstract written before the results drifts from them.
  ({ index, counts, beamer }) => {
    if (beamer || envCount(counts, 'abstract') === 0) return null
    if (!sectionTitles(index).some(title => RESULT_SECTION.test(title))) return null
    return {
      id: 'abstract_results',
      params: {},
      prompt: `Read the abstract, then the results, discussion and conclusion of this project, and check that every claim and number in the abstract is backed by what those sections actually report, and that no key result is missing from it. ${REPORT}`,
      priority: 68,
    }
  },

  // Many equations across files is where notation drifts.
  ({ index, counts }) => {
    const equations = envCount(counts, 'equation', 'align')
    if (equations < MIN_EQUATIONS) return null
    return {
      id: 'notation',
      params: {
        equation_count: equations,
        file_count: filesWithEnv(index, 'equation', 'align'),
      },
      prompt: `Audit the mathematical notation across this project: the same quantity written with different symbols, one symbol used for different things, symbols used before they are defined, and inconsistent styling of vectors, matrices and sets. Prefer the macros the preamble already defines. ${REPORT}`,
      priority: 65,
    }
  },

  // A known template comes with rules a reviewer will hold the paper to.
  ({ index, beamer }) => {
    if (beamer) return null
    const venue = VENUES[index.outline.documentClass ?? '']
    if (!venue) return null
    return {
      id: 'venue_format',
      params: { venue },
      prompt: `This project uses the ${index.outline.documentClass} class. Check it against ${venue}'s usual submission conventions: front matter and author block, section and caption style, reference style, packages the template discourages, and anything that changes the template's layout. Say which points depend on the specific venue's instructions. ${REPORT}`,
      priority: 58,
    }
  },

  // A long document with real structure can be read for its argument.
  ({ index, lines, beamer }) => {
    if (beamer || lines < MIN_STRUCTURE_LINES) return null
    const sections = index.outline.sections.filter(section => section.level <= 1).length
    if (sections < MIN_SECTIONS) return null
    return {
      id: 'structure_flow',
      params: { section_count: sections },
      prompt: `Review this document as a referee would for structure and argument: call get_outline, then read it section by section for the flow of the argument, sections that are much longer or shorter than their weight, content that is repeated, and steps the reader has to take on trust. ${REPORT}`,
      priority: 55,
    }
  },
]

/** The cards shown when the project offers no evidence: today's two, worded generically. */
function genericTools(root: string): AdvancedTool[] {
  return [
    {
      id: 'unsupported_statements',
      params: {},
      prompt: `Scan this project, starting from ${root}, for statements that need a citation and have none: claims about prior work, the state of the art, widely held facts, and figures or statistics taken from elsewhere. Leave the paper's own results and definitions alone, and check the project's .bib files before proposing any new source. ${REPORT}`,
      priority: 0,
    },
    {
      id: 'reference_audit',
      params: {},
      prompt: `Audit this project's cross-references and citations: call get_references and check for duplicate labels, unresolved \\ref calls, citation keys missing from the bibliography, labels nothing refers to, and \\label placed before \\caption. ${REPORT}`,
      priority: 0,
    },
  ]
}

/**
 * The advanced tools for a fresh chat, best first, at most MAX_ADVANCED_TOOLS.
 * Deterministic: the same project state always yields the same cards.
 */
export function deriveAdvancedTools(signals: StarterSignals): AdvancedTool[] {
  const safeSignals = { ...signals, files: signals.files ?? [] }
  const { index } = safeSignals
  const root = index?.rootPath ?? 'main.tex'
  const lines = docLines(safeSignals)
  const generic = genericTools(root)
  if (!index || lines < MIN_AUDIT_LINES) return generic

  const starterIds = firedStarterIds(safeSignals)
  const context: Context = {
    index,
    counts: envCounts(index),
    lines,
    root,
    beamer: index.outline.documentClass === 'beamer',
    starterIds,
  }

  // Stable sort: equal priorities keep the rule order.
  const picked = RULES.map(rule => rule(context))
    .filter((tool): tool is AdvancedTool => tool !== null)
    .sort((a, b) => b.priority - a.priority)
    .slice(0, MAX_ADVANCED_TOOLS)

  for (const fallback of generic) {
    if (picked.length >= MAX_ADVANCED_TOOLS) break
    if (picked.some(tool => tool.id === fallback.id)) continue
    // A deck is not a paper: it has no claims to support with citations.
    if (fallback.id === 'unsupported_statements' && context.beamer) continue
    // A reference card would repeat a starter that already fixes the same thing.
    if (
      fallback.id === 'reference_audit' &&
      REFERENCE_STARTERS.some(id => starterIds.has(id))
    ) {
      continue
    }
    picked.push(fallback)
  }
  return picked
}
