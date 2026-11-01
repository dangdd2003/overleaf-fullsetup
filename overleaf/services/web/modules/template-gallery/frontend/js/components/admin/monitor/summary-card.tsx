import { useTranslation } from 'react-i18next'
import type { StatusSummary, SyncDetailStatus } from '../../../api/types'
import { formatCount } from '../../../utils/format'
import SectionCard from '../../shared/section-card'
import { DetailStatusBadge } from '../../shared/sync-status'

const STATES: {
  state: SyncDetailStatus
  count: keyof StatusSummary['counts']
}[] = [
  { state: 'ok', count: 'synced' },
  { state: 'syncing', count: 'syncing' },
  { state: 'queued', count: 'queued' },
  { state: 'failed', count: 'failed' },
  { state: 'removed', count: 'removed' },
]

type SummaryCardProps = {
  summary: StatusSummary
  onShowTemplates(state: SyncDetailStatus): void
}

// One row per sync state; each count opens the Templates tab filtered to it
export default function SummaryCard({
  summary,
  onShowTemplates,
}: SummaryCardProps) {
  const { t } = useTranslation()
  const { counts } = summary

  return (
    <SectionCard
      className="h-100"
      title={t('template_gallery_admin_monitor_mirror')}
      actions={
        <span className="text-muted">
          {t('template_gallery_admin_total_count', {
            total: formatCount(counts.total),
          })}
        </span>
      }
    >
      <dl className="row mb-0">
        {STATES.map(({ state, count }) => (
          <div key={state} className="row mb-2">
            <dt className="col-sm-6 fw-normal">
              <DetailStatusBadge status={state} />
            </dt>
            <dd className="col-sm-6 mb-0">
              {counts[count] > 0 ? (
                <button
                  type="button"
                  className="btn btn-link p-0 align-baseline"
                  onClick={() => onShowTemplates(state)}
                >
                  {formatCount(counts[count])}
                </button>
              ) : (
                <span className="text-muted">0</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </SectionCard>
  )
}
