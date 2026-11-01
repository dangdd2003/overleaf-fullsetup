import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import OLButton from '@/shared/components/ol/ol-button'
import Notification from '@/shared/components/notification'
import { ConfirmActionModal } from '../shared/confirm-action-modal'
import { refetchSource } from '../../api/client'
import {
  toTemplateAdminApiError,
  type TemplateAdminApiError,
} from '../../api/errors'
import SectionCard from '../shared/section-card'
import type { ItemDetail, SyncBlock } from '../../api/types'
import { DetailRow, SourceStatusBadge } from './sync-view'

type SourceCardProps = {
  item: ItemDetail
  onSynced(sync: SyncBlock): void
}

type Notice = {
  type: 'success' | 'error' | 'warning'
  content: string
}

// Fetches the template source again with the same chain as "Open as template"
export default function SourceCard({ item, onSynced }: SourceCardProps) {
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
      const result = await refetchSource(item.id)
      onSynced(result.sync)
      setConfirming(false)
      if (result.status === 'ok') {
        setNotice({
          type: 'success',
          content: t('template_gallery_admin_source_refetched'),
        })
      } else if (result.status === 'backoff') {
        setNotice({
          type: 'warning',
          content: t('template_gallery_admin_source_backoff'),
        })
      } else {
        setNotice({
          type: 'error',
          content: t('template_gallery_admin_error_source_failed'),
        })
      }
    } catch (err) {
      setError(toTemplateAdminApiError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SectionCard
      className="mb-4"
      title={t('template_gallery_admin_col_source')}
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
          <SourceStatusBadge status={sync.sourceStatus} />
        </DetailRow>
      </dl>

      <OLButton
        variant="secondary"
        leadingIcon="refresh"
        disabled={busy}
        onClick={() => setConfirming(true)}
      >
        {t('template_gallery_admin_refetch_source')}
      </OLButton>

      <ConfirmActionModal
        show={confirming}
        title={t('template_gallery_admin_refetch_source')}
        body={t('template_gallery_admin_refetch_source_body')}
        confirmLabel={t('template_gallery_admin_refetch_source')}
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
