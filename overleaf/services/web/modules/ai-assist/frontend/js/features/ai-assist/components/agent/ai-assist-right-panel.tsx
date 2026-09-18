import { FC, useCallback, useState } from 'react'
import { Panel } from 'react-resizable-panels'
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
  const enabled =
    Boolean(getMeta('ol-aiAssistEnabled')) &&
    getMeta('ol-showAiFeatures') !== false

  const handleClose = useCallback(() => {
    setIsRightOpen(false)
  }, [setIsRightOpen])

  if (!enabled || dock !== 'right' || !isRightOpen) {
    return null
  }

  return (
    <>
      <HorizontalResizeHandle
        id="ide-redesign-ai-assist-resize-handle"
        resizable
        hitAreaMargins={{ coarse: 0, fine: 0 }}
        onDragging={setResizing}
        onDoubleClick={() => setIsRightOpen(!isRightOpen)}
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
        defaultSize={25}
        minSize={15}
        maxSize={50}
        collapsible
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
