import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CaretRight,
  Crop,
  Paperclip,
  PlugsConnected,
  Wrench,
} from '@phosphor-icons/react'
import { useChatConnectors } from '../../connectors/use-chat-connectors'
import { ConnectorView } from '../../connectors/types'
import { placementSide, useFloatingBox } from '../../floating/use-floating-box'
import { SiteIcon, connectorIconUrl } from './site-icon'

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

const SUBMENU_GAP_PX = 2

/**
 * The submenu opens beside the whole plus menu, not beside the row that
 * opened it: its anchor spans the menu's width and only takes the row's
 * height. A submenu placed to the right of that anchor starts at the menu's
 * right edge, and one flipped to the left ends at its left edge, so it can
 * never land on top of the menu it belongs to.
 */
export function submenuAnchor(trigger: HTMLElement) {
  return {
    get contextElement() {
      return trigger
    },
    getBoundingClientRect: () => {
      const row = trigger.getBoundingClientRect()
      const menu = trigger.closest<HTMLElement>('.ai-assist-plus-menu')
      const box = menu?.getBoundingClientRect()
      const x = box?.x ?? row.x
      const width = box?.width ?? row.width
      const y = box?.y ?? row.y
      const height = box?.height ?? row.height
      return {
        x,
        y,
        width,
        height,
        top: y,
        left: x,
        right: x + width,
        bottom: y + height,
      }
    },
  }
}

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

export function ConnectorAvatar({
  connector,
}: {
  connector: ConnectorView
}) {
  // Without an icon the row shows the generic connector glyph, the one
  // Claude Code gives every connector row
  return (
    <span className="ai-assist-plus-connector-avatar" aria-hidden="true">
      <SiteIcon
        url={connector.url}
        src={connectorIconUrl(connector)}
        className="ai-assist-plus-connector-icon"
        fallback={
          <span className="ai-assist-plus-menu-icon">
            <PlugsConnected size={16} />
          </span>
        }
      />
    </span>
  )
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
  const connectorsItemRef = useRef<HTMLButtonElement | null>(null)
  const submenuRef = useRef<HTMLDivElement | null>(null)
  // Read by the document keydown handler, which must know whether Escape
  // should close the submenu or the whole menu.
  const submenuOpenRef = useRef(false)
  const focusFirstOnOpenRef = useRef(false)

  const [submenuOpen, setSubmenuOpen] = useState(false)
  const submenuBodyRef = useRef<HTMLDivElement | null>(null)

  const {
    enabled: showConnectors,
    connectors,
    disabledIds,
    setEnabled: setConnectorEnabled,
  } = useChatConnectors(chatId, { active: isOpen })

  // Beside the Connectors row: right, else left, kept inside the viewport
  const {
    refs,
    floatingStyles,
    isPositioned,
    placement: submenuPlacement,
  } = useFloatingBox({
    open: submenuOpen && showConnectors,
    placement: 'right-end',
    fallbackPlacements: ['left-end', 'right-start', 'left-start'],
    gap: SUBMENU_GAP_PX,
    // The anchor already spans the menu, so the box must not slide back
    // along the axis it opens on
    shiftMainAxis: false,
  })
  const setConnectorsItem = useCallback(
    (node: HTMLButtonElement | null) => {
      connectorsItemRef.current = node
      refs.setReference(node)
      refs.setPositionReference(node ? submenuAnchor(node) : null)
    },
    [refs]
  )
  const setSubmenu = useCallback(
    (node: HTMLDivElement | null) => {
      submenuRef.current = node
      refs.setFloating(node)
    },
    [refs]
  )

  const openSubmenu = useCallback(
    (focusFirst: boolean) => {
      focusFirstOnOpenRef.current = focusFirst
      submenuOpenRef.current = true
      setSubmenuOpen(true)
    },
    []
  )

  // The flyout grows with its rows up to the room the viewport leaves, and
  // scrolls past that. An edge fades out while there is more to scroll
  // towards it, as Claude Code's menus do
  useEffect(() => {
    const body = submenuBodyRef.current
    if (!submenuOpen || !body) return
    const updateFade = () => {
      const { scrollTop, scrollHeight, clientHeight } = body
      body.toggleAttribute('data-fade-top', scrollTop > 0)
      body.toggleAttribute(
        'data-fade-bottom',
        scrollTop + clientHeight < scrollHeight - 1
      )
    }
    updateFade()
    body.addEventListener('scroll', updateFade, { passive: true })
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(updateFade)
    observer?.observe(body)
    return () => {
      body.removeEventListener('scroll', updateFade)
      observer?.disconnect()
    }
  }, [submenuOpen, connectors.length])

  const closeSubmenu = useCallback(
    (returnFocus: boolean) => {
      submenuOpenRef.current = false
      setSubmenuOpen(false)
      if (returnFocus) connectorsItemRef.current?.focus()
    },
    []
  )

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

  // Focus the first row when the submenu was opened from the keyboard
  useEffect(() => {
    if (!submenuOpen || !focusFirstOnOpenRef.current) return
    focusFirstOnOpenRef.current = false
    submenuRef.current
      ?.querySelector<HTMLElement>('[role^="menuitem"]')
      ?.focus()
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
    if (submenuOpenRef.current) {
      closeSubmenu(false)
    } else {
      openSubmenu(false)
    }
  }

  const handleConnectorsKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowRight' || event.key === 'Enter') {
      event.preventDefault()
      openSubmenu(true)
    }
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
        <span className="ai-assist-plus-menu-label">
          {t('ai_assist_add_files_or_photos', 'Add files or photos')}
        </span>
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
          <span className="ai-assist-plus-menu-label">
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
        <span className="ai-assist-plus-menu-label">
          {t('ai_assist_slash_commands', 'Slash commands')}
        </span>
      </button>

      {showConnectors && (
        <button
          ref={setConnectorsItem}
          type="button"
          className={`ai-assist-plus-menu-item ${submenuOpen ? 'is-open' : ''}`}
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={submenuOpen}
          onClick={handleConnectorsClick}
          onKeyDown={handleConnectorsKeyDown}
        >
          <span className="ai-assist-plus-menu-icon" aria-hidden="true">
            <PlugsConnected size={16} />
          </span>
          <span className="ai-assist-plus-menu-label">
            {t('ai_assist_chat_connectors', 'Connectors')}
          </span>
          <CaretRight
            size={14}
            className="ai-assist-plus-menu-chevron"
            aria-hidden="true"
          />
        </button>
      )}

      {showConnectors && submenuOpen && (
        <div
          ref={setSubmenu}
          className="ai-assist-plus-submenu"
          data-placement={placementSide(submenuPlacement)}
          role="menu"
          aria-label={t('ai_assist_chat_connectors', 'Connectors')}
          style={{
            ...floatingStyles,
            opacity: isPositioned ? undefined : 0,
          }}
          onKeyDown={handleSubmenuKeyDown}
        >
          <div
            ref={submenuBodyRef}
            className="ai-assist-plus-submenu-body"
            role="none"
          >
            <button
              type="button"
              className="ai-assist-plus-menu-item"
              role="menuitem"
              onClick={handleManageConnectors}
            >
              <span className="ai-assist-plus-menu-icon" aria-hidden="true">
                <Wrench size={16} />
              </span>
              <span className="ai-assist-plus-menu-label">
                {t('ai_assist_manage_connectors', 'Manage connectors')}
              </span>
            </button>

            <div className="ai-assist-plus-submenu-separator" role="separator" />

            {connectors.length === 0 ? (
              <div className="ai-assist-plus-submenu-empty" role="none">
                {t(
                  'ai_assist_no_connectors_configured',
                  'No connectors configured'
                )}
              </div>
            ) : (
              connectors.map(connector => {
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
                    <ConnectorAvatar connector={connector} />
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
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}
