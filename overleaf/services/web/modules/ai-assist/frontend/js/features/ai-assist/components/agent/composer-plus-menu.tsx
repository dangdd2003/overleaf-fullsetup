import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  CaretRight,
  Crop,
  GearSix,
  Paperclip,
  PlugsConnected,
} from '@phosphor-icons/react'
import { useChatConnectors } from '../../connectors/use-chat-connectors'
import { ConnectorView } from '../../connectors/types'

export interface ComposerPlusMenuProps {
  isOpen: boolean
  onClose: () => void
  onAddFiles: () => void
  onSlashCommands: () => void
  /** The chat whose connector selection the Connectors submenu edits. */
  chatId?: string | null
  isMac?: boolean
  /** Starts or cancels drawing a box on the PDF; the item shows only with it. */
  onTogglePdfArea?: () => void
  /** Whether a box is being drawn, so the item offers to cancel it. */
  pdfAreaSelecting?: boolean
}

// Where the submenu sits relative to the plus menu. `right` is the default;
// the others are used when the panel is too narrow to show it there.
type SubmenuPlacement = 'right' | 'left' | 'below'

const SUBMENU_OPEN_DELAY_MS = 120
const SUBMENU_CLOSE_DELAY_MS = 150
const VIEWPORT_GUTTER_PX = 8
const SUBMENU_GAP_PX = 4

export function SquareSlashIcon({
  size = 16,
  className,
}: {
  size?: number
  className?: string
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <line x1="5.5" y1="11.5" x2="10.5" y2="4.5" />
    </svg>
  )
}

function detectMac(): boolean {
  if (typeof window === 'undefined' || !window.navigator) {
    return false
  }
  const platform =
    (window.navigator as any).userAgentData?.platform ||
    window.navigator.platform ||
    window.navigator.userAgent ||
    ''
  return /Mac/i.test(platform)
}

function connectorInitial(connector: ConnectorView) {
  return connector.name.trim().charAt(0).toUpperCase() || '?'
}

export function ComposerPlusMenu({
  isOpen,
  onClose,
  onAddFiles,
  onSlashCommands,
  chatId = null,
  isMac: isMacProp,
  onTogglePdfArea,
  pdfAreaSelecting = false,
}: ComposerPlusMenuProps) {
  const { t } = useTranslation()
  const menuRef = useRef<HTMLDivElement>(null)
  const connectorsItemRef = useRef<HTMLButtonElement>(null)
  const submenuRef = useRef<HTMLDivElement>(null)
  const openTimerRef = useRef<number | undefined>(undefined)
  const closeTimerRef = useRef<number | undefined>(undefined)
  // Read by the document keydown handler, which must know whether Escape
  // should close the submenu or the whole menu.
  const submenuOpenRef = useRef(false)
  const focusFirstOnOpenRef = useRef(false)

  const [submenuOpen, setSubmenuOpen] = useState(false)
  const [submenuPlacement, setSubmenuPlacement] =
    useState<SubmenuPlacement>('right')
  const [submenuTop, setSubmenuTop] = useState(0)

  const {
    enabled: showConnectors,
    connectors,
    disabledIds,
    setEnabled: setConnectorEnabled,
  } = useChatConnectors(chatId, { active: isOpen })

  const clearTimers = useCallback(() => {
    window.clearTimeout(openTimerRef.current)
    window.clearTimeout(closeTimerRef.current)
  }, [])

  const openSubmenu = useCallback(
    (focusFirst: boolean) => {
      clearTimers()
      focusFirstOnOpenRef.current = focusFirst
      submenuOpenRef.current = true
      setSubmenuTop(connectorsItemRef.current?.offsetTop ?? 0)
      setSubmenuPlacement('right')
      setSubmenuOpen(true)
    },
    [clearTimers]
  )

  const closeSubmenu = useCallback(
    (returnFocus: boolean) => {
      clearTimers()
      submenuOpenRef.current = false
      setSubmenuOpen(false)
      if (returnFocus) connectorsItemRef.current?.focus()
    },
    [clearTimers]
  )

  const scheduleSubmenuClose = () => {
    window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = window.setTimeout(
      () => closeSubmenu(false),
      SUBMENU_CLOSE_DELAY_MS
    )
  }

  const cancelSubmenuClose = () => {
    window.clearTimeout(closeTimerRef.current)
  }

  useEffect(() => {
    if (!isOpen) return

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (menuRef.current && !menuRef.current.contains(target)) {
        onClose()
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (submenuOpenRef.current) {
          // Escape backs out of the submenu first; the menu stays open
          closeSubmenu(true)
          return
        }
        onClose()
      }
    }

    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, onClose, closeSubmenu])

  // The submenu belongs to one opening of the menu
  useEffect(() => {
    if (!isOpen) closeSubmenu(false)
  }, [isOpen, closeSubmenu])

  useEffect(() => () => clearTimers(), [clearTimers])

  // Focus the first row when the submenu was opened from the keyboard
  useEffect(() => {
    if (!submenuOpen || !focusFirstOnOpenRef.current) return
    focusFirstOnOpenRef.current = false
    submenuRef.current
      ?.querySelector<HTMLElement>('[role^="menuitem"]')
      ?.focus()
  }, [submenuOpen])

  // Flip the submenu to whichever side fits: right, then left, then below
  useLayoutEffect(() => {
    if (!submenuOpen) return
    const menu = menuRef.current
    const submenu = submenuRef.current
    if (!menu || !submenu) return

    const panel = menu.closest('.ai-assist-panel')?.getBoundingClientRect()
    const minLeft = Math.max(VIEWPORT_GUTTER_PX, panel?.left ?? 0)
    const maxRight = Math.min(
      window.innerWidth - VIEWPORT_GUTTER_PX,
      panel?.right ?? Infinity
    )
    const menuRect = menu.getBoundingClientRect()
    const submenuRect = submenu.getBoundingClientRect()

    if (submenuRect.right <= maxRight) {
      setSubmenuPlacement('right')
    } else if (menuRect.left - SUBMENU_GAP_PX - submenuRect.width >= minLeft) {
      setSubmenuPlacement('left')
    } else {
      setSubmenuPlacement('below')
    }
  }, [submenuOpen])

  if (!isOpen) {
    return null
  }

  const isMacPlatform = isMacProp ?? detectMac()
  const shortcut = isMacPlatform ? '⌘U' : 'Ctrl+U'

  const handleAddFiles = (event: React.MouseEvent) => {
    event.preventDefault()
    onAddFiles()
    onClose()
  }

  const handlePdfArea = (event: React.MouseEvent) => {
    event.preventDefault()
    onTogglePdfArea?.()
    onClose()
  }

  const handleSlashCommands = (event: React.MouseEvent) => {
    event.preventDefault()
    onSlashCommands()
    onClose()
  }

  const handleConnectorsClick = (event: React.MouseEvent) => {
    event.preventDefault()
    openSubmenu(false)
  }

  const handleConnectorsKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowRight' || event.key === 'Enter') {
      event.preventDefault()
      openSubmenu(true)
    }
  }

  const handleConnectorsHoverEnter = () => {
    cancelSubmenuClose()
    if (submenuOpenRef.current) return
    window.clearTimeout(openTimerRef.current)
    openTimerRef.current = window.setTimeout(
      () => openSubmenu(false),
      SUBMENU_OPEN_DELAY_MS
    )
  }

  const handleConnectorsHoverLeave = () => {
    window.clearTimeout(openTimerRef.current)
    scheduleSubmenuClose()
  }

  const handleManageConnectors = (event: React.MouseEvent) => {
    event.preventDefault()
    window.open('/user/settings#ai-connectors', '_blank', 'noopener')
    onClose()
  }

  const handleSubmenuKeyDown = (event: React.KeyboardEvent) => {
    const rows = Array.from(
      submenuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ??
        []
    )
    if (rows.length === 0) return
    const index = rows.indexOf(document.activeElement as HTMLElement)

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      rows[(index + 1) % rows.length].focus()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      rows[(index - 1 + rows.length) % rows.length].focus()
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      closeSubmenu(true)
    }
  }

  const handleConnectorRowKeyDown = (
    event: React.KeyboardEvent,
    connectorId: string,
    isActive: boolean
  ) => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault()
      setConnectorEnabled(connectorId, !isActive)
    }
  }

  const submenuClassName = [
    'ai-assist-plus-submenu',
    submenuPlacement !== 'right'
      ? `ai-assist-plus-submenu--${submenuPlacement}`
      : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      ref={menuRef}
      className="ai-assist-plus-menu"
      role="menu"
      aria-label={t('ai_assist_plus_menu', 'Add items')}
    >
      <button
        type="button"
        className="ai-assist-plus-menu-item"
        role="menuitem"
        onClick={handleAddFiles}
      >
        <span className="ai-assist-plus-menu-icon" aria-hidden="true">
          <Paperclip size={16} />
        </span>
        <span>{t('ai_assist_add_files_or_photos', 'Add files or photos')}</span>
        <span className="ai-assist-plus-menu-shortcut">{shortcut}</span>
      </button>

      {onTogglePdfArea && (
        <button
          type="button"
          className="ai-assist-plus-menu-item"
          role="menuitem"
          aria-pressed={pdfAreaSelecting}
          title={t(
            'ai_assist_pdf_area_select_hint',
            'Draw a box on the PDF to send that part to the AI'
          )}
          onClick={handlePdfArea}
        >
          <span className="ai-assist-plus-menu-icon" aria-hidden="true">
            <Crop size={16} />
          </span>
          <span>
            {pdfAreaSelecting
              ? t('ai_assist_pdf_area_cancel', 'Cancel PDF area')
              : t('ai_assist_pdf_area_select', 'Select PDF area')}
          </span>
          {pdfAreaSelecting && (
            <span className="ai-assist-plus-menu-shortcut">Esc</span>
          )}
        </button>
      )}

      <button
        type="button"
        className="ai-assist-plus-menu-item"
        role="menuitem"
        onClick={handleSlashCommands}
      >
        <span className="ai-assist-plus-menu-icon" aria-hidden="true">
          <SquareSlashIcon size={16} />
        </span>
        <span>{t('ai_assist_slash_commands', 'Slash commands')}</span>
      </button>

      {showConnectors && (
        <button
          ref={connectorsItemRef}
          type="button"
          className={`ai-assist-plus-menu-item ${submenuOpen ? 'is-open' : ''}`}
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={submenuOpen}
          onClick={handleConnectorsClick}
          onKeyDown={handleConnectorsKeyDown}
          onMouseEnter={handleConnectorsHoverEnter}
          onMouseLeave={handleConnectorsHoverLeave}
        >
          <span className="ai-assist-plus-menu-icon" aria-hidden="true">
            <PlugsConnected size={16} />
          </span>
          <span>{t('ai_assist_chat_connectors', 'Connectors')}</span>
          <CaretRight
            size={14}
            className="ai-assist-plus-menu-chevron"
            aria-hidden="true"
          />
        </button>
      )}

      {showConnectors && submenuOpen && (
        <div
          ref={submenuRef}
          className={submenuClassName}
          role="menu"
          aria-label={t('ai_assist_chat_connectors', 'Connectors')}
          style={submenuPlacement === 'below' ? undefined : { top: submenuTop }}
          onMouseEnter={cancelSubmenuClose}
          onMouseLeave={scheduleSubmenuClose}
          onKeyDown={handleSubmenuKeyDown}
        >
          <button
            type="button"
            className="ai-assist-plus-menu-item"
            role="menuitem"
            onClick={handleManageConnectors}
          >
            <span className="ai-assist-plus-menu-icon" aria-hidden="true">
              <GearSix size={16} />
            </span>
            <span>
              {t('ai_assist_manage_connectors', 'Manage connectors')}
            </span>
          </button>

          {connectors.length === 0 ? (
            <div
              className="ai-assist-plus-submenu-empty"
              role="none"
            >
              {t(
                'ai_assist_no_connectors_configured',
                'No connectors configured'
              )}
            </div>
          ) : (
            <>
              <div
                className="ai-assist-plus-submenu-separator"
                role="separator"
              />
              {connectors.map(connector => {
                const isActive = !disabledIds.includes(connector.id)
                return (
                  <div
                    key={connector.id}
                    role="menuitemcheckbox"
                    aria-checked={isActive}
                    tabIndex={0}
                    title={connector.name}
                    className="ai-assist-plus-menu-item ai-assist-plus-connector"
                    onClick={event => {
                      event.preventDefault()
                      setConnectorEnabled(connector.id, !isActive)
                    }}
                    onKeyDown={event =>
                      handleConnectorRowKeyDown(event, connector.id, isActive)
                    }
                  >
                    <span
                      className="ai-assist-plus-connector-avatar"
                      aria-hidden="true"
                    >
                      {connectorInitial(connector)}
                    </span>
                    <span className="ai-assist-plus-connector-name">
                      {connector.name}
                    </span>
                    <span
                      className={`ai-assist-plus-switch ${isActive ? 'is-on' : ''}`}
                      aria-hidden="true"
                    >
                      <span className="ai-assist-plus-switch-knob" />
                    </span>
                  </div>
                )
              })}
            </>
          )}
        </div>
      )}
    </div>
  )
}
