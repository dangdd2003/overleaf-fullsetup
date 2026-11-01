import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import OLButton from '@/shared/components/ol/ol-button'
import Notification from '@/shared/components/notification'
import { ConfirmActionModal } from '../shared/confirm-action-modal'
import { hydrateItem } from '../../api/client'
import {
  toTemplateAdminApiError,
  type TemplateAdminApiError,
} from '../../api/errors'
import SectionCard from '../shared/section-card'
import type { ItemDetail, SyncBlock, SyncDetailStatus } from '../../api/types'
import { DetailStatusBadge } from '../shared/sync-status'
import { DetailRow, RelativeDate } from './sync-view'

type MirrorCardProps = {
  item: ItemDetail
  onSynced(sync: SyncBlock): void
}

// A line under the badge explaining what happens next
const STATE_HINT_KEYS: Partial<Record<SyncDetailStatus, string>> = {
  syncing: 'template_gallery_admin_item_syncing',
  queued: 'template_gallery_admin_item_queued',
}

type Notice = {
  type: 'success' | 'error'
  content: string
}

// Refetches the upstream details of one template from overleaf.com
export default function MirrorCard({ item, onSynced }: MirrorCardProps) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<TemplateAdminApiError | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const sync = item.sync

  async function handleRefetch() {
    setBusy(true)
    setError(null)
    try {
      const result = await hydrateItem(item.id)
      onSynced(result.sync)
      setConfirming(false)
      setNotice(
        result.status === 'ok'
          ? {
              type: 'success',
              content: t('template_gallery_admin_details_refetched'),
            }
          : {
              type: 'error',
              content: t('template_gallery_admin_error_hydration_failed'),
            }
      )
    } catch (err) {
      setError(toTemplateAdminApiError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SectionCard
      className="mb-4"
      title={t('template_gallery_admin_item_sync_status')}
    >
      {notice && (
        <Notification
          type={notice.type}
          content={notice.content}
          className="mb-3"
        />
      )}

      <dl className="row mb-4">
        <DetailRow label={t('status')}>
          <DetailStatusBadge status={sync.detailStatus} />
          {STATE_HINT_KEYS[sync.detailStatus] && (
            <div className="text-muted mt-1">
              {t(STATE_HINT_KEYS[sync.detailStatus]!)}
            </div>
          )}
        </DetailRow>
        <DetailRow label={t('template_gallery_admin_col_last_synced')}>
          <RelativeDate value={sync.hydratedAt} />
        </DetailRow>
        {sync.detailStatus === 'failed' && sync.lastError && (
          <DetailRow label={t('template_gallery_admin_item_last_error')}>
            {sync.lastError}
          </DetailRow>
        )}
      </dl>

      <OLButton
        variant="secondary"
        leadingIcon="refresh"
        disabled={busy || sync.detailStatus === 'syncing'}
        onClick={() => setConfirming(true)}
      >
        {t('template_gallery_admin_refetch_details')}
      </OLButton>

      <ConfirmActionModal
        show={confirming}
        title={t('template_gallery_admin_refetch_details')}
        body={t('template_gallery_admin_refetch_details_body')}
        confirmLabel={t('template_gallery_admin_refetch_details')}
        variant="primary"
        busy={busy}
        error={error}
        onConfirm={handleRefetch}
        onHide={() => {
          setConfirming(false)
          setError(null)
        }}
      />
    </SectionCard>
  )
}
