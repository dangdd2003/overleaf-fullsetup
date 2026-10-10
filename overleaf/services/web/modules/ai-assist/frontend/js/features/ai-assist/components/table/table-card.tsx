import { useTranslation } from 'react-i18next'
import { GeneratorPhase, Versioned } from '../../generator/types'
import { TableResult } from '../../table/generate'
import { ParsedTable } from '../../table/parse-output'
import { GeneratorCard } from '../generator/generator-card'
import { StreamingCodeBlock } from '../generator/streaming-text'
import { CodeBlock } from '../texgpt/texgpt-result'
import { DiffText } from '../writing-tools/diff-text'

export type TableVersion = Versioned<TableResult>

export type TablePhase = GeneratorPhase<ParsedTable>

export type TableCardProps = {
  /** The prompt, "From pasted data", "From selection" or "From image". */
  title: string
  imageAttached: boolean
  phase: TablePhase
  versions: TableVersion[]
  index: number
  onIndex: (index: number) => void
  /** The selection the table replaces; empty at a cursor. */
  original: string
  /** The rows streamed so far, wrapped; null before there are any. */
  streamingCode: string | null
  canAddPackages: boolean
  addPackages: boolean
  onAddPackages: (value: boolean) => void
  stale: boolean
  followUp: string
  onFollowUp: (value: string) => void
  onSendFollowUp: () => void
  onStop: () => void
  onRetry: () => void
  onEditPrompt: () => void
  onDiscard: () => void
  durationMs?: number
  onInsert: () => void
  onConsent: () => void
}

function ruleStyle(body: string): string | null {
  if (/\\(?:top|mid|bottom)rule\b/.test(body)) return 'booktabs'
  if (/\\hline\b/.test(body)) return '\\hline'
  return null
}

/**
 * The review card under the insertion point, on the equation card's
 * template (the redesign comes later): the LaTeX, and Changes when a
 * selection is replaced. Renders only; the host decides.
 */
export function TableCard(props: TableCardProps) {
  const { t } = useTranslation()
  const current: TableVersion | undefined = props.versions[props.index]

  const summary = current
    ? [
        current.columns === 1
          ? t('ai_assist_table_one_column', '1 column')
          : t('ai_assist_table_columns', '__count__ columns', { count: current.columns }),
        current.rows === 1
          ? t('ai_assist_table_one_row', '1 row')
          : t('ai_assist_table_rows', '__count__ rows', { count: current.rows }),
        ruleStyle(current.body),
      ]
        .filter(Boolean)
        .join(' · ')
    : ''

  return (
    <GeneratorCard
      text={{
        kind: t('ai_assist_table_label', 'Table'),
        label: t('ai_assist_table_card', 'Generated table'),
        noProvider: t(
          'ai_assist_table_no_provider',
          'The table generator uses your AI provider. Set one up in your account settings.'
        ),
        cannot: t('ai_assist_table_cannot', 'The table generator cannot help with this request.'),
        imageUnsupported: t(
          'ai_assist_table_image_unsupported',
          "This model can't read images. Choose a vision-capable model in AI settings, or paste the cells as text."
        ),
        repairing: t('ai_assist_table_repairing', 'Fixing the table…'),
        followUpPlaceholder: t(
          'ai_assist_table_follow_up',
          'Ask for changes, e.g. merge the first two columns'
        ),
        retry: t('ai_assist_table_regenerate', 'Regenerate'),
      }}
      className="ai-table-card"
      title={props.title}
      imageAttached={props.imageAttached}
      phase={props.phase}
      versionCount={props.versions.length}
      index={props.index}
      onIndex={props.onIndex}
      durationMs={props.durationMs}
      copyText={current?.latex ?? null}
      streamingPreview={
        props.streamingCode ? (
          <div className="ai-generator-latex ai-table-latex">
            <StreamingCodeBlock code={props.streamingCode} isLive language="latex" />
          </div>
        ) : null
      }
      notes={current?.notes ?? null}
      warnings={current?.warnings ?? []}
      packages={current?.packages ?? []}
      canAddPackages={props.canAddPackages}
      addPackages={props.addPackages}
      onAddPackages={props.onAddPackages}
      stale={props.stale}
      followUp={props.followUp}
      onFollowUp={props.onFollowUp}
      onSendFollowUp={props.onSendFollowUp}
      onStop={props.onStop}
      onRetry={props.onRetry}
      onEditPrompt={props.onEditPrompt}
      onDiscard={props.onDiscard}
      onInsert={props.onInsert}
      onConsent={props.onConsent}
    >
      {current && (
        <>
          <p className="ai-table-summary">{summary}</p>
          <div className="ai-generator-latex ai-table-latex">
            <CodeBlock code={current.latex} />
          </div>
          {props.original.trim() && (
            <>
              <p className="ai-generator-section-title">
                {t('ai_assist_table_changes', 'Changes')}
              </p>
              <div className="ai-writing-tools-text ai-generator-diff ai-table-diff">
                <DiffText original={props.original} result={current.text} />
              </div>
            </>
          )}
        </>
      )}
    </GeneratorCard>
  )
}
