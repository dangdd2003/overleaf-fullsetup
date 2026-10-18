import { classifySelectionText } from './classify-selection'
import {
  MAX_SELECTION_ACTIONS,
  SelectionAction,
  SelectionActionId,
  SelectionCue,
  SelectionInput,
  SelectionKind,
  SelectionScope,
} from './selection-types'

/**
 * The one-click prompts a highlighted selection offers.
 *
 * Each kind has a fixed rank order; the scope flags (numeric, length, inline
 * math) and the content cues only move entries up or swap in a better fit. The prompts are instructions sent to the
 * model, so they are untranslated English, and each names the selection by
 * its line range.
 */

/** Rank order per kind, best first. */
const RANKED: Record<SelectionKind, SelectionActionId[]> = {
  prose: [
    'refine_writing',
    'make_concise',
    'fix_grammar',
    'explain_meaning',
    'suggest_citation',
    'make_scientific',
    'prose_to_list',
    'prose_to_diagram',
  ],
  heading: [
    'suggest_title',
    'draft_section_intro',
    'summarize_section',
    'fix_grammar',
  ],
  list: [
    'parallel_list',
    'list_to_prose',
    'list_to_table',
    'refine_writing',
    'make_concise',
  ],
  math: [
    'explain_equation',
    'check_equation',
    'define_symbols',
    'align_equation',
  ],
  table: [
    'improve_table',
    'fix_table',
    'fit_table_width',
    'table_to_chart',
    'explain_table',
  ],
  figure: [
    'improve_caption',
    'reference_figure',
    'figure_to_subfigures',
    'fix_latex_errors',
    'explain_latex',
  ],
  tikz: ['explain_tikz', 'polish_tikz', 'fix_tikz', 'annotate_tikz'],
  code: ['explain_code', 'format_listing', 'fix_latex_errors'],
  preamble: ['explain_packages', 'clean_preamble', 'fix_latex_errors'],
  bibtex: ['fix_bibtex', 'complete_bibtex'],
  citation: ['verify_citation', 'find_more_sources'],
  latex: ['explain_latex', 'fix_latex_errors', 'change_formatting'],
}

/** Each prompt takes `where`, the selection's line range in its file. */
const PROMPTS: Record<SelectionActionId, (where: string) => string> = {
  refine_writing: where =>
    `Refine the writing of the selected text (${where}): improve clarity, flow and academic tone while keeping its meaning and every citation, reference, label and math expression unchanged. Apply the rewrite with edit_file, changing only the selected lines.`,
  make_concise: where =>
    `Make the selected text (${where}) more concise: cut redundancy and filler without losing any claim, citation, reference or math. Apply it with edit_file, changing only the selected lines.`,
  make_scientific: where =>
    `Rewrite the selected text (${where}) in a precise, formal scientific register: exact terminology, claims hedged where the evidence calls for it, no informal phrasing. Keep citations, references, labels and math unchanged and apply it with edit_file to the selected lines only.`,
  fix_grammar: where =>
    `Fix grammar, spelling and punctuation in the selected text (${where}) with minimal changes; leave sentences that are already correct alone. Apply the fixes with edit_file to the selected lines only.`,
  explain_meaning: where =>
    `Explain what the selected text (${where}) means in plain language, including the technical terms it relies on. Do not edit any file.`,
  suggest_citation: where =>
    `Suggest citations that would support the claims in the selected text (${where}). Check the project's .bib files first and prefer keys that already exist; for anything new give complete BibTeX entries only for works you are confident exist, and say plainly when you are unsure. Do not edit any file until I confirm.`,
  summarize_selection: where =>
    `Summarize the selected text (${where}) in two or three sentences. Do not edit any file.`,
  prose_to_table: where =>
    `The selected text (${where}) states several values in prose. Build a LaTeX table from exactly those values, inventing none, insert it right after the passage with a caption and \\label that follow the document's conventions, and add any package it needs to the preamble.`,
  prose_to_list: where =>
    `Restructure the selected text (${where}) as an itemize or enumerate list, one point per item, keeping its wording, citations and references. Apply it with edit_file to the selected lines only.`,
  prose_to_diagram: where =>
    `Draw the process or structure described in the selected text (${where}) as a TikZ figure, using the names and relationships the text gives rather than a generic diagram. Insert it after the passage inside a figure environment with a caption and \\label, add \\usepackage{tikz} to the preamble if it is missing, and compile to verify.`,
  suggest_title: where =>
    `Suggest three better titles for the selected heading (${where}), based on what its section actually says: read the section first. Do not edit any file until I pick one.`,
  draft_section_intro: where =>
    `Read the section that starts at the selected heading (${where}) and write a short opening paragraph that previews what it covers. Insert it directly after the heading with edit_file, without inventing results or citations.`,
  summarize_section: where =>
    `Read the section that starts at the selected heading (${where}) and summarize it in a short paragraph. Do not edit any file.`,
  parallel_list: where =>
    `Make the items of the selected list (${where}) grammatically parallel and consistent in length and punctuation, keeping their content. Apply it with edit_file to the selected lines only.`,
  list_to_prose: where =>
    `Rewrite the selected list (${where}) as a flowing paragraph with proper transitions, keeping every point, citation and reference. Apply it with edit_file to the selected lines only.`,
  list_to_table: where =>
    `Convert the selected list (${where}) into a LaTeX table whose columns follow the structure the items share, with a caption and \\label. Replace the list with edit_file and add any package the table needs to the preamble.`,
  explain_equation: where =>
    `Explain the selected math (${where}): what each term and symbol means and what the expression states. Do not edit any file.`,
  check_equation: where =>
    `Check the selected math (${where}) for errors: LaTeX syntax, unbalanced delimiters, notation that disagrees with the rest of the document, and algebraic slips you can verify. Report what you find, then propose fixes with edit_file limited to the selected lines.`,
  define_symbols: where =>
    `Find the symbols in the selected math (${where}) that the document never defines, and add a short "where …" clause after it defining them in the document's own notation. Apply it with edit_file.`,
  align_equation: where =>
    `Reformat the selected math (${where}) for readability: break long expressions across lines with amsmath align or split, align on relation symbols, and keep its numbering and \\label as they are. Apply it with edit_file to the selected lines only.`,
  equation_to_display: where =>
    `Turn the selected inline math (${where}) into a numbered display equation with a \\label that follows the document's conventions, adjusting the surrounding sentence so it still reads correctly. Apply it with edit_file.`,
  improve_table: where =>
    `Polish the selected table (${where}) for publication: booktabs rules instead of vertical lines, numeric columns aligned, consistent units and precision, and the caption above the table. Keep every value unchanged, add booktabs to the preamble if it is missing, apply it with edit_file and compile to verify.`,
  fix_table: where =>
    `Find and fix LaTeX errors in the selected table (${where}): column-count mismatches, missing \\\\, stray &, unbalanced braces or rules. Apply minimal fixes with edit_file and compile to verify.`,
  fit_table_width: where =>
    `Make the selected table (${where}) fit the text width while staying readable: tabularx or adjusted column types, line breaks in long headers, and \\resizebox only as a last resort. Apply it with edit_file and compile to verify.`,
  table_to_chart: where =>
    `Plot the data in the selected table (${where}) as a pgfplots chart in a new figure right after the table, choosing a chart type that suits the data, with axis labels, a caption and a \\label. Add pgfplots to the preamble if it is missing and compile to verify.`,
  explain_table: where =>
    `Explain the selected table (${where}): what it shows, how its LaTeX is built, and any trends in its values. Do not edit any file.`,
  improve_caption: where =>
    `Rewrite the caption of the selected figure (${where}) so it stands on its own: what is shown, the key takeaway, and any notation needed to read it. Keep the \\label and apply it with edit_file.`,
  reference_figure: where =>
    `Make sure the selected figure (${where}) has a \\label and is referenced with \\ref where the text discusses it; add whichever is missing, with one natural in-text reference. Apply it with edit_file.`,
  figure_to_subfigures: where =>
    `Restructure the selected figure (${where}) into subfigures with the subcaption package, giving each panel its own caption and \\label and keeping the existing images. Add subcaption to the preamble if it is missing, apply it with edit_file and compile to verify.`,
  explain_tikz: where =>
    `Explain the selected TikZ code (${where}): what it draws, how its nodes, paths and styles fit together, and how to adjust it. Do not edit any file.`,
  polish_tikz: where =>
    `Refactor the selected TikZ code (${where}) for a cleaner, consistent look: shared styles, even spacing, and relative positioning instead of hard-coded coordinates where that is simple. Keep what it draws the same, apply it with edit_file and compile to verify.`,
  fix_tikz: where =>
    `Find and fix errors in the selected TikZ code (${where}): missing semicolons, unknown keys or libraries, unbalanced braces. Add any missing \\usetikzlibrary to the preamble, apply minimal fixes with edit_file and compile to verify.`,
  annotate_tikz: where =>
    `Add clear labels, arrows and, if it helps, a legend to the selected TikZ drawing (${where}), using the names the surrounding text uses. Apply it with edit_file and compile to verify.`,
  explain_code: where =>
    `Explain the selected code (${where}) and how it is typeset in LaTeX. Do not edit any file.`,
  format_listing: where =>
    `Typeset the selected code block (${where}) as a proper listing (listings or minted) with its language, line numbers, a caption and a \\label, keeping the code itself unchanged. Add the package to the preamble if it is missing, apply it with edit_file and compile to verify.`,
  explain_packages: where =>
    `Explain what each package and setting in the selected preamble lines (${where}) does, and flag any that are redundant, conflicting or unused in this project. Do not edit any file.`,
  clean_preamble: where =>
    `Clean up the selected preamble lines (${where}): remove duplicates and packages the project never uses, order packages so known conflicts are avoided (hyperref near the end), and keep everything the document needs. Apply it with edit_file and compile to verify.`,
  fix_bibtex: where =>
    `Check the selected BibTeX entries (${where}) for errors: missing required fields, malformed author lists, unescaped special characters, title capitalization that BibTeX will lowercase. Apply fixes with edit_file to the selected lines only and never invent publication details.`,
  complete_bibtex: where =>
    `Complete the selected BibTeX entries (${where}) with their missing fields (DOI, pages, volume, publisher) only where you are certain of the value; leave a field out rather than guess. Apply it with edit_file.`,
  verify_citation: where =>
    `Check whether the selected citation (${where}) supports the sentence it is attached to: read its .bib entry and the surrounding text, then tell me what the source is, whether it fits, and whether a better one is likely needed. Do not edit any file.`,
  find_more_sources: where =>
    `Find additional sources for the claim cited at ${where}, preferring well-known peer-reviewed work. Give complete BibTeX for each and say how confident you are that it exists. Do not edit any file.`,
  explain_latex: where =>
    `Explain the LaTeX code in the selection (${where}): what each command and environment does and how it affects the output. Do not edit any file.`,
  fix_latex_errors: where =>
    `Identify any LaTeX errors in the selected text (${where}) and fix them with minimal edits via edit_file, limited to the selected lines, then compile to verify.`,
  define_term: where =>
    `Define the term selected at ${where} as this document uses it: read the surrounding text first, then give a concise definition and say whether the document defines it before first use. If it does not, suggest where a one-sentence definition would fit. Do not edit any file.`,
  tighten_abstract: where =>
    `Tighten the selected abstract text (${where}): state the problem, the approach, the key result and the contribution in that order, cut filler, and keep it within the usual 150-250 words. Keep every number and claim exactly as accurate as it is, and apply it with edit_file to the selected lines only.`,
  change_formatting: where =>
    `I want to change the formatting of the selected text (${where}). Ask me what I would like to change, with a few short suggestions for how you can help.`,
}

/** Actions expected to change the document. */
const EDITS = new Set<SelectionActionId>([
  'refine_writing',
  'make_concise',
  'make_scientific',
  'fix_grammar',
  'prose_to_table',
  'prose_to_list',
  'prose_to_diagram',
  'draft_section_intro',
  'parallel_list',
  'list_to_prose',
  'list_to_table',
  'check_equation',
  'define_symbols',
  'align_equation',
  'equation_to_display',
  'improve_table',
  'fix_table',
  'fit_table_width',
  'table_to_chart',
  'improve_caption',
  'reference_figure',
  'figure_to_subfigures',
  'polish_tikz',
  'fix_tikz',
  'annotate_tikz',
  'format_listing',
  'clean_preamble',
  'fix_bibtex',
  'complete_bibtex',
  'fix_latex_errors',
  'tighten_abstract',
])

/** A bare term or noun phrase: defining it beats rewriting it. */
const TERM_ACTIONS: Partial<Record<SelectionKind, SelectionActionId[]>> = {
  prose: ['define_term', 'explain_meaning', 'suggest_citation', 'fix_grammar'],
  latex: ['define_term', 'explain_meaning', 'suggest_citation', 'change_formatting'],
}

/**
 * Prose cues, weakest first: each moves its action up to `slot`, so a later,
 * stronger cue lands above an earlier one when both fire.
 */
const PROSE_CUES: Array<{ cue: SelectionCue; id: SelectionActionId; slot: number }> = [
  { cue: 'process', id: 'prose_to_diagram', slot: 2 },
  { cue: 'enumeration', id: 'prose_to_list', slot: 2 },
  { cue: 'wordy', id: 'make_concise', slot: 1 },
  { cue: 'informal', id: 'make_scientific', slot: 1 },
  { cue: 'introduction', id: 'suggest_citation', slot: 1 },
  { cue: 'uncited_claim', id: 'suggest_citation', slot: 1 },
  { cue: 'abstract', id: 'tighten_abstract', slot: 0 },
]

/** Moves `id` up to `slot`, adding it when absent; never moves it down. */
function promote(ids: SelectionActionId[], id: SelectionActionId, slot: number) {
  const at = ids.indexOf(id)
  if (at !== -1 && at <= slot) return
  if (at !== -1) ids.splice(at, 1)
  ids.splice(slot, 0, id)
}

/**
 * The applicable action ids for a selection, best first. Callers take the top
 * few; `deriveSelectionActions` does that. `text` is part of the signature but
 * the scope already carries everything the rules read.
 */
export function selectionActionIds(
  scope: SelectionScope,
  text: string
): SelectionActionId[] {
  const cues = scope.cues ?? []
  const term = cues.includes('term') ? TERM_ACTIONS[scope.kind] : undefined
  if (term) return [...term]

  const ids = [...RANKED[scope.kind]]
  if (scope.kind === 'prose') {
    if (scope.numeric) ids.splice(1, 0, 'prose_to_table')
    if (scope.lines >= 8) ids.splice(2, 0, 'summarize_selection')
    for (const { cue, id, slot } of PROSE_CUES) {
      if (cues.includes(cue)) promote(ids, id, slot)
    }
  }
  if (scope.kind === 'math' && scope.inline) {
    // Inline math is not a display: offer the conversion in place of alignment.
    ids.splice(ids.indexOf('align_equation'), 1)
    ids.splice(1, 0, 'equation_to_display')
  }
  return ids
}

/**
 * The one-click actions for a selection, best first, capped at `max`.
 * Deterministic: the same selection always yields the same prompts.
 */
export function deriveSelectionActions(
  selection: SelectionInput,
  max = MAX_SELECTION_ACTIONS
): SelectionAction[] {
  const { path, from, to, text } = selection
  const scope = selection.scope ?? classifySelectionText(text, path)
  const where =
    from === to ? `line ${from} of ${path}` : `lines ${from}-${to} of ${path}`
  return selectionActionIds(scope, text)
    .slice(0, max)
    .map(id => ({ id, prompt: PROMPTS[id](where), edits: EDITS.has(id) }))
}
