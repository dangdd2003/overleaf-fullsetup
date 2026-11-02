import { ChangeEvent, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Notification from '@/shared/components/notification'
import OLBadge from '@/shared/components/ol/ol-badge'
import OLButton from '@/shared/components/ol/ol-button'
import OLFormCheckbox from '@/shared/components/ol/ol-form-checkbox'
import { crawlerStop, crawlerSync } from '../../../api/client'
import { errorMessage } from '../../../api/errors'
import type {
  SyncOverview,
  SyncPhase,
  SyncPhaseName,
  SyncRun,
} from '../../../api/types'
import { useAsyncAction } from '../../../hooks/use-async-action'
import { formatCount } from '../../../utils/format'
import type { Flash } from '../../shared/flash'
import SectionCard from '../../shared/section-card'
import TimeAgo from '../../shared/time-ago'

const PHASE_LABEL_KEYS: Record<SyncPhaseName, string> = {
  catalogue: 'template_gallery_admin_sync_phase_catalogue',
  new: 'template_gallery_admin_sync_phase_new',
  rescan: 'template_gallery_admin_sync_phase_rescan',
  details: 'template_gallery_admin_sync_phase_details',
  tags: 'template_gallery_admin_sync_phase_tags',
}

const PHASE_STATE_KEYS: Record<SyncPhase['state'], string> = {
  pending: 'template_gallery_admin_sync_phase_state_pending',
  running: 'template_gallery_admin_sync_phase_state_running',
  done: 'template_gallery_admin_sync_phase_state_done',
  failed: 'template_gallery_admin_sync_phase_state_failed',
  skipped: 'template_gallery_admin_sync_phase_state_skipped',
}

const LAST_RUN_KEYS: Record<Exclude<SyncRun['state'], 'running'>, string> = {
  done: 'template_gallery_admin_sync_last_done',
  cancelled: 'template_gallery_admin_sync_last_cancelled',
  failed: 'template_gallery_admin_sync_last_failed',
}

type CrawlerCardProps = {
  overview: SyncOverview
  run: SyncRun | null
  onChanged(): void
  onFlash(flash: Flash): void
}

// Starts and stops sync runs, and shows the phases of the running one
export default function CrawlerCard({
  overview,
  run,
  onChanged,
  onFlash,
}: CrawlerCardProps) {
  const { t } = useTranslation()
  const id = useId()
  const action = useAsyncAction()
  const [rescan, setRescan] = useState(false)
  const running = run?.state === 'running'

  async function startSync() {
    const result = await action.run(() => crawlerSync(rescan))
    if (result) {
      setRescan(false)
      onFlash({
        type: 'success',
        content: t('template_gallery_admin_monitor_sync_queued'),
      })
      onChanged()
    }
  }

  async function stopSync() {
    const result = await action.run(crawlerStop)
    if (result) onChanged()
  }

  return (
    <SectionCard
      className="h-100"
      title={t('template_gallery_admin_monitor_crawler')}
      actions={
        running ? (
          <OLBadge bg="primary">
            {t('template_gallery_admin_monitor_crawler_running')}
          </OLBadge>
        ) : (
          <OLBadge bg="transparent" text="body" className="border">
            {t('template_gallery_admin_monitor_crawler_idle')}
          </OLBadge>
        )
      }
    >
      {action.error && (
        <Notification
          type="error"
          content={errorMessage(t, action.error)}
          className="mb-3"
        />
      )}

      {running && run ? (
        <>
          <ul className="list-unstyled mb-3">
            {run.phases
              .filter(phase => phase.state !== 'skipped')
              .map(phase => (
                <PhaseRow key={phase.name} phase={phase} />
              ))}
          </ul>
          {run.waitingUntil && (
            <Notification
              type="warning"
              className="mb-3"
              content={
                <>
                  <div className="text-break">
                    {run.waitError ||
                      (run.waitReason === 'unavailable'
                        ? t('template_gallery_admin_sync_waiting_unavailable')
                        : t('template_gallery_admin_sync_waiting'))}
                  </div>
                  <div className="small">
                    {t('template_gallery_admin_sync_retrying')}{' '}
                    <TimeAgo value={run.waitingUntil} />
                  </div>
                </>
              }
            />
          )}
          <OLButton
            variant="secondary"
            size="sm"
            disabled={action.busy || run.stopping}
            onClick={stopSync}
          >
            {run.stopping
              ? t('template_gallery_admin_sync_stopping')
              : t('template_gallery_admin_sync_stop')}
          </OLButton>
        </>
      ) : (
        <>
          {run && run.state !== 'running' && (run.error || run.phases.some(p => p.error)) && (
            <Notification
              type="error"
              className="mb-3"
              content={
                <ul className="list-unstyled mb-0 text-break">
                  {run.error && <li>{run.error}</li>}
                  {run.phases
                    .filter(phase => phase.error)
                    .map(phase => (
                      <li key={phase.name}>
                        {t(PHASE_LABEL_KEYS[phase.name])}: {phase.error}
                      </li>
                    ))}
                </ul>
              }
            />
          )}
          <dl className="row mb-2">
            {run?.finishedAt && run.state !== 'running' && (
              <>
                <dt className="col-sm-5 text-muted">
                  {t(LAST_RUN_KEYS[run.state])}
                </dt>
                <dd className="col-sm-7">
                  <TimeAgo value={run.finishedAt} />
                </dd>
              </>
            )}
            <dt className="col-sm-5 text-muted">
              {t('template_gallery_admin_monitor_last_run')}
            </dt>
            <dd className="col-sm-7">
              <TimeAgo value={overview.listUpdatedAt} />
            </dd>
            <dt className="col-sm-5 text-muted">
              {t('template_gallery_admin_sync_auto_label')}
            </dt>
            <dd className="col-sm-7">
              {overview.autoSync ? (
                <>
                  {t('template_gallery_admin_sync_auto_next')}{' '}
                  <TimeAgo value={overview.nextAutoRunAt} />
                </>
              ) : (
                t('template_gallery_admin_sync_auto_off')
              )}
            </dd>
          </dl>
          <OLFormCheckbox
            id={`${id}-rescan`}
            label={t('template_gallery_admin_sync_rescan_option')}
            checked={rescan}
            disabled={action.busy}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              setRescan(event.target.checked)
            }
          />
          <OLButton
            variant="primary"
            size="sm"
            className="mt-3"
            disabled={action.busy}
            onClick={startSync}
          >
            {t('template_gallery_admin_sync_now')}
          </OLButton>
        </>
      )}
    </SectionCard>
  )
}

// One phase of the running sync: its state, and a progress bar when its
// total is known
function PhaseRow({ phase }: { phase: SyncPhase }) {
  const { t } = useTranslation()
  const label = t(PHASE_LABEL_KEYS[phase.name])
  const total = phase.total ?? 0
  const showProgress = phase.state === 'running' && phase.total !== null
  const percent =
    total > 0 ? Math.min(100, Math.floor((phase.done / total) * 100)) : 0

  return (
    <li className="mb-2">
      <div className="d-flex justify-content-between gap-2">
        <span>{label}</span>
        <span className="text-muted">
          {showProgress
            ? t('template_gallery_admin_pass_progress', {
                done: formatCount(phase.done),
                total: formatCount(total),
              })
            : t(PHASE_STATE_KEYS[phase.state])}
        </span>
      </div>
      {showProgress && (
        <div
          className="progress mt-1"
          role="progressbar"
          aria-label={label}
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="progress-bar" style={{ width: `${percent}%` }} />
        </div>
      )}
      {phase.error && (
        <div className="text-danger small mt-1 text-break">{phase.error}</div>
      )}
      {phase.failed > 0 && (
        <div className="text-muted small mt-1 text-break">
          {t('template_gallery_admin_pass_failed_count', {
            count: phase.failed,
          })}
          {phase.lastError && <> — {phase.lastError}</>}
        </div>
      )}
    </li>
  )
}
