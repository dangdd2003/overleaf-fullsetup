import { useTranslation } from 'react-i18next'
import { useRailContext } from '@/features/ide-react/context/rail-context'
import OLIconButton from '@/shared/components/ol/ol-icon-button'
import React, { useCallback } from 'react'
import OLTooltip from '@/shared/components/ol/ol-tooltip'

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
}: {
  title: React.ReactNode
  actions?: React.ReactElement
  onClose?: () => void
}) {
  const { t } = useTranslation()
  const { handlePaneCollapse } = useRailContext()

  const handleClose = useCallback(() => {
    if (onClose) {
      onClose()
    } else {
      handlePaneCollapse()
    }
  }, [handlePaneCollapse, onClose])

  return (
    <div className="rail-panel-header">
      <h4 className="rail-panel-title">{title}</h4>

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
