import { useTranslation } from 'react-i18next'
import { useRailContext } from '@/features/ide-react/context/rail-context'
import GoogleDriveLogo from '@/shared/svgs/google-drive-logo'
import getMeta from '@/utils/meta'

export default function GoogleDrivePanel() {
  const googleDriveSyncEnabled = getMeta('ol-googleDriveSyncEnabled')
  const { t } = useTranslation()
  const { setActiveModal } = useRailContext()

  if (!googleDriveSyncEnabled) {
    return null
  }

  return (
    <button
      type="button"
      className="integrations-panel-card-button"
      data-testid="google-drive-integration-card"
      onClick={() => setActiveModal('google-drive')}
      aria-label={t(
        'google_drive_sync_this_project',
        'Synchronize with Google Drive'
      )}
    >
      <div className="integrations-panel-card-contents">
        <div className="integrations-panel-card-icon">
          <GoogleDriveLogo size={24} />
        </div>
        <div className="integrations-panel-card-inner">
          <div className="integrations-panel-card-header">
            <span className="integrations-panel-card-title">
              {t('google_drive', 'Google Drive')}
            </span>
          </div>
          <p className="integrations-panel-card-description">
            {t(
              'google_drive_sync_this_project',
              'Synchronize with Google Drive'
            )}
          </p>
        </div>
      </div>
    </button>
  )
}
