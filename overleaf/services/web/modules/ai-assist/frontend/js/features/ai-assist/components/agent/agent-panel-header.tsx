import { useTranslation } from 'react-i18next'
import { useRailContext } from '@/features/ide-react/context/rail-context'
import OLIconButton from '@/shared/components/ol/ol-icon-button'
import React, { useCallback, useState, useRef, useEffect } from 'react'
import OLTooltip from '@/shared/components/ol/ol-tooltip'
import { PencilSimple, Check, X } from '@phosphor-icons/react'

/**
 * Same markup as the core RailPanelHeader, but a supplied onClose replaces
 * collapsing the rail pane. The right-docked panel is not in the rail, so
 * closing it must not collapse the left pane. Kept in the module so the core
 * header stays identical to upstream.
 */
export default function AgentPanelHeader({
  title,
  actions,
  onClose,
  onRenameTitle,
}: {
  title: React.ReactNode
  actions?: React.ReactElement
  onClose?: () => void
  onRenameTitle?: (newTitle: string) => void
}) {
  const { t } = useTranslation()
  const { handlePaneCollapse } = useRailContext()
  const [isEditing, setIsEditing] = useState(false)
  const titleText = typeof title === 'string' ? title : ''
  const [draft, setDraft] = useState(titleText)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setDraft(titleText)
  }, [titleText])

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [isEditing])

  const handleClose = useCallback(() => {
    if (onClose) {
      onClose()
    } else {
      handlePaneCollapse()
    }
  }, [handlePaneCollapse, onClose])

  const commitRename = useCallback(() => {
    const trimmed = draft.trim()
    setIsEditing(false)
    if (trimmed && trimmed !== titleText && onRenameTitle) {
      onRenameTitle(trimmed)
    } else {
      setDraft(titleText)
    }
  }, [draft, onRenameTitle, titleText])

  const cancelRename = useCallback(() => {
    setIsEditing(false)
    setDraft(titleText)
  }, [titleText])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        commitRename()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        cancelRename()
      }
    },
    [commitRename, cancelRename]
  )

  return (
    <div className="rail-panel-header ai-assist-header-bar">
      {isEditing ? (
        <div className="ai-assist-header-edit-container">
          <input
            ref={inputRef}
            type="text"
            className="ai-assist-header-edit-input"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={commitRename}
            maxLength={60}
          />
          <button
            type="button"
            className="btn icon-button-small rail-panel-header-button-subdued ai-assist-header-edit-save"
            aria-label={t('save', 'Save')}
            onMouseDown={e => {
              e.preventDefault()
              commitRename()
            }}
          >
            <Check size={14} weight="bold" />
          </button>
          <button
            type="button"
            className="btn icon-button-small rail-panel-header-button-subdued ai-assist-header-edit-cancel"
            aria-label={t('cancel', 'Cancel')}
            onMouseDown={e => {
              e.preventDefault()
              cancelRename()
            }}
          >
            <X size={14} weight="bold" />
          </button>
        </div>
      ) : (
        <div className="ai-assist-header-title-wrapper">
          <h4
            className={`rail-panel-title ai-assist-panel-title-text ${
              onRenameTitle ? 'is-editable' : ''
            }`}
            title={titleText || undefined}
            onClick={() => onRenameTitle && setIsEditing(true)}
          >
            {title}
          </h4>
          {onRenameTitle && Boolean(titleText) && (
            <OLTooltip
              id="ai-assist-rename-chat-tooltip"
              description={t('rename', 'Rename')}
              overlayProps={{ placement: 'bottom' }}
            >
              <button
                type="button"
                className="ai-assist-header-rename-btn"
                aria-label={t('rename', 'Rename')}
                onClick={() => setIsEditing(true)}
              >
                <PencilSimple size={13} weight="bold" />
              </button>
            </OLTooltip>
          )}
        </div>
      )}

      <div className="rail-panel-header-actions">
        {actions}
        <OLTooltip
          id="close-rail-panel"
          description={t('close')}
          overlayProps={{ placement: 'bottom' }}
        >
          <OLIconButton
            onClick={handleClose}
            className="rail-panel-header-button-subdued"
            icon="close"
            accessibilityLabel={t('close')}
            size="sm"
          />
        </OLTooltip>
      </div>
    </div>
  )
}
