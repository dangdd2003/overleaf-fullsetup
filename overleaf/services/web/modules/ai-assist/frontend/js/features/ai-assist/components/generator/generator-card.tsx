import { KeyboardEvent, ReactNode, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import classNames from 'classnames'
import { Info, Sparkle, Warning } from '@phosphor-icons/react'
import OLButton from '@/shared/components/ol/ol-button'
import OLIconButton from '@/shared/components/ol/ol-icon-button'
import { GeneratorPhase } from '../../generator/types'
import { useStickToBottom } from '../../hooks/use-stick-to-bottom'
import { TexGptPromptBar } from '../texgpt/texgpt-prompt-bar'
import { PopupStatusLine } from './streaming-text'
import { RevealBox } from '../reveal-box'

/** What one generator's card says; the shell is the same for all. */
export type GeneratorCardText = {
  /** "Equation", "Table". */
  kind: string
  /** The card's accessible name: "Generated equation". */
  label: string
  noProvider: string
  /** When the model refuses without a reason. */
  cannot: string
  imageUnsupported: string
  repairing: string
  followUpPlaceholder: string
  /** The label of the Retry button ("Retry", "Regenerate"). */
  retry: string
}

export type GeneratorCardProps = {
  text: GeneratorCardText
  /** The generator's own class, e.g. `ai-equation-card`. */
  className?: string
  /** The prompt, or "From image"… */
  title: string
  imageAttached: boolean
  phase: GeneratorPhase<unknown>
  versionCount: number
  index: number
  onIndex: (index: number) => void
  /** What Copy copies; null while there is no version. */
  copyText: string | null
  /** While streaming: shown instead of "Writing…" once there is something to show. */
  streamingPreview?: ReactNode
  /** The current version, shown when ready: previews, changes. */
  children?: ReactNode
  notes: string | null
  warnings: Array<{ message: string }>
  packages: string[]
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

/** The review card under the passage, shared by the generators. Renders only; the host decides. */
export function GeneratorCard(props: GeneratorCardProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const { onScroll: onBodyScroll } = useStickToBottom(bodyRef)
  const { phase, text, index, versionCount } = props
  const hasVersion = props.copyText !== null
  const streaming = phase.name === 'streaming'
  const blocked = phase.name === 'consent' || phase.name === 'noProvider'
  const insertDisabled = phase.name !== 'ready' || !hasVersion || props.stale

  const copy = () => {
    if (props.copyText === null) return
    navigator.clipboard
      ?.writeText(props.copyText)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (streaming) props.onStop()
      else props.onDiscard()
      return
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !insertDisabled) {
      event.preventDefault()
      props.onInsert()
    }
  }

  return (
    <div
      className={classNames('ai-writing-tools-card ai-generator-card', props.className)}
      role="dialog"
      aria-label={text.label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="ai-writing-tools-card-header">
        <span className="ai-writing-tools-card-title ai-generator-card-title">
          <Sparkle aria-hidden="true" weight="fill" />
          {text.kind}
          <span className="ai-generator-card-request" title={props.title}>
            {props.title}
          </span>
        </span>
        <span className="ai-writing-tools-card-tools">
          {versionCount > 1 && (
            <span className="ai-writing-tools-versions">
              <OLIconButton
                variant="ghost"
                size="sm"
                icon="chevron_left"
                accessibilityLabel={t(
                  'ai_assist_writing_tools_previous',
                  'Previous version'
                )}
                disabled={streaming || index === 0}
                onClick={() => props.onIndex(index - 1)}
              />
              <span className="ai-writing-tools-versions-count">
                {index + 1}/{versionCount}
              </span>
              <OLIconButton
                variant="ghost"
                size="sm"
                icon="chevron_right"
                accessibilityLabel={t('ai_assist_writing_tools_next', 'Next version')}
                disabled={streaming || index === versionCount - 1}
                onClick={() => props.onIndex(index + 1)}
              />
            </span>
          )}
          <OLIconButton
            variant="ghost"
            size="sm"
            icon="close"
            accessibilityLabel={t('ai_assist_generator_discard', 'Discard')}
            onClick={props.onDiscard}
          />
        </span>
      </div>

      <div
        ref={bodyRef}
        onScroll={onBodyScroll}
        className="ai-writing-tools-card-body ai-generator-card-body"
        aria-live="polite"
      >
        {phase.name === 'consent' && (
          <div className="ai-writing-tools-notice">
            <p>
              {t(
                'ai_assist_consent_prompt',
                'Using the assistant will send project contents and queries to your configured AI provider.'
              )}
            </p>
            <OLButton variant="primary" size="sm" onClick={props.onConsent}>
              {t('allow_and_continue', 'Allow and continue')}
            </OLButton>
          </div>
        )}

        {phase.name === 'noProvider' && (
          <div className="ai-writing-tools-notice">
            <p>{text.noProvider}</p>
            <a href="/user/settings" target="_blank" rel="noopener noreferrer">
              {t('ai_assist_writing_tools_set_up_provider', 'Set up an AI provider')}
            </a>
          </div>
        )}

        {phase.name === 'streaming' && (
          <>
            {props.streamingPreview}
            <PopupStatusLine
              text={
                phase.repairing
                  ? text.repairing
                  : props.imageAttached
                    ? t('ai_assist_generator_reading_image', 'Reading the image…')
                    : t('ai_assist_writing_tools_writing', 'Writing…')
              }
            />
          </>
        )}

        {phase.name === 'ready' && hasVersion && (
          <>
            <RevealBox animate>
              {props.children}
              {props.notes && (
                <p className="ai-generator-notes">
                  <Info aria-hidden="true" size={16} />
                  {props.notes}
                </p>
              )}
              {props.warnings.length > 0 && (
                <ul className="ai-writing-tools-warnings">
                  {props.warnings.map(warning => (
                    <li key={warning.message}>
                      <Warning aria-hidden="true" size={18} />
                      {warning.message}
                    </li>
                  ))}
                </ul>
              )}
            </RevealBox>
            {props.packages.length > 0 && props.canAddPackages && (
              <label className="ai-texgpt-packages">
                <input
                  type="checkbox"
                  checked={props.addPackages}
                  onChange={event => props.onAddPackages(event.target.checked)}
                />
                {t('ai_assist_texgpt_add_packages', 'Also add __packages__ to the preamble', {
                  packages: props.packages.map(name => `\\usepackage{${name}}`).join(', '),
                })}
              </label>
            )}
            <PopupStatusLine
              completed
              verb={text.kind === 'Table' ? 'Generated' : 'Typeset'}
              durationMs={props.durationMs}
            />
          </>
        )}

        {phase.name === 'cannot' && (
          <p className="ai-writing-tools-notice">{phase.reason || text.cannot}</p>
        )}

        {phase.name === 'imageUnsupported' && (
          <p className="ai-writing-tools-notice">{text.imageUnsupported}</p>
        )}

        {phase.name === 'empty' && (
          <p className="ai-writing-tools-notice">
            {t('ai_assist_writing_tools_empty', 'The model returned no text.')}
          </p>
        )}

        {phase.name === 'error' && (
          <div className="ai-writing-tools-notice ai-writing-tools-error" role="alert">
            <p>{phase.message}</p>
            {phase.hint && <p>{phase.hint}</p>}
          </div>
        )}

        {props.stale && !blocked && (
          <p className="ai-writing-tools-notice">
            {t(
              'ai_assist_texgpt_stale',
              'The text changed since this was written. Retry to work on the current text.'
            )}
          </p>
        )}
      </div>

      {!blocked && (
        <TexGptPromptBar
          value={props.followUp}
          placeholder={text.followUpPlaceholder}
          running={streaming}
          onChange={props.onFollowUp}
          onSend={props.onSendFollowUp}
          onStop={props.onStop}
        />
      )}

      {!blocked && (
        <div className="ai-writing-tools-card-footer ai-card-footer">
          <span className="ai-writing-tools-card-actions">
            <OLButton
              variant="secondary"
              size="sm"
              leadingIcon="refresh"
              disabled={streaming}
              onClick={props.onRetry}
              aria-label={text.retry}
            >
              <span className="ai-card-label">{text.retry}</span>
            </OLButton>
            <OLButton
              variant="secondary"
              size="sm"
              leadingIcon={copied ? 'check' : 'content_copy'}
              disabled={!hasVersion || streaming}
              onClick={copy}
              aria-label={t('ai_assist_writing_tools_copy', 'Copy')}
            >
              <span className="ai-card-label">
                {copied
                  ? t('ai_assist_writing_tools_copied', 'Copied')
                  : t('ai_assist_writing_tools_copy', 'Copy')}
              </span>
            </OLButton>
            <OLButton
              variant="secondary"
              size="sm"
              leadingIcon="edit"
              onClick={props.onEditPrompt}
              aria-label={t('ai_assist_generator_edit_prompt', 'Edit prompt')}
            >
              <span className="ai-card-label">
                {t('ai_assist_generator_edit_prompt', 'Edit prompt')}
              </span>
            </OLButton>
          </span>
          <span className="ai-writing-tools-card-actions">
            <OLButton variant="secondary" size="sm" onClick={props.onDiscard}>
              {t('ai_assist_generator_discard', 'Discard')}
            </OLButton>
            <OLButton
              variant="primary"
              size="sm"
              trailingIcon="keyboard_return"
              disabled={insertDisabled}
              onClick={props.onInsert}
            >
              {t('ai_assist_texgpt_insert', 'Insert')}
            </OLButton>
          </span>
        </div>
      )}
    </div>
  )
}
