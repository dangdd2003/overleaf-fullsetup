import { useTranslation } from 'react-i18next'
import type { StorageUsage } from '../../../api/types'
import { formatBytes, formatCount } from '../../../utils/format'
import SectionCard from '../../shared/section-card'

type StorageCardProps = {
  storage: StorageUsage
}

export default function StorageCard({ storage }: StorageCardProps) {
  const { t } = useTranslation()

  return (
    <SectionCard
      className="h-100"
      title={t('template_gallery_admin_monitor_storage')}
    >
      <dl className="row mb-0">
        <dt className="col-sm-5 text-muted">
          {t('template_gallery_admin_storage_used')}
        </dt>
        <dd className="col-sm-7">{formatBytes(storage.usedBytes)}</dd>
        <dt className="col-sm-5 text-muted">
          {t('template_gallery_admin_storage_files')}
        </dt>
        <dd className="col-sm-7">{formatCount(storage.files)}</dd>
        {storage.freeBytes !== null && storage.totalBytes !== null && (
          <>
            <dt className="col-sm-5 text-muted">
              {t('template_gallery_admin_storage_free')}
            </dt>
            <dd className="col-sm-7 mb-0">
              {t('template_gallery_admin_storage_free_of', {
                free: formatBytes(storage.freeBytes),
                total: formatBytes(storage.totalBytes),
              })}
            </dd>
          </>
        )}
      </dl>
    </SectionCard>
  )
}
