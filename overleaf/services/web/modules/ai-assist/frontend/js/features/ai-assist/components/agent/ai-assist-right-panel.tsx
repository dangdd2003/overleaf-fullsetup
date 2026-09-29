import { FC, useCallback, useLayoutEffect, useRef, useState } from 'react'
import { ImperativePanelHandle, Panel } from 'react-resizable-panels'
import { HorizontalResizeHandle } from '@/features/ide-react/components/resize/horizontal-resize-handle'
import { HorizontalToggler } from '@/features/ide-react/components/resize/horizontal-toggler'
import { useTranslation } from 'react-i18next'
import getMeta from '@/utils/meta'
import { useAiDock } from '../../hooks/use-ai-dock'
import { AgentPanel } from './agent-panel'
import '../../../../../stylesheets/ai-assist.scss'

export const AiAssistRightPanel: FC<{ order?: number }> = ({ order = 3 }) => {
  const { t } = useTranslation()
  const { dock, isRightOpen, setIsRightOpen } = useAiDock()
  const [, setResizing] = useState(false)
  const panelRef = useRef<ImperativePanelHandle>(null)
  const prevIsOpenRef = useRef(isRightOpen)
  const isFirstMountRef = useRef(true)

  useLayoutEffect(() => {
    if (isFirstMountRef.current) {
      isFirstMountRef.current = false
      prevIsOpenRef.current = isRightOpen
      if (!isRightOpen && panelRef.current) {
        try {
          if (!panelRef.current.isCollapsed()) {
            panelRef.current.collapse()
          }
        } catch {}
      }
      return
    }

    if (prevIsOpenRef.current === isRightOpen) {
      return
    }
    prevIsOpenRef.current = isRightOpen

    const panelHandle = panelRef.current
    if (!panelHandle) return

    try {
      if (isRightOpen) {
        if (panelHandle.isCollapsed()) {
          panelHandle.expand()
        }
      } else {
        if (!panelHandle.isCollapsed()) {
          panelHandle.collapse()
        }
      }
    } catch {}
  }, [isRightOpen])

  const enabled =
    Boolean(getMeta('ol-aiAssistEnabled')) &&
    getMeta('ol-showAiFeatures') !== false

  const handleClose = useCallback(() => {
    setIsRightOpen(false)
  }, [setIsRightOpen])

  const handleExpand = useCallback(() => {
    setIsRightOpen(true)
  }, [setIsRightOpen])

  const handleCollapse = useCallback(() => {
    setIsRightOpen(false)
  }, [setIsRightOpen])

  const toggleRightOpen = useCallback(() => {
    setIsRightOpen(!isRightOpen)
  }, [isRightOpen, setIsRightOpen])

  if (!enabled || dock !== 'right') {
    return null
  }

  return (
    <>
      <HorizontalResizeHandle
        id="ide-redesign-ai-assist-resize-handle"
        resizable
        hitAreaMargins={{ coarse: 0, fine: 0 }}
        onDragging={setResizing}
        onDoubleClick={toggleRightOpen}
      >
        <HorizontalToggler
          id="ide-redesign-ai-assist-panel-toggler"
          togglerType="east"
          isOpen={isRightOpen}
          setIsOpen={setIsRightOpen}
          tooltipWhenOpen={t('tooltip_hide_panel', 'Hide panel')}
          tooltipWhenClosed={t('tooltip_show_panel', 'Show panel')}
        />
      </HorizontalResizeHandle>
      <Panel
        id="ide-redesign-ai-assist-right-panel"
        order={order}
        defaultSize={20}
        minSize={5}
        maxSize={80}
        collapsible
        ref={panelRef}
        onExpand={handleExpand}
        onCollapse={handleCollapse}
        tagName="aside"
        aria-label={t('ai_assist_panel_title', 'AI assistant')}
      >
        <div className="ai-assist-right-panel-container">
          <AgentPanel dock="right" onClose={handleClose} />
        </div>
      </Panel>
    </>
  )
}

export default AiAssistRightPanel
