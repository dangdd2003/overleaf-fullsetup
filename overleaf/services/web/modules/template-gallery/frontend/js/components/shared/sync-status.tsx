import { useTranslation } from 'react-i18next'
import OLBadge from '@/shared/components/ol/ol-badge'
import type { SyncDetailStatus } from '../../api/types'

// Keys are looked up with t() at render time, so each value must exist in en.json
export const DETAIL_STATUS_KEYS: Record<SyncDetailStatus, string> = {
  ok: 'template_gallery_admin_status_ok',
  syncing: 'template_gallery_admin_status_syncing',
  queued: 'template_gallery_admin_status_queued',
  failed: 'template_gallery_admin_status_failed',
  removed: 'template_gallery_admin_status_removed',
}

type BadgeTone = 'primary' | 'info' | 'warning' | 'danger' | 'neutral'

const TONE_PROPS: Record<
  BadgeTone,
  { bg: string; text?: string; className?: string }
> = {
  primary: { bg: 'primary' },
  info: { bg: 'info' },
  warning: { bg: 'warning' },
  danger: { bg: 'danger' },
  neutral: { bg: 'transparent', text: 'body', className: 'border' },
}

const DETAIL_TONE: Record<SyncDetailStatus, BadgeTone> = {
  ok: 'primary',
  syncing: 'info',
  queued: 'neutral',
  failed: 'danger',
  removed: 'warning',
}

// `title` shows on hover, e.g. the last error of a failed item
export function DetailStatusBadge({
  status,
  title,
}: {
  status: SyncDetailStatus
  title?: string
}) {
  const { t } = useTranslation()
  return (
    <span title={title}>
      <OLBadge {...TONE_PROPS[DETAIL_TONE[status]]}>
        {t(DETAIL_STATUS_KEYS[status])}
      </OLBadge>
    </span>
  )
}
