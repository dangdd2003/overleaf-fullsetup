import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import OLBadge from '@/shared/components/ol/ol-badge'
import { formatDate, fromNowDate } from '@/utils/dates'
import type { SyncBlock } from '../../api/types'

export type SourceStatus = SyncBlock['sourceStatus']

const SOURCE_STATUS_BG = {
  ok: 'primary',
  pending: 'light',
  failed: 'danger',
  backoff: 'warning',
} as const

const SOURCE_STATUS_LABEL_KEY = {
  ok: 'template_gallery_admin_source_fetched',
  pending: 'template_gallery_admin_source_not_fetched',
  failed: 'template_gallery_admin_status_failed',
  backoff: 'template_gallery_admin_status_backoff',
} as const

const MISSING = <span className="text-muted">—</span>

export function SourceStatusBadge({ status }: { status: SourceStatus }) {
  const { t } = useTranslation()
  return (
    <OLBadge
      bg={SOURCE_STATUS_BG[status]}
      text={status === 'pending' ? 'dark' : undefined}
      className={status === 'pending' ? 'border' : undefined}
    >
      {t(SOURCE_STATUS_LABEL_KEY[status])}
    </OLBadge>
  )
}

export function RelativeDate({ value }: { value: string | null }) {
  if (!value) return MISSING
  return <span title={formatDate(value)}>{fromNowDate(value)}</span>
}

// One label and value pair inside a `<dl className="row">`
export function DetailRow({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <>
      <dt className="col-sm-5 text-muted">{label}</dt>
      <dd className="col-sm-7">{children}</dd>
    </>
  )
}

export { MISSING }
