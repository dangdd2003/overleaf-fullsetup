import type { ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import OLFormControl from '@/shared/components/ol/ol-form-control'
import OLFormSelect from '@/shared/components/ol/ol-form-select'
import type { SyncDetailStatus, SyncFilter } from '../../api/types'
import { DETAIL_STATUS_KEYS } from '../shared/sync-status'

const SYNC_FILTERS: readonly SyncFilter[] = [
  'all',
  'ok',
  'syncing',
  'queued',
  'failed',
  'removed',
]

// Only a known filter value is accepted from the select
export function parseSyncFilter(value: string): SyncFilter | undefined {
  return SYNC_FILTERS.find(option => option === value)
}

type ItemsToolbarProps = {
  search: string
  onSearchChange(value: string): void
  sync: SyncFilter
  onSyncChange(value: SyncFilter): void
}

export default function ItemsToolbar({
  search,
  onSearchChange,
  sync,
  onSyncChange,
}: ItemsToolbarProps) {
  const { t } = useTranslation()

  return (
    <div className="d-flex justify-content-between align-items-center mb-3 flex-wrap gap-2">
      <div className="col-md-6 col-lg-4">
        <OLFormControl
          type="search"
          aria-label={t('search')}
          placeholder={t('template_gallery_admin_search_placeholder')}
          value={search}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            onSearchChange(event.target.value)
          }
        />
      </div>
      <OLFormSelect
        className="w-auto"
        aria-label={t('template_gallery_admin_filter_sync')}
        value={sync}
        onChange={(event: ChangeEvent<HTMLSelectElement>) => {
          const next = parseSyncFilter(event.target.value)
          if (next !== undefined) onSyncChange(next)
        }}
      >
        <option value="all">{t('template_gallery_admin_filter_all')}</option>
        {SYNC_FILTERS.filter(option => option !== 'all').map(option => (
          <option key={option} value={option}>
            {t(DETAIL_STATUS_KEYS[option as SyncDetailStatus])}
          </option>
        ))}
      </OLFormSelect>
    </div>
  )
}
