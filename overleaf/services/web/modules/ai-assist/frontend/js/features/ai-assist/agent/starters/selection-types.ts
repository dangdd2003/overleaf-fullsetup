/**
 * Selection-aware quick actions: the shared vocabulary.
 *
 * The editor bridge classifies what the user highlighted (a `SelectionScope`),
 * and the chat panel turns that scope into a ranked list of one-click prompts
 * (`SelectionAction`s), shown as cards in the empty chat and as chips above the
 * composer. Overleaf Cloud picks three prompts at random from one fixed list
 * for "any selection"; here the list follows what the selection actually is.
 */

/** What the highlighted LaTeX is, coarsest structure first. */
export type SelectionKind =
  | 'prose'
  | 'math'
  | 'table'
  | 'figure'
  | 'tikz'
  | 'list'
  | 'heading'
  | 'code'
  | 'preamble'
  | 'bibtex'
  | 'citation'
  | 'latex'

/**
 * What the words of a prose (or short LaTeX) selection suggest, read from the
 * text itself and, for the section ones, from the heading above it. They only
 * reorder the actions a kind already offers; none changes the kind.
 */
export type SelectionCue =
  /** A claim of evidence or a percentage with no citation command. */
  | 'uncited_claim'
  /** Contractions or conversational words. */
  | 'informal'
  /** Long sentences or several filler phrases. */
  | 'wordy'
  /** Ordinals, semicolon runs or (i)/(ii) markers: a list in disguise. */
  | 'enumeration'
  /** Steps, stages or arrows: a process that could be drawn. */
  | 'process'
  /** A bare word or noun phrase, not a sentence. */
  | 'term'
  /** Inside the abstract. */
  | 'abstract'
  /** Under an Introduction heading. */
  | 'introduction'

export type SelectionScope = {
  kind: SelectionKind
  /** The environment that decided the kind (`tabular`, `align*`…), or null when none did. */
  env: string | null
  /** Lines the selection spans, at least 1. */
  lines: number
  /** Prose or a list stating at least three numbers: a table candidate. */
  numeric: boolean
  /** Math written inline (`$…$`, `\(…\)`), not as a display environment. */
  inline: boolean
  /** Content cues, in a fixed order; absent from older senders. */
  cues?: SelectionCue[]
}

export type SelectionActionId =
  // prose
  | 'refine_writing'
  | 'make_concise'
  | 'make_scientific'
  | 'fix_grammar'
  | 'explain_meaning'
  | 'suggest_citation'
  | 'summarize_selection'
  | 'prose_to_table'
  | 'prose_to_list'
  | 'prose_to_diagram'
  // heading
  | 'suggest_title'
  | 'draft_section_intro'
  | 'summarize_section'
  // list
  | 'parallel_list'
  | 'list_to_prose'
  | 'list_to_table'
  // math
  | 'explain_equation'
  | 'check_equation'
  | 'define_symbols'
  | 'align_equation'
  | 'equation_to_display'
  // table
  | 'improve_table'
  | 'fix_table'
  | 'fit_table_width'
  | 'table_to_chart'
  | 'explain_table'
  // figure
  | 'improve_caption'
  | 'reference_figure'
  | 'figure_to_subfigures'
  // tikz
  | 'explain_tikz'
  | 'polish_tikz'
  | 'fix_tikz'
  | 'annotate_tikz'
  // code
  | 'explain_code'
  | 'format_listing'
  // preamble
  | 'explain_packages'
  | 'clean_preamble'
  // bibtex
  | 'fix_bibtex'
  | 'complete_bibtex'
  // citation
  | 'verify_citation'
  | 'find_more_sources'
  // any LaTeX
  | 'explain_latex'
  | 'fix_latex_errors'
  | 'change_formatting'
  // content cues
  | 'define_term'
  | 'tighten_abstract'

export type SelectionAction = {
  id: SelectionActionId
  /** Sent verbatim to the model. English, untranslated: an instruction, not UI copy. */
  prompt: string
  /** True when the action is expected to change the document. */
  edits: boolean
}

/** What a selection action needs to know about the selection; line numbers are 1-based. */
export type SelectionInput = {
  path: string
  from: number
  to: number
  text: string
  scope?: SelectionScope
}

/** Cards in the empty chat state. */
export const MAX_SELECTION_ACTIONS = 5

/** Chips above the composer once a chat has started. */
export const MAX_SELECTION_CHIPS = 3
