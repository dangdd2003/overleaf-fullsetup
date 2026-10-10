import { useTranslation } from 'react-i18next'
import { ParsedEquation } from '../../equation/parse-output'
import { EquationResult } from '../../equation/generate'
import { MathKind } from '../../equation/context'
import { previewTex } from '../../equation/math-render'
import { normalizeBody } from '../../equation/wrap'
import { GeneratorPhase, Versioned } from '../../generator/types'
import { GeneratorCard } from '../generator/generator-card'
import { StreamingCodeBlock } from '../generator/streaming-text'
import { DiffText } from '../writing-tools/diff-text'
import { CodeBlock } from '../texgpt/texgpt-result'
import { MathPreview } from './math-preview'

/** One result, with the conversation that produced it (for follow-ups and retries). */
export type EquationVersion = Versioned<EquationResult>

export type EquationPhase = GeneratorPhase<ParsedEquation>

export type EquationCardProps = {
  /** The prompt, or "From image". */
  title: string
  imageAttached: boolean
  phase: EquationPhase
  versions: EquationVersion[]
  index: number
  onIndex: (index: number) => void
  /** The passage as it was when Generate was pressed. */
  original: string
  /** Inside math: how the body previews. */
  math?: MathKind
  /** The author's definitions, for the preview. */
  definitions: string
  applyEdits: boolean
  onApplyEdits: (value: boolean) => void
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

/** The review card under the passage. Renders only; the host decides. */
export function EquationCard(props: EquationCardProps) {
  const { t } = useTranslation()
  const { phase, versions, index } = props
  const current: EquationVersion | undefined = versions[index]

  const editsLabel =
    current?.editCount === 1
      ? t('ai_assist_equation_apply_edit', 'Also apply 1 small edit around it')
      : t('ai_assist_equation_apply_edits', 'Also apply __count__ small edits around it', {
          count: current?.editCount ?? 0,
        })

  const streamingPreview = (() => {
    if (phase.name !== 'streaming') return null
    const reply = phase.reply
    if (reply?.kind !== 'equation') return null
    if (reply.bodyComplete) {
      const body = normalizeBody(reply.body).body
      if (!body) return null
      const preview = previewTex(reply.form ?? 'display', body, props.math)
      return (
        <MathPreview tex={preview.tex} display={preview.display} definitions={props.definitions} />
      )
    }
    if (reply.body) {
      return (
        <div className="ai-generator-latex ai-equation-latex">
          <StreamingCodeBlock code={reply.body} isLive language="latex" />
        </div>
      )
    }
    return null
  })()

  return (
    <GeneratorCard
      text={{
        kind: t('ai_assist_equation_label', 'Equation'),
        label: t('ai_assist_equation_card', 'Generated equation'),
        noProvider: t(
          'ai_assist_equation_no_provider',
          'The equation generator uses your AI provider. Set one up in your account settings.'
        ),
        cannot: t('ai_assist_equation_cannot', 'The equation generator cannot help with this request.'),
        imageUnsupported: t(
          'ai_assist_equation_image_unsupported',
          "This model can't read images. Choose a vision-capable model in AI settings, or describe the equation in words."
        ),
        repairing: t('ai_assist_equation_repairing', 'Fixing the LaTeX…'),
        followUpPlaceholder: t('ai_assist_equation_follow_up', 'Ask for changes, e.g. only the first one'),
        retry: t('ai_assist_writing_tools_retry', 'Retry'),
      }}
      className="ai-equation-card"
      title={props.title}
      imageAttached={props.imageAttached}
      phase={phase}
      versionCount={versions.length}
      index={index}
      onIndex={props.onIndex}
      durationMs={props.durationMs}
      copyText={current?.wrapped ?? null}
      streamingPreview={streamingPreview}
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
          <MathPreview
            {...previewTex(current.form, current.body, props.math)}
            definitions={props.definitions}
          />
          <details className="ai-generator-latex-details">
            <summary>{t('ai_assist_equation_latex', 'LaTeX')}</summary>
            <div className="ai-generator-latex ai-equation-latex">
              <CodeBlock code={current.wrapped} />
            </div>
          </details>
          <p className="ai-generator-section-title">
            {t('ai_assist_equation_changes', 'Changes')}
          </p>
          <div className="ai-writing-tools-text ai-generator-diff ai-equation-diff">
            <DiffText
              original={props.original}
              result={props.applyEdits ? current.withEdits : current.equationOnly}
            />
          </div>
          {current.editCount > 0 && (
            <label className="ai-texgpt-packages ai-equation-edits">
              <input
                type="checkbox"
                checked={props.applyEdits}
                onChange={event => props.onApplyEdits(event.target.checked)}
              />
              {editsLabel}
            </label>
          )}
          {current.editsSkipped && (
            <p className="ai-writing-tools-status">
              {t('ai_assist_equation_edits_skipped', 'Edits around it were skipped.')}
            </p>
          )}
        </>
      )}
    </GeneratorCard>
  )
}
