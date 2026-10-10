import { ReactNode, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import MaterialIcon from '@/shared/components/material-icon'
import OLButton from '@/shared/components/ol/ol-button'
import OLIconButton from '@/shared/components/ol/ol-icon-button'
import { AgentMessage } from '../../providers/types'
import { ParsedReply } from '../../texgpt/parse-output'
import { useStickToBottom } from '../../hooks/use-stick-to-bottom'
import { TexGptWarning } from '../../texgpt/checks'
import { DiffText } from '../writing-tools/diff-text'
import { RevealBox } from '../reveal-box'
import { InlineNotice } from './texgpt-notices'
import { renderMarkdown } from '../agent/markdown-content'
import {
  PopupStatusLine,
  StreamingCodeBlock,
  StreamingMarkdownAnswer,
  StreamingOptions,
} from '../generator/streaming-text'
import {
  highlightCodeHtml,
  SYSTEM_CODE_CLASS,
  useSystemHighlightStyle,
} from '../../hooks/use-editor-code-highlight'

/** One result, with the conversation that produced it (for follow-ups and retries). */
export type TexGptVersion =
  | {
      kind: 'latex'
      text: string
      packages: string[]
      warnings: TexGptWarning[]
      raw: string
      messages: AgentMessage[]
    }
  | { kind: 'answer'; text: string; raw: string; messages: AgentMessage[] }
  | { kind: 'options'; options: string[]; raw: string; messages: AgentMessage[] }

export type TexGptPhase =
  | { name: 'menu' }
  | { name: 'consent' }
  | { name: 'noProvider' }
  | { name: 'tooLong' }
  | { name: 'streaming'; reply: ParsedReply | null; repairing: boolean }
  | { name: 'ready' }
  | { name: 'unchanged' }
  | { name: 'cannot'; reason: string }
  | { name: 'empty' }
  | { name: 'error'; message: string; hint?: string }

export type TexGptResultProps = {
  /** The author's words or the generator's name. */
  title: string
  phase: TexGptPhase
  versions: TexGptVersion[]
  index: number
  onIndex: (index: number) => void
  /** What the primary action writes, exactly as it will appear. */
  code: string | null
  /** The text it replaces, when there is one to diff against. */
  original: string | null
  showDiff: boolean
  onToggleDiff: () => void
  /** Title Generator: the options to pick from. */
  options: string[] | null
  choice: number
  onChoose: (index: number) => void
  onChooseAndApply: (index: number) => void
  warnings: TexGptWarning[]
  missingPackages: string[]
  canAddPackages: boolean
  addPackages: boolean
  onAddPackages: (value: boolean) => void
  note: string | null
  stale: boolean
  primaryLabel: string | null
  primaryDisabled: boolean
  onPrimary: () => void
  secondaryLabel: string | null
  secondaryDisabled: boolean
  onSecondary: () => void
  copyText: string | null
  durationMs?: number
  onRetry: () => void
  onCancel: () => void
  onBack: () => void
  onConsent: () => void
  /** Shown before the title: the generator's icon, or the sparkle. */
  icon: ReactNode
  /** The follow-up prompt bar, above the actions. */
  followUp: ReactNode
  /** Fade the finished result in as one box: it looks different from the stream. */
  reveal: boolean
}

/** LaTeX in token colours that suit the system theme. */
export function CodeBlock({ code }: { code: string }) {
  useSystemHighlightStyle()
  const html = highlightCodeHtml(code, 'latex')
  return html === null ? (
    <pre className="ai-texgpt-code">{code}</pre>
  ) : (
    <pre
      className={`ai-texgpt-code ${SYSTEM_CODE_CLASS}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

/** Markdown through the chat's renderer (sanitised there). */
function Answer({ text }: { text: string }) {
  useSystemHighlightStyle()
  return (
    <div
      className="ai-assist-markdown ai-texgpt-answer"
      dangerouslySetInnerHTML={{
        __html: renderMarkdown(text, undefined, undefined, {
          codeClass: SYSTEM_CODE_CLASS,
        }),
      }}
    />
  )
}

function Streaming({
  reply,
  repairing,
}: {
  reply: ParsedReply | null
  repairing: boolean
}) {
  const { t } = useTranslation()
  let preview: ReactNode = null
  if (reply?.kind === 'latex' && reply.text) {
    preview = (
      <div className="ai-generator-latex ai-texgpt-latex">
        <StreamingCodeBlock code={reply.text} isLive language="latex" />
      </div>
    )
  } else if (reply?.kind === 'answer' && reply.text) {
    preview = <StreamingMarkdownAnswer text={reply.text} isLive />
  } else if (reply?.kind === 'options' && reply.options.length) {
    preview = <StreamingOptions options={reply.options} isLive />
  }

  const statusText = repairing
    ? t('ai_assist_writing_tools_repairing', 'Fixing the LaTeX in this version…')
    : t('ai_assist_writing_tools_writing', 'Writing…')

  return (
    <>
      {preview}
      <PopupStatusLine text={statusText} />
    </>
  )
}

/** The TeXGPT result card, in the shared AI card template. Renders only; the popup decides. */
export function TexGptResult(props: TexGptResultProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const { onScroll: onBodyScroll } = useStickToBottom(bodyRef)
  const { phase, versions, index } = props
  const current = versions[index]
  const streaming = phase.name === 'streaming'
  const blocked =
    phase.name === 'consent' || phase.name === 'noProvider' || phase.name === 'tooLong'

  const copy = () => {
    if (!props.copyText) return
    navigator.clipboard
      ?.writeText(props.copyText)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }

  return (
    <div className="ai-writing-tools-card ai-texgpt-card">
      <div className="ai-writing-tools-card-header">
        <span className="ai-writing-tools-card-title ai-texgpt-card-title">
          <span className="ai-texgpt-card-icon" aria-hidden="true">
            {props.icon}
          </span>
          <span className="ai-texgpt-card-title-text" title={props.title}>
            {props.title}
          </span>
        </span>
        <span className="ai-writing-tools-card-tools">
          {versions.length > 1 && (
            <span className="ai-texgpt-versions">
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
              <span className="ai-texgpt-versions-count">
                {index + 1}/{versions.length}
              </span>
              <OLIconButton
                variant="ghost"
                size="sm"
                icon="chevron_right"
                accessibilityLabel={t('ai_assist_writing_tools_next', 'Next version')}
                disabled={streaming || index === versions.length - 1}
                onClick={() => props.onIndex(index + 1)}
              />
            </span>
          )}
          {props.original !== null && props.code !== null && (
            <OLIconButton
              variant="ghost"
              size="sm"
              icon="strikethrough_s"
              active={props.showDiff}
              accessibilityLabel={t(
                'ai_assist_writing_tools_show_changes',
                'Show changes'
              )}
              onClick={props.onToggleDiff}
            />
          )}
        </span>
      </div>

      <OLButton
        variant="ghost"
        size="sm"
        className="ai-writing-tools-back"
        leadingIcon="arrow_back_ios_new"
        onClick={props.onBack}
      >
        {t('ai_assist_writing_tools_back', 'back')}
      </OLButton>

      <div
        ref={bodyRef}
        onScroll={onBodyScroll}
        className="ai-writing-tools-card-body ai-texgpt-result-body"
        aria-live="polite"
      >
        {phase.name === 'consent' && (
          <InlineNotice notice={phase} onConsent={props.onConsent} />
        )}

        {phase.name === 'noProvider' && <InlineNotice notice={phase} />}

        {phase.name === 'tooLong' && (
          <p className="ai-texgpt-notice">
            {t(
              'ai_assist_texgpt_too_long',
              'TeXGPT edits up to 8,000 characters. Select less text, or ask the AI assistant.'
            )}
          </p>
        )}

        {phase.name === 'streaming' && (
          <Streaming reply={phase.reply} repairing={phase.repairing} />
        )}

        {phase.name === 'ready' && current && (
          <>
            <RevealBox animate={props.reveal}>
              {current.kind === 'answer' ? (
                <Answer text={current.text} />
              ) : props.options ? (
                <div
                  className="ai-texgpt-options"
                  role="radiogroup"
                  aria-label={t('ai_assist_texgpt_titles', 'Suggested titles')}
                >
                  {props.options.map((option, optionIndex) => (
                    <button
                      key={option}
                      type="button"
                      role="radio"
                      aria-checked={optionIndex === props.choice}
                      className="ai-texgpt-option"
                      onClick={() => props.onChoose(optionIndex)}
                      onDoubleClick={() => props.onChooseAndApply(optionIndex)}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              ) : props.code !== null ? (
                props.original !== null && props.showDiff ? (
                  <div className="ai-texgpt-diff">
                    <DiffText original={props.original} result={props.code} />
                  </div>
                ) : (
                  <CodeBlock code={props.code} />
                )
              ) : null}

              {props.warnings.length > 0 && (
                <ul className="ai-texgpt-warnings">
                  {props.warnings.map(warning => (
                    <li key={warning.message}>
                      <MaterialIcon type="warning" />
                      {warning.message}
                    </li>
                  ))}
                </ul>
              )}
            </RevealBox>

            {props.missingPackages.length > 0 && props.canAddPackages && (
              <label className="ai-texgpt-packages">
                <input
                  type="checkbox"
                  checked={props.addPackages}
                  onChange={event => props.onAddPackages(event.target.checked)}
                />
                {t(
                  'ai_assist_texgpt_add_packages',
                  'Also add {{packages}} to the preamble',
                  {
                    packages: props.missingPackages
                      .map(name => `\\usepackage{${name}}`)
                      .join(', '),
                  }
                )}
              </label>
            )}
            <PopupStatusLine
              completed
              verb={current.kind === 'answer' ? 'Answered' : 'Written'}
              durationMs={props.durationMs}
            />
          </>
        )}

        {phase.name === 'unchanged' && (
          <p className="ai-texgpt-notice">
            {t(
              'ai_assist_texgpt_unchanged',
              'No changes suggested: the selection already does this. Retry for another attempt.'
            )}
          </p>
        )}

        {phase.name === 'cannot' && <InlineNotice notice={phase} />}

        {phase.name === 'empty' && <InlineNotice notice={phase} />}

        {phase.name === 'error' && <InlineNotice notice={phase} />}

        {props.note && <p className="ai-texgpt-note">{props.note}</p>}

        {props.stale && !blocked && (
          <p className="ai-texgpt-notice is-warning">
            {t(
              'ai_assist_texgpt_stale',
              'The text changed since this was written. Retry to work on the current text.'
            )}
          </p>
        )}
      </div>

      {!blocked && props.followUp}

      {!blocked && (
        <div className="ai-writing-tools-card-footer ai-card-footer">
          <span className="ai-writing-tools-card-actions">
            <OLButton
              variant="secondary"
              size="sm"
              leadingIcon="refresh"
              disabled={streaming}
              onClick={props.onRetry}
              aria-label={t('ai_assist_writing_tools_retry', 'Retry')}
            >
              <span className="ai-card-label">
                {t('ai_assist_writing_tools_retry', 'Retry')}
              </span>
            </OLButton>
            <OLButton
              variant="secondary"
              size="sm"
              leadingIcon={copied ? 'check' : 'content_copy'}
              disabled={!props.copyText || streaming}
              onClick={copy}
              aria-label={t('ai_assist_writing_tools_copy', 'Copy')}
            >
              <span className="ai-card-label">
                {copied
                  ? t('ai_assist_writing_tools_copied', 'Copied')
                  : t('ai_assist_writing_tools_copy', 'Copy')}
              </span>
            </OLButton>
          </span>
          <span className="ai-writing-tools-card-actions">
            <OLButton variant="secondary" size="sm" onClick={props.onCancel}>
              {t('cancel', 'Cancel')}
            </OLButton>
            {props.secondaryLabel && (
              <OLButton
                variant="secondary"
                size="sm"
                disabled={props.secondaryDisabled}
                onClick={props.onSecondary}
              >
                {props.secondaryLabel}
              </OLButton>
            )}
            {props.primaryLabel && (
              <OLButton
                variant="primary"
                size="sm"
                trailingIcon="keyboard_return"
                disabled={props.primaryDisabled}
                onClick={props.onPrimary}
              >
                {props.primaryLabel}
              </OLButton>
            )}
          </span>
        </div>
      )}
    </div>
  )
}
