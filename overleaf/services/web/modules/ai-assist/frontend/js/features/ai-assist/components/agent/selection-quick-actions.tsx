import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Lightbulb, PencilSimpleLine } from '@phosphor-icons/react'
import OLButton from '@/shared/components/ol/ol-button'
import {
  MAX_SELECTION_ACTIONS,
  MAX_SELECTION_CHIPS,
  SelectionAction,
  SelectionActionId,
  SelectionInput,
  SelectionKind,
} from '../../agent/starters/selection-types'
import { deriveSelectionActions } from '../../agent/starters/selection-actions'
import { classifySelectionText } from '../../agent/starters/classify-selection'

/**
 * Selection-aware quick action labels.
 *
 * Each `t()` call is a string literal so the static translation extractor
 * (`yarn extract-translations`) indexes every key.
 */
function useSelectionActionLabel(): (id: SelectionActionId) => string {
  const { t } = useTranslation()

  return (id: SelectionActionId): string => {
    switch (id) {
      case 'refine_writing':
        return t('ai_assist_sel_refine_writing', 'Refine my writing')
      case 'make_concise':
        return t('ai_assist_sel_make_concise', 'Make concise')
      case 'make_scientific':
        return t('ai_assist_sel_make_scientific', 'Make scientific')
      case 'fix_grammar':
        return t('ai_assist_sel_fix_grammar', 'Fix grammar and spelling')
      case 'explain_meaning':
        return t('ai_assist_sel_explain_meaning', 'Explain what this means')
      case 'suggest_citation':
        return t('ai_assist_sel_suggest_citation', 'Suggest a citation')
      case 'summarize_selection':
        return t('ai_assist_sel_summarize_selection', 'Summarize the selection')
      case 'prose_to_table':
        return t(
          'ai_assist_sel_prose_to_table',
          'Turn these values into a table'
        )
      case 'prose_to_list':
        return t('ai_assist_sel_prose_to_list', 'Turn into a bullet list')
      case 'prose_to_diagram':
        return t(
          'ai_assist_sel_prose_to_diagram',
          'Draw this as a TikZ diagram'
        )
      case 'suggest_title':
        return t('ai_assist_sel_suggest_title', 'Suggest a better title')
      case 'draft_section_intro':
        return t(
          'ai_assist_sel_draft_section_intro',
          'Draft an opening paragraph'
        )
      case 'summarize_section':
        return t('ai_assist_sel_summarize_section', 'Summarize this section')
      case 'parallel_list':
        return t('ai_assist_sel_parallel_list', 'Make the items parallel')
      case 'list_to_prose':
        return t('ai_assist_sel_list_to_prose', 'Turn into a paragraph')
      case 'list_to_table':
        return t('ai_assist_sel_list_to_table', 'Turn into a table')
      case 'explain_equation':
        return t('ai_assist_sel_explain_equation', 'Explain this equation')
      case 'check_equation':
        return t('ai_assist_sel_check_equation', 'Check the math for errors')
      case 'define_symbols':
        return t('ai_assist_sel_define_symbols', 'Define the symbols')
      case 'align_equation':
        return t('ai_assist_sel_align_equation', 'Align and break long lines')
      case 'equation_to_display':
        return t(
          'ai_assist_sel_equation_to_display',
          'Make it a numbered equation'
        )
      case 'improve_table':
        return t('ai_assist_sel_improve_table', 'Polish this table')
      case 'fix_table':
        return t('ai_assist_sel_fix_table', 'Fix table errors')
      case 'fit_table_width':
        return t('ai_assist_sel_fit_table_width', 'Fit table to page width')
      case 'table_to_chart':
        return t('ai_assist_sel_table_to_chart', 'Plot this table as a chart')
      case 'explain_table':
        return t('ai_assist_sel_explain_table', 'Explain this table')
      case 'improve_caption':
        return t('ai_assist_sel_improve_caption', 'Improve the caption')
      case 'reference_figure':
        return t(
          'ai_assist_sel_reference_figure',
          'Label and reference this figure'
        )
      case 'figure_to_subfigures':
        return t('ai_assist_sel_figure_to_subfigures', 'Split into subfigures')
      case 'explain_tikz':
        return t('ai_assist_sel_explain_tikz', 'Explain this TikZ code')
      case 'polish_tikz':
        return t('ai_assist_sel_polish_tikz', 'Clean up the TikZ styling')
      case 'fix_tikz':
        return t('ai_assist_sel_fix_tikz', 'Fix TikZ errors')
      case 'annotate_tikz':
        return t('ai_assist_sel_annotate_tikz', 'Add labels and arrows')
      case 'explain_code':
        return t('ai_assist_sel_explain_code', 'Explain this code')
      case 'format_listing':
        return t('ai_assist_sel_format_listing', 'Typeset as a code listing')
      case 'explain_packages':
        return t('ai_assist_sel_explain_packages', 'Explain these packages')
      case 'clean_preamble':
        return t('ai_assist_sel_clean_preamble', 'Clean up the preamble')
      case 'fix_bibtex':
        return t('ai_assist_sel_fix_bibtex', 'Fix these BibTeX entries')
      case 'complete_bibtex':
        return t('ai_assist_sel_complete_bibtex', 'Complete missing fields')
      case 'verify_citation':
        return t('ai_assist_sel_verify_citation', 'Check this citation fits')
      case 'find_more_sources':
        return t('ai_assist_sel_find_more_sources', 'Find more sources')
      case 'explain_latex':
        return t(
          'ai_assist_sel_explain_latex',
          'Explain the LaTeX code used here'
        )
      case 'fix_latex_errors':
        return t('ai_assist_sel_fix_latex_errors', 'Fix LaTeX errors')
      case 'define_term':
        return t('ai_assist_sel_define_term', 'Define this term')
      case 'tighten_abstract':
        return t('ai_assist_sel_tighten_abstract', 'Tighten the abstract')
      case 'change_formatting':
        return t('ai_assist_sel_change_formatting', 'Change the text formatting')
      default:
        return id
    }
  }
}

/** Human-readable badge label for the classified selection structure. */
function useSelectionKindLabel(): (kind: SelectionKind) => string {
  const { t } = useTranslation()

  return (kind: SelectionKind): string => {
    switch (kind) {
      case 'prose':
        return t('ai_assist_sel_kind_prose', 'Text')
      case 'math':
        return t('ai_assist_sel_kind_math', 'Math')
      case 'table':
        return t('ai_assist_sel_kind_table', 'Table')
      case 'figure':
        return t('ai_assist_sel_kind_figure', 'Figure')
      case 'tikz':
        return t('ai_assist_sel_kind_tikz', 'TikZ')
      case 'list':
        return t('ai_assist_sel_kind_list', 'List')
      case 'heading':
        return t('ai_assist_sel_kind_heading', 'Heading')
      case 'code':
        return t('ai_assist_sel_kind_code', 'Code')
      case 'preamble':
        return t('ai_assist_sel_kind_preamble', 'Preamble')
      case 'bibtex':
        return t('ai_assist_sel_kind_bibtex', 'BibTeX')
      case 'citation':
        return t('ai_assist_sel_kind_citation', 'Citation')
      case 'latex':
        return t('ai_assist_sel_kind_latex', 'LaTeX')
      default:
        return kind
    }
  }
}

export function SelectionQuickActions({
  selection,
  variant,
  disabled = false,
  onPick,
}: {
  selection: SelectionInput
  variant: 'list' | 'chips'
  disabled?: boolean
  onPick: (action: SelectionAction) => void
}) {
  const { t } = useTranslation()
  const actionLabelFor = useSelectionActionLabel()
  const kindLabelFor = useSelectionKindLabel()

  const max = variant === 'list' ? MAX_SELECTION_ACTIONS : MAX_SELECTION_CHIPS

  const scope = useMemo(
    () => selection.scope ?? classifySelectionText(selection.text, selection.path),
    [selection.scope, selection.text, selection.path]
  )

  const actions = useMemo(
    () => deriveSelectionActions({ ...selection, scope }, max),
    [
      selection.path,
      selection.from,
      selection.to,
      selection.text,
      scope,
      max,
    ]
  )

  const kindLabel = kindLabelFor(scope.kind)
  const basename = selection.path.split('/').pop() ?? selection.path
  const rangeLabel =
    selection.from === selection.to
      ? `${selection.from}`
      : `${selection.from}-${selection.to}`

  if (actions.length === 0) {
    return null
  }

  if (variant === 'chips') {
    const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
      if (e.deltaY !== 0) {
        e.currentTarget.scrollLeft += e.deltaY
      }
    }

    return (
      <div
        className="ai-assist-quick-chips"
        role="toolbar"
        onWheel={handleWheel}
        aria-label={t(
          'ai_assist_selection_quick_actions',
          'Quick actions for the selection'
        )}
      >
        {actions.map(action => (
          <button
            key={action.id}
            type="button"
            className="ai-assist-quick-chip"
            disabled={disabled}
            onClick={() => !disabled && onPick(action)}
          >
            {action.edits ? (
              <PencilSimpleLine size={13} aria-hidden="true" />
            ) : (
              <Lightbulb size={13} aria-hidden="true" />
            )}
            <span>{actionLabelFor(action.id)}</span>
          </button>
        ))}
      </div>
    )
  }

  return (
    <>
      <h5 className="ai-assist-selection-actions-title">
        <span>
          {t('ai_assist_selection_actions_title', 'For your selection')}
        </span>
        <span className="ai-assist-selection-kind-badge">{kindLabel}</span>
        <span className="ai-assist-selection-actions-where">
          {basename}:{rangeLabel}
        </span>
      </h5>
      {actions.map((action, index) => (
        <OLButton
          key={`${selection.from}-${selection.to}-${action.id}`}
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          className="ai-assist-starter ai-assist-selection-action ai-assist-suggestion-enter"
          style={{ animationDelay: `${index * 40}ms` }}
          leadingIcon={
            action.edits ? (
              <PencilSimpleLine
                size={16}
                className="ai-assist-empty-state-icon"
              />
            ) : (
              <Lightbulb size={16} className="ai-assist-empty-state-icon" />
            )
          }
          onClick={() => !disabled && onPick(action)}
        >
          {actionLabelFor(action.id)}
        </OLButton>
      ))}
    </>
  )
}
