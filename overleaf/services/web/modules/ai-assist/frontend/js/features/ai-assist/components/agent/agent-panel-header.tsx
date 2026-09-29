import { useTranslation } from 'react-i18next'
import { useRailContext } from '@/features/ide-react/context/rail-context'
import OLIconButton from '@/shared/components/ol/ol-icon-button'
import React, { useCallback, useState, useRef, useEffect } from 'react'
import OLTooltip from '@/shared/components/ol/ol-tooltip'
import { PencilSimple, Check, X } from '@phosphor-icons/react'

type TitleTransition = { from: string; to: string }

/**
 * How fast the green edge moves: about 1.9× the status line's shimmer, whose
 * band crosses two widths of the word ("Brewing…", about 60px) in 1.2s.
 */
const STATUS_SHIMMER_PX_PER_S = 188

/**
 * The masks are 2.5× the title wide, so the green edge travels 1.5 of its
 * widths; the duration is set from the rendered width so the edge moves at
 * the status line's speed whatever the title's length.
 */
function setSweepDuration(container: HTMLElement | null) {
  if (!container) return
  const measuredWidth = container.getBoundingClientRect().width
  const fallbackWidth = (container.textContent?.length || 10) * 8
  const width = measuredWidth > 0 ? measuredWidth : fallbackWidth
  const travel = 1.5 * width
  const seconds = Math.max(0.32, travel / STATUS_SHIMMER_PX_PER_S)
  container.style.setProperty(
    '--ai-title-animation-duration',
    `${seconds.toFixed(2)}s`
  )
}

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
  isGeneratingTitle = false,
  onTitleAnimationEnd,
}: {
  title: React.ReactNode
  actions?: React.ReactElement
  onClose?: () => void
  onRenameTitle?: (newTitle: string) => void
  isGeneratingTitle?: boolean
  onTitleAnimationEnd?: () => void
}) {
  const { t } = useTranslation()
  const { handlePaneCollapse } = useRailContext()
  const [isEditing, setIsEditing] = useState(false)
  const titleText = typeof title === 'string' ? title : ''
  const [draft, setDraft] = useState(titleText)
  const inputRef = useRef<HTMLInputElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)

  const defaultTitle = t('ai_assist_panel_title', 'AI assistant')
  const [shownTitle, setShownTitle] = useState(titleText)
  const [transition, setTransition] = useState<TitleTransition | null>(() =>
    isGeneratingTitle && titleText && titleText !== defaultTitle
      ? { from: defaultTitle, to: titleText }
      : null
  )

  // Set during render, not in an effect, so the new title is never painted
  // on its own for a frame before the sweep starts
  if (titleText !== shownTitle) {
    setShownTitle(titleText)
    const from = shownTitle || defaultTitle
    setTransition(
      isGeneratingTitle && titleText && titleText !== from
        ? { from, to: titleText }
        : null
    )
  }

  const finishTransition = useCallback(() => {
    setTransition(null)
    onTitleAnimationEnd?.()
  }, [onTitleAnimationEnd])

  const startEditing = useCallback(() => {
    if (transition) finishTransition()
    setIsEditing(true)
  }, [finishTransition, transition])

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
            ref={titleRef}
            className={`rail-panel-title ai-assist-panel-title-text ${
              onRenameTitle ? 'is-editable' : ''
            }`}
            title={titleText || undefined}
            onClick={() => onRenameTitle && startEditing()}
          >
            {transition ? (
              <span
                // A swap that starts mid-sweep (switching chats quickly)
                // remounts, so its animation starts over from the left
                key={`${transition.from}\u0000${transition.to}`}
                ref={setSweepDuration}
                className="ai-assist-title-transform-container"
                onAnimationEnd={event => {
                  // Every layer ends together; one call is enough
                  const target = event.target as HTMLElement
                  if (
                    target === event.currentTarget ||
                    target.classList?.contains('ai-assist-title-layer-new')
                  ) {
                    finishTransition()
                  }
                }}
              >
                <span
                  className="ai-assist-title-layer ai-assist-title-layer-old"
                  aria-hidden="true"
                >
                  {transition.from}
                </span>
                <span className="ai-assist-title-layer ai-assist-title-layer-new">
                  {transition.to}
                </span>
                <span
                  className="ai-assist-title-layer ai-assist-title-layer-edge"
                  aria-hidden="true"
                >
                  {transition.to}
                </span>
              </span>
            ) : (
              title
            )}
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
                onClick={startEditing}
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
