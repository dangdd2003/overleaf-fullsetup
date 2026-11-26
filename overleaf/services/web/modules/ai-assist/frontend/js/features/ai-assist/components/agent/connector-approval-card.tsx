import { KeyboardEvent, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import MaterialIcon from '@/shared/components/material-icon'
import { ApprovalDecision } from '../../agent/agent-events'

export type ConnectorDecision = ApprovalDecision

const YES = 0
const ALWAYS = 1
const NO = 2

const ARG_PREVIEW_LIMIT = 160

function formatArg(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value)
  return text.length > ARG_PREVIEW_LIMIT
    ? `${text.slice(0, ARG_PREVIEW_LIMIT)}…`
    : text
}

/**
 * The permission prompt for a connector tool set to "Needs approval", as
 * Claude Code asks it: Yes / Yes, and don't ask again / No. ↑/↓ move, Enter
 * confirms, Tab on Yes or No adds what to tell the assistant, Esc declines
 * and ends the turn.
 */
export function ConnectorApprovalCard({
  connectorName,
  toolName,
  toolTitle,
  args = {},
  allowAlways = true,
  onDecision,
}: {
  connectorName: string
  toolName: string
  toolTitle?: string
  args?: Record<string, unknown>
  /** Off where the server cannot keep "don't ask again" (web pages). */
  allowAlways?: boolean
  onDecision: (decision: ConnectorDecision) => void
}) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState(YES)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [note, setNote] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const noteRef = useRef<HTMLInputElement>(null)

  const shortName = toolName.replace(/^mcp__[a-zA-Z0-9_-]+__/, '')
  const displayName = `${connectorName} — ${toolTitle || shortName}`
  const entries = Object.entries(args).filter(
    ([, v]) => v !== undefined && v !== null
  )
  // The choices shown, in order; an index into this is the selection
  const choices = allowAlways ? [YES, ALWAYS, NO] : [YES, NO]
  const canAmend = choices[selected] === YES || choices[selected] === NO
  const showFeedback = feedbackOpen && canAmend

  const labels: Record<number, string> = {
    [YES]: t('ai_assist_connector_approve_yes', 'Yes'),
    [ALWAYS]: t(
      'ai_assist_connector_approve_always',
      'Yes, and don’t ask again for __name__ commands',
      { name: displayName }
    ),
    [NO]: t('ai_assist_connector_approve_no', 'No'),
  }
  const options = choices.map(choice => labels[choice])

  // Take focus only from the chat panel, never from the editor
  useEffect(() => {
    const active = document.activeElement
    if (
      !active ||
      active === document.body ||
      active.closest('.ai-assist-panel')
    ) {
      cardRef.current?.focus({ preventScroll: true })
    }
  }, [])

  // The feedback box comes and goes; keep the keys working either way
  useEffect(() => {
    if (showFeedback) {
      noteRef.current?.focus({ preventScroll: true })
    } else if (document.activeElement === document.body) {
      cardRef.current?.focus({ preventScroll: true })
    }
  }, [showFeedback])

  const submit = (index: number, feedback?: string) => {
    if (submitted) return
    setSubmitted(true)
    const text = feedback?.trim() || undefined
    const choice = choices[index]
    if (choice === YES) onDecision({ accepted: true, always: false, note: text })
    else if (choice === ALWAYS) onDecision({ accepted: true, always: true })
    else onDecision({ accepted: false, note: text })
  }

  const select = (index: number) => {
    if (index === selected) return
    setSelected(index)
    setFeedbackOpen(false)
    setNote('')
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        select((selected + 1) % options.length)
        break
      case 'ArrowUp':
        event.preventDefault()
        select((selected + options.length - 1) % options.length)
        break
      case 'Tab':
        if (!canAmend || event.shiftKey) return
        event.preventDefault()
        setFeedbackOpen(open => !open)
        break
      case 'Enter':
        event.preventDefault()
        submit(selected, showFeedback ? note : undefined)
        break
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        submit(choices.indexOf(NO))
        break
    }
  }

  return (
    <div
      ref={cardRef}
      className="ai-assist-connector-approval"
      role="dialog"
      aria-modal="false"
      aria-label={t('ai_assist_connector_approve_label', 'Tool use')}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      data-testid="connector-approval-card"
    >
      <div className="ai-assist-connector-approval-title">
        <MaterialIcon type="build" />
        {t('ai_assist_connector_approve_label', 'Tool use')}
      </div>

      <div className="ai-assist-connector-approval-call">
        <div className="ai-assist-connector-approval-name">
          <span>{displayName}</span>
          <span className="ai-assist-connector-approval-tag">MCP</span>
        </div>
        {entries.length > 0 ? (
          <dl className="ai-assist-connector-approval-args">
            {entries.map(([key, val]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{formatArg(val)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>

      <div className="ai-assist-connector-approval-question">
        {t('ai_assist_connector_approve_question', 'Do you want to proceed?')}
      </div>

      <ol className="ai-assist-connector-approval-options" role="listbox">
        {options.map((label, index) => {
          const isSelected = index === selected
          return (
            <li
              key={index}
              role="option"
              aria-selected={isSelected}
              className={isSelected ? 'is-selected' : undefined}
              onMouseEnter={() => select(index)}
              onClick={() =>
                submit(index, isSelected && showFeedback ? note : undefined)
              }
            >
              <span
                className="ai-assist-connector-approval-cursor"
                aria-hidden="true"
              >
                {isSelected ? '❯' : ''}
              </span>
              <span className="ai-assist-connector-approval-index">
                {index + 1}.
              </span>
              <span className="ai-assist-connector-approval-label">
                {label}
              </span>
            </li>
          )
        })}
      </ol>

      {showFeedback ? (
        <input
          ref={noteRef}
          type="text"
          className="form-control form-control-sm ai-assist-connector-approval-note"
          value={note}
          disabled={submitted}
          aria-label={t('ai_assist_connector_approve_feedback', 'Feedback')}
          placeholder={
            selected === YES
              ? t(
                  'ai_assist_connector_approve_next',
                  'and tell the assistant what to do next'
                )
              : t(
                  'ai_assist_connector_approve_differently',
                  'and tell the assistant what to do differently'
                )
          }
          onChange={event => setNote(event.target.value)}
        />
      ) : null}

      <div className="ai-assist-connector-approval-hint">
        {canAmend
          ? t(
              'ai_assist_connector_approve_hint_amend',
              'Esc to cancel · Tab to amend'
            )
          : t('ai_assist_connector_approve_hint', 'Esc to cancel')}
      </div>
    </div>
  )
}
