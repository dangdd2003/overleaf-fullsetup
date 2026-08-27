import { ElementType } from 'react'
import importOverleafModules from '../../../macros/import-overleaf-module.macro'
import { useTranslation } from 'react-i18next'
import RailPanelHeader from '@/features/ide-react/components/rail/rail-panel-header'
import { useRailContext } from '@/features/ide-react/context/rail-context'
import GitLogoOrange from '@/shared/svgs/git-logo-orange'
import getMeta from '@/utils/meta'

const integrationPanelComponents = importOverleafModules(
  'integrationPanelComponents'
) as { import: { default: ElementType }; path: string }[]

export default function IntegrationsPanel() {
  const { t } = useTranslation()
  const { setActiveModal } = useRailContext()
  const gitBridgeEnabled = getMeta('ol-gitBridgeEnabled')

  return (
    <div className="integrations-panel">
      <RailPanelHeader title={t('integrations', 'Integrations')} />
      {integrationPanelComponents.map(
        ({ import: { default: Component }, path }) => (
          <Component key={path} />
        )
      )}
      {gitBridgeEnabled && (
        <button
          type="button"
          className="integrations-panel-card-button"
          data-testid="git-integration-card"
          onClick={() => setActiveModal('git-bridge')}
          aria-label={t('git_clone_this_project', 'Git clone this project.')}
        >
          <div className="integrations-panel-card-contents">
            <div className="integrations-panel-card-icon">
              <GitLogoOrange size={24} />
            </div>
            <div className="integrations-panel-card-inner">
              <div className="integrations-panel-card-header">
                <span className="integrations-panel-card-title">
                  {t('git', 'Git')}
                </span>
              </div>
              <p className="integrations-panel-card-description">
                {t('git_clone_this_project', 'Git clone this project.')}
              </p>
            </div>
          </div>
        </button>
      )}
    </div>
  )
}
