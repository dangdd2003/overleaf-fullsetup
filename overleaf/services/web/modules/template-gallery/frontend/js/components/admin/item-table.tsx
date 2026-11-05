import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import MaterialIcon from '@/shared/components/material-icon'
import OLButton from '@/shared/components/ol/ol-button'
import OLSpinner from '@/shared/components/ol/ol-spinner'
import OLTable from '@/shared/components/ol/ol-table'
import { hydrateItem } from '../../api/client'
import { errorMessage, detailsRefetchFailureMessage } from '../../api/errors'
import type { ItemRow, SyncBlock } from '../../api/types'
import { DetailStatusBadge } from '../shared/sync-status'
import type { Flash } from '../shared/flash'
import TimeAgo from '../shared/time-ago'
import { itemPageUrl } from './tab-urls'

const COLUMN_COUNT = 6

type ItemTableProps = {
  caption: string
  items: ItemRow[]
  isLoading: boolean
  emptyText: string
  onFlash(flash: Flash): void
  onSynced(id: string, sync: SyncBlock): void
}

// Renders only the table. The caller wraps it in a card, so the table has no
// container padding. Refetch refreshes the upstream details of one template.
export default function ItemTable({
  caption,
  items,
  isLoading,
  emptyText,
  onFlash,
  onSynced,
}: ItemTableProps) {
  const { t } = useTranslation()
  const [busyId, setBusyId] = useState<string | null>(null)
  const dimmed = isLoading && items.length > 0

  async function refetch(item: ItemRow) {
    setBusyId(item.id)
    try {
      const result = await hydrateItem(item.id)
      onSynced(item.id, result.sync)
      if (result.status === 'ok') {
        onFlash({
          type: 'success',
          content: t('template_gallery_admin_details_refetched'),
        })
      } else {
        onFlash({
          type: 'error',
          content: detailsRefetchFailureMessage(t, result),
        })
      }
    } catch (err) {
      onFlash({ type: 'error', content: errorMessage(t, err) })
    } finally {
      setBusyId(null)
    }
  }

  return (
    <OLTable
      container={false}
      hover
      className="mb-0 align-middle"
      style={{
        opacity: dimmed ? 0.6 : 1,
        pointerEvents: dimmed ? 'none' : undefined,
        tableLayout: 'fixed',
      }}
    >
      <caption className="visually-hidden">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">{t('template_gallery_admin_col_title')}</th>
          <th scope="col">{t('template_gallery_admin_col_details')}</th>
          <th scope="col" className="d-none d-lg-table-cell">
            {t('template_gallery_admin_col_last_synced')}
          </th>
          <th scope="col" className="d-none d-xl-table-cell">
            {t('template_gallery_admin_col_upstream')}
          </th>
          <th scope="col" className="d-none d-xl-table-cell">
            {t('template_gallery_admin_col_gallery')}
          </th>
          <th scope="col" className="text-end">
            {t('template_gallery_admin_col_actions')}
          </th>
        </tr>
      </thead>
      <tbody>
        {items.length === 0 ? (
          <tr>
            <td colSpan={COLUMN_COUNT} className="text-center text-muted py-4">
              {isLoading ? (
                <>
                  <OLSpinner />
                  <span className="visually-hidden">{t('loading')}</span>
                </>
              ) : (
                emptyText
              )}
            </td>
          </tr>
        ) : (
          items.map(item => (
            <tr key={item.id}>
              <td>
                <a
                  href={itemPageUrl(item.id)}
                  className="text-truncate d-block text-decoration-none"
                >
                  {item.title || item.slug}
                </a>
              </td>
              <td>
                <DetailStatusBadge
                  status={item.sync.detailStatus}
                  title={
                    item.sync.detailStatus === 'failed'
                      ? (item.sync.lastError ?? undefined)
                      : undefined
                  }
                />
              </td>
              <td className="d-none d-lg-table-cell text-nowrap">
                <TimeAgo value={item.sync.hydratedAt} />
              </td>
              <td className="d-none d-xl-table-cell">
                <a
                  href={item.upstreamUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-nowrap"
                >
                  overleaf.com
                  <MaterialIcon type="open_in_new" className="ms-1" />
                </a>
              </td>
              <td className="d-none d-xl-table-cell">
                <a href={item.galleryUrl} className="text-nowrap">
                  {t('view')}
                </a>
              </td>
              <td className="text-end">
                <OLButton
                  variant="secondary"
                  size="sm"
                  leadingIcon="refresh"
                  isLoading={busyId === item.id}
                  disabled={
                    item.sync.detailStatus === 'syncing' ||
                    (busyId !== null && busyId !== item.id)
                  }
                  onClick={() => refetch(item)}
                >
                  {t('template_gallery_admin_refetch')}
                </OLButton>
              </td>
            </tr>
          ))
        )}
      </tbody>
    </OLTable>
  )
}
