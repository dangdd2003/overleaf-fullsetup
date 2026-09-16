import { useTranslation } from 'react-i18next'
import { ArrowBendDownRight, Bookmarks, Quotes } from '@phosphor-icons/react'
import OLButton from '@/shared/components/ol/ol-button'
import { ProjectFile, ProjectHandle } from '../../agent/project-handle'
import { Starter } from '../../agent/starters/derive-starters'
import { useProjectStarters } from '../../agent/starters/use-project-starters'

/**
 * Every `t()` call below passes a string literal, and must keep doing so.
 *
 * The frontend does not ship the whole of `locales/en.json`: webpack runs it
 * through `frontend/translations-loader.js`, which keeps only the keys listed in
 * `frontend/extracted-translations.json`. That list is produced by
 * `yarn extract-translations`, a *static* scan that only sees calls whose key is
 * a string literal. Keys reached through a variable are invisible to the scan,
 * so they never reach the list, get dropped from the bundle, and render to the
 * user as the raw key.
 *
 * Unit tests do not catch this: they import `locales/en.json` directly and never
 * run the loader, so they see every key regardless.
 *
 * The prompts are deliberately not translated. They are instructions sent to the
 * model, not text shown to the user.
 */
export type PickedStarter = {
  prompt: string
  oneShot?: boolean
}

export function AgentEmptyState({
  onPick,
  handle,
  files,
  projectId,
  refreshSeed,
}: {
  onPick: (starter: PickedStarter) => void
  handle: ProjectHandle
  files: ProjectFile[]
  projectId?: string
  refreshSeed?: number
}) {
  const { t } = useTranslation()
  const starters = useProjectStarters({ handle, files, projectId, refreshSeed })

  // One literal `t()` per rule, so the static scan sees every key. Values from
  // the project are interpolated, never concatenated into the key. Every option
  // is written out by name: the scanner parses this object with esprima, and a
  // spread (`...starter.params`) makes it throw and drop the key's default.
  // Count-bearing labels pass `count`, which is what selects the `_plural` form.
  const labelFor = (starter: Starter): string => {
    const params = starter.params
    switch (starter.id) {
      case 'fix_compile_errors':
        return t('ai_assist_starter_fix_compile_errors', {
          count: Number(params.error_count),
          defaultValue: `Fix ${params.error_count} compile errors`,
        })
      case 'resolve_warnings':
        return t('ai_assist_starter_resolve_warnings', {
          count: Number(params.warning_count),
          defaultValue: `Resolve ${params.warning_count} compile warnings`,
        })
      case 'add_missing_package':
        return t('ai_assist_starter_add_missing_package', {
          package_name: String(params.package_name),
          defaultValue: `Add \\usepackage{${params.package_name}}`,
        })
      case 'add_bibliography':
        return t('ai_assist_starter_add_bibliography', {
          count: Number(params.cite_count),
          defaultValue: `Add bibliography for ${params.cite_count} citations`,
        })
      case 'add_missing_bib_entries':
        return t('ai_assist_starter_add_missing_bib_entries', {
          count: Number(params.cite_count),
          defaultValue: `Add ${params.cite_count} missing BibTeX entries`,
        })
      case 'fix_duplicate_labels':
        return t('ai_assist_starter_fix_duplicate_labels', {
          count: Number(params.count),
          defaultValue: `Fix ${params.count} duplicate labels`,
        })
      case 'resolve_broken_refs':
        return t('ai_assist_starter_resolve_broken_refs', {
          count: Number(params.unresolved_ref_count),
          defaultValue: `Resolve ${params.unresolved_ref_count} broken references`,
        })
      case 'init_document_structure':
        return t(
          'ai_assist_starter_init_document_structure',
          'Set up document structure and compile'
        )
      case 'draft_conclusion':
        return t('ai_assist_starter_draft_conclusion', {
          file: String(params.file),
          defaultValue: `Draft a conclusion for ${params.file}`,
        })
      case 'draft_abstract_title':
        return t('ai_assist_starter_draft_abstract_title', {
          root_file: String(params.root_file),
          defaultValue: `Draft abstract and title in ${params.root_file}`,
        })
      case 'proofread_active_file':
        return t('ai_assist_starter_proofread_active_file', {
          file: String(params.file),
          defaultValue: `Proofread ${params.file} for academic tone`,
        })
      case 'add_summary_table':
        return t('ai_assist_starter_add_summary_table', {
          file: String(params.file),
          defaultValue: `Add a summary table to ${params.file}`,
        })
      case 'add_figure_placeholder':
        return t('ai_assist_starter_add_figure_placeholder', {
          file: String(params.file),
          defaultValue: `Add a figure placeholder to ${params.file}`,
        })
      case 'what_can_you_do':
        return t('ai_assist_starter_what_can_you_do', 'What can the assistant do for me?')
      case 'beamer':
        return t('ai_assist_starter_beamer', 'Create a Beamer presentation')
      case 'generate_table':
        return t('ai_assist_starter_generate_table', 'Generate a table')
      case 'generate_tikz':
        return t('ai_assist_starter_generate_tikz', 'Create a TikZ diagram')
      case 'manage_bibliography':
        return t(
          'ai_assist_starter_manage_bibliography',
          'Add a bibliography'
        )
      case 'insert_equation':
        return t('ai_assist_starter_insert_equation', 'Insert an equation')
      case 'summarize':
        return t('ai_assist_starter_summarize', 'Summarize this file')
    }
  }

  const advancedTools = [
    {
      id: 'scan-unsupported-statements',
      title: t(
        'ai_assist_tool_scan_unsupported_statements',
        'Scan for unsupported statements'
      ),
      description: t(
        'ai_assist_tool_scan_unsupported_statements_description',
        "Get ready for peer review by checking if you've missed any references."
      ),
      icon: <Quotes size={18} weight="fill" className="ai-assist-empty-state-icon" />,
      prompt:
        'Scan this project for unsupported statements, claims, or assertions that lack citations or references, and suggest additions.',
    },
    {
      id: 'audit-reference-integrity',
      title: t(
        'ai_assist_tool_audit_references',
        'Audit cross-references and citations'
      ),
      description: t(
        'ai_assist_tool_audit_references_description',
        'Check for duplicate labels, unresolved cross-references, and missing bibliography entries.'
      ),
      icon: <Bookmarks size={18} weight="fill" className="ai-assist-empty-state-icon" />,
      prompt:
        'Run an audit of this project\'s references: call get_references to find any duplicate labels, unresolved \\ref calls, or missing bibliography entries, and suggest the exact fixes.',
    },
  ]

  return (
    <div className="ai-assist-empty-state">
      <h5>{t('ai_assist_advanced_tools', 'Advanced tools')}</h5>
      {advancedTools.map((tool, index) => (
        <OLButton
          key={tool.id}
          type="button"
          variant="secondary"
          className="ai-assist-advanced-tool ai-assist-suggestion-enter"
          style={{ animationDelay: `${index * 40}ms` }}
          leadingIcon={tool.icon}
          onClick={() => onPick({ prompt: tool.prompt, oneShot: true })}
        >
          <span className="ai-assist-advanced-tool-text">
            <strong>{tool.title}</strong>
            <span className="ai-assist-advanced-tool-description">
              {tool.description}
            </span>
          </span>
        </OLButton>
      ))}

      <h5>{t('ai_assist_start_a_chat', 'Start a chat')}</h5>
      {starters.map((starter, index) => (
        <OLButton
          key={starter.id}
          type="button"
          variant="secondary"
          size="sm"
          className="ai-assist-starter ai-assist-suggestion-enter"
          style={{
            animationDelay: `${(advancedTools.length + index) * 40}ms`,
          }}
          leadingIcon={
            <ArrowBendDownRight
              size={16}
              className="ai-assist-empty-state-icon"
            />
          }
          onClick={() => onPick(starter)}
        >
          {labelFor(starter)}
        </OLButton>
      ))}
    </div>
  )
}
