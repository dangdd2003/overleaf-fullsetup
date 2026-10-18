import { FC, useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Info, WarningCircle } from '@phosphor-icons/react'
import {
  OLModal,
  OLModalBody,
  OLModalFooter,
  OLModalHeader,
  OLModalTitle,
} from '@/shared/components/ol/ol-modal'
import OLButton from '@/shared/components/ol/ol-button'
import {
  checkRewind,
  RewindCheckResponse,
} from '../../agent/rewind-client'

export type RewindChoice = 'both' | 'conversation' | 'code'

export type RewindOptionConfig = {
  value: RewindChoice
  label: string
  description: string
}

export type RewindDialogProps = {
  isOpen: boolean
  projectId: string
  chatId: string
  userMessageId: string
  userMessageIds?: string[]
  initialChoice?: RewindChoice
  willFork?: boolean
  onClose: () => void
  /** Rejects with the reason when the rewind could not be done */
  onConfirm: (choice: RewindChoice) => Promise<void>
}

export const RewindDialog: FC<RewindDialogProps> = ({
  isOpen,
  projectId,
  chatId,
  userMessageId,
  userMessageIds,
  initialChoice = 'both',
  willFork = false,
  onClose,
  onConfirm,
}) => {
  const { t } = useTranslation()
  const [choice, setChoice] = useState<RewindChoice>(initialChoice)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [checkResult, setCheckResult] = useState<RewindCheckResponse | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Reset choice when initialChoice changes or modal opens
  useEffect(() => {
    if (isOpen) {
      setChoice(initialChoice)
      setSubmitError(null)
    }
  }, [isOpen, initialChoice])

  // Run dry-run check on open
  useEffect(() => {
    if (!isOpen || !projectId || !chatId || !userMessageId) {
      setCheckResult(null)
      setLoading(false)
      setError(null)
      return
    }

    let active = true
    setLoading(true)
    setError(null)

    checkRewind(projectId, chatId, userMessageId, userMessageIds)
      .then(result => {
        if (!active) return
        setCheckResult(result)
        setLoading(false)
      })
      .catch(err => {
        if (!active) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })

    return () => {
      active = false
    }
    // Ids are read once per open; a change to them is not a new check
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, projectId, chatId, userMessageId])

  const handleConfirm = useCallback(async () => {
    setIsSubmitting(true)
    setSubmitError(null)
    try {
      await onConfirm(choice)
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsSubmitting(false)
    }
  }, [choice, onConfirm])

  const selectChoice = (value: RewindChoice) => {
    setChoice(value)
    setSubmitError(null)
  }

  if (!isOpen) return null

  const title = willFork
    ? t('ai_assist_fork_and_rewind', 'Fork and rewind')
    : initialChoice === 'code'
      ? t('ai_assist_rewind_code', 'Rewind code')
      : t('ai_assist_rewind', 'Rewind')

  const options: RewindOptionConfig[] = [
    {
      value: 'both',
      label: t('ai_assist_restore_both', 'Restore code and conversation'),
      description: t(
        'ai_assist_restore_both_desc',
        'Restores the code to before this message and forks the conversation from here.'
      ),
    },
    {
      value: 'conversation',
      label: t('ai_assist_restore_conversation', 'Restore conversation'),
      description: t(
        'ai_assist_restore_conversation_desc',
        'Forks the conversation from here. The code will be unchanged.'
      ),
    },
    {
      value: 'code',
      label: t('ai_assist_restore_code', 'Restore code'),
      description: t(
        'ai_assist_restore_code_desc',
        'The conversation will be unchanged.'
      ),
    },
  ]

  const filesChanged = checkResult?.filesChanged || []
  const hasCodeChanges = filesChanged.length > 0
  const deletions = checkResult?.deletions ?? 0
  const insertions = checkResult?.insertions ?? 0
  // Code-only rewind with nothing to restore; 'both' still forks
  const nothingToRestore =
    choice === 'code' && checkResult !== null && !hasCodeChanges

  return (
    <OLModal
      show={isOpen}
      onHide={onClose}
      className="ai-assist-rewind-dialog"
      data-testid="ai-assist-rewind-dialog"
      escapeDeactivates={true}
      clickOutsideDeactivates={false}
    >
      <OLModalHeader closeButton>
        <OLModalTitle>{title}</OLModalTitle>
      </OLModalHeader>

      <OLModalBody>
        {willFork && (
          <p className="ai-assist-rewind-fork-note">
            {t(
              'ai_assist_rewind_fork_note',
              'A new forked conversation will be created after rewinding.'
            )}
          </p>
        )}

        <div
          className="ai-assist-rewind-choice-group"
          role="group"
          aria-label={t('ai_assist_what_to_restore', 'What to restore')}
        >
          {options.map(opt => (
            <button
              key={opt.value}
              type="button"
              className={`ai-assist-rewind-choice-option${
                choice === opt.value ? ' is-selected' : ''
              }`}
              aria-pressed={choice === opt.value}
              onClick={() => selectChoice(opt.value)}
            >
              <div className="ai-assist-rewind-choice-content">
                <span className="ai-assist-rewind-choice-label">
                  {opt.label}
                </span>
                <span className="ai-assist-rewind-choice-desc">
                  {opt.description}
                </span>
              </div>
            </button>
          ))}
        </div>

        {loading && (
          <p className="ai-assist-rewind-loading">
            {t('ai_assist_checking_code_changes', 'Checking code changes...')}
          </p>
        )}

        {!loading && error && (
          <div className="ai-assist-rewind-error" role="alert">
            <WarningCircle size={16} aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        {submitError && (
          <div className="ai-assist-rewind-error" role="alert">
            <WarningCircle size={16} aria-hidden="true" />
            <span>{submitError}</span>
          </div>
        )}

        {!loading && !error && (
          <div className="ai-assist-rewind-changes-container">
            {hasCodeChanges ? (
              <div className="ai-assist-rewind-changes">
                <p className="ai-assist-rewind-summary">
                  <span className="ai-assist-rewind-deletions">
                    {deletions} {deletions === 1 ? 'line' : 'lines'}
                  </span>{' '}
                  will be removed and{' '}
                  <span className="ai-assist-rewind-additions">
                    {insertions} {insertions === 1 ? 'line' : 'lines'}
                  </span>{' '}
                  will be added across {filesChanged.length}{' '}
                  {filesChanged.length === 1 ? 'file' : 'files'}:
                </p>
                <ul className="ai-assist-rewind-file-list">
                  {filesChanged.map(file => (
                    <li key={file} className="ai-assist-rewind-file-item">
                      {file}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="ai-assist-rewind-no-changes">
                {t(
                  'ai_assist_code_not_changed',
                  'The code has not changed, so no code will be restored.'
                )}
              </p>
            )}

            <p className="ai-assist-rewind-warning">
              <Info
                size={16}
                className="ai-assist-rewind-warning-icon"
                aria-hidden="true"
              />
              <span>
                {t(
                  'ai_assist_rewind_manual_edit_warning',
                  'Rewinding does not affect files edited manually.'
                )}
              </span>
            </p>
          </div>
        )}
      </OLModalBody>

      <OLModalFooter>
        <OLButton
          variant="secondary"
          onClick={onClose}
          disabled={isSubmitting}
        >
          {t('ai_assist_never_mind', 'Never mind')}
        </OLButton>
        <OLButton
          variant="primary"
          onClick={handleConfirm}
          disabled={loading || isSubmitting || nothingToRestore}
          isLoading={isSubmitting}
        >
          {willFork
            ? t('continue', 'Continue')
            : t('ai_assist_rewind', 'Rewind')}
        </OLButton>
      </OLModalFooter>
    </OLModal>
  )
}

export default RewindDialog
