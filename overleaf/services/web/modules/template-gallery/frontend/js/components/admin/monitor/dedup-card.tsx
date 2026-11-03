import { ChangeEvent, useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Notification from '@/shared/components/notification'
import OLBadge from '@/shared/components/ol/ol-badge'
import OLButton from '@/shared/components/ol/ol-button'
import OLFormCheckbox from '@/shared/components/ol/ol-form-checkbox'
import OLSpinner from '@/shared/components/ol/ol-spinner'
import {
  fetchDedupStatus,
  fetchDuplicates,
  restoreDuplicate,
  runDedup,
  type DedupStatus,
  type DuplicateRow,
} from '../../../api/storage'
import {
  errorMessage,
  toTemplateAdminApiError,
  type TemplateAdminApiError,
} from '../../../api/errors'
import { useAsyncAction } from '../../../hooks/use-async-action'
import { usePoll } from '../../../hooks/use-poll'
import { formatBytes, formatCount, formatDateTime } from '../../../utils/format'
import type { Flash } from '../../shared/flash'
import { ConfirmActionModal } from '../../shared/confirm-action-modal'
import SectionCard from '../../shared/section-card'

const POLL_MS = 30000
const RUNNING_POLL_MS = 3000

// Order and label of the storage areas (storage/StorageUsage.mjs)
const AREA_KEYS: Record<string, string> = {
  blobs: 'template_gallery_admin_dedup_area_blobs',
  strayBlobs: 'template_gallery_admin_dedup_area_stray',
  catalog: 'template_gallery_admin_dedup_area_catalog',
  tmp: 'template_gallery_admin_dedup_area_tmp',
  scratch: 'template_gallery_admin_dedup_area_scratch',
  quarantine: 'template_gallery_admin_dedup_area_quarantine',
  probes: 'template_gallery_admin_dedup_area_probes',
  other: 'template_gallery_admin_dedup_area_other',
}

type DedupCardProps = {
  onFlash(flash: Flash): void
}

// Storage volume by area, duplicate templates, and the preview / clean actions of the dedup collector
export default function DedupCard({ onFlash }: DedupCardProps) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<DedupStatus | null>(null)
  const [loadError, setLoadError] = useState<TemplateAdminApiError | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [purge, setPurge] = useState(false)
  const [duplicates, setDuplicates] = useState<DuplicateRow[] | null>(null)
  const [duplicatesError, setDuplicatesError] =
    useState<TemplateAdminApiError | null>(null)
  const action = useAsyncAction()
  const running = status?.running != null
  const tombstones = status?.tombstones

  const load = useCallback(async () => {
    try {
      setStatus(await fetchDedupStatus())
      setLoadError(null)
    } catch (err) {
      setLoadError(toTemplateAdminApiError(err))
    }
  }, [])

  const loadDuplicates = useCallback(async () => {
    try {
      setDuplicates((await fetchDuplicates()).duplicates)
      setDuplicatesError(null)
    } catch (err) {
      setDuplicatesError(toTemplateAdminApiError(err))
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // The list changes when a clean run finishes, so it reloads with the count
  useEffect(() => {
    loadDuplicates()
  }, [loadDuplicates, tombstones])

  usePoll(load, running ? RUNNING_POLL_MS : POLL_MS, true)

  async function queue(dryRun: boolean) {
    const res = await action.run(() => runDedup({ dryRun, purge: !dryRun && purge }))
    if (res) {
      setConfirming(false)
      setPurge(false)
      onFlash({
        type: 'success',
        content: t('template_gallery_admin_dedup_queued'),
      })
      load()
    }
  }

  async function restore(row: DuplicateRow) {
    const res = await action.run(() => restoreDuplicate(row.token))
    if (res) {
      onFlash({
        type: 'success',
        content: t('template_gallery_admin_dedup_restored'),
      })
      // The tombstone count drops, which reloads the list through the effect
      load()
    }
  }

  const report = status?.report ?? null
  const busy = action.busy || running

  return (
    <SectionCard
      className="h-100"
      title={t('template_gallery_admin_dedup_title')}
    >
      {loadError && (
        <Notification
          type="error"
          content={errorMessage(t, loadError)}
          className="mb-3"
        />
      )}
      {action.error && (
        <Notification
          type="error"
          content={errorMessage(t, action.error)}
          className="mb-3"
        />
      )}
      {duplicatesError && (
        <Notification
          type="error"
          content={errorMessage(t, duplicatesError)}
          className="mb-3"
        />
      )}
      {report?.skipped && (
        <Notification
          type="warning"
          content={t('template_gallery_admin_dedup_last_skipped', {
            reason: report.skipped,
          })}
          className="mb-3"
        />
      )}

      {status === null ? null : (
        <>
          <dl className="row mb-3">
            <dt className="col-sm-5 text-muted">
              {t('template_gallery_admin_dedup_files')}
            </dt>
            <dd className="col-sm-7">
              {status.storage ? formatCount(status.storage.files) : '—'}
            </dd>
            <dt className="col-sm-5 text-muted">
              {t('template_gallery_admin_dedup_bytes')}
            </dt>
            <dd className="col-sm-7">
              {status.storage ? formatBytes(status.storage.usedBytes) : '—'}
            </dd>
            <dt className="col-sm-5 text-muted">
              {t('template_gallery_admin_dedup_groups')}
            </dt>
            <dd className="col-sm-7">
              {report?.duplicates
                ? formatCount(report.duplicates.groups)
                : '—'}
            </dd>
            <dt className="col-sm-5 text-muted">
              {t('template_gallery_admin_dedup_removed')}
            </dt>
            <dd className="col-sm-7">{formatCount(status.tombstones)}</dd>
            <dt className="col-sm-5 text-muted">
              {t('template_gallery_admin_dedup_freed')}
            </dt>
            <dd className="col-sm-7">
              {report?.freed
                ? t('template_gallery_admin_dedup_freed_value', {
                    files: formatCount(report.freed.files),
                    bytes: formatBytes(report.freed.bytes),
                  })
                : '—'}
            </dd>
            <dt className="col-sm-5 text-muted">
              {t('template_gallery_admin_dedup_last_run')}
            </dt>
            <dd className="col-sm-7 mb-0">
              {status.lastRunAt
                ? formatDateTime(status.lastRunAt, t)
                : t('template_gallery_admin_dedup_never')}
              {report?.dryRun && (
                <OLBadge bg="info" className="ms-2">
                  {t('template_gallery_admin_dedup_preview_badge')}
                </OLBadge>
              )}
            </dd>
          </dl>

          {status.storage && (
            <table className="table table-sm mb-3">
              <tbody>
                {Object.entries(AREA_KEYS).map(([area, labelKey]) => {
                  const counts = status.storage?.areas?.[area]
                  return (
                    <tr key={area}>
                      <td>{t(labelKey)}</td>
                      <td className="text-end">
                        {counts ? formatCount(counts.files) : '0'}
                      </td>
                      <td className="text-end">
                        {counts ? formatBytes(counts.bytes) : formatBytes(0)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}

          <div className="d-flex flex-wrap gap-2">
            <OLButton
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => queue(true)}
            >
              {t('template_gallery_admin_dedup_preview')}
            </OLButton>
            <OLButton
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              {t('template_gallery_admin_dedup_clean')}
            </OLButton>
            {running && (
              <OLBadge bg="info" className="align-self-center">
                {t('template_gallery_admin_dedup_running')}
              </OLBadge>
            )}
          </div>

          <h3 className="h6 mt-4">
            {t('template_gallery_admin_dedup_list_title')}
          </h3>
          {duplicates === null && duplicatesError === null && (
            <OLSpinner size="sm" />
          )}
          {duplicates?.length === 0 && (
            <p className="text-muted mb-0">
              {t('template_gallery_admin_dedup_list_empty')}
            </p>
          )}
          {duplicates && duplicates.length > 0 && (
            <table className="table table-sm mb-0">
              <thead>
                <tr>
                  <th scope="col">{t('template_gallery_admin_col_title')}</th>
                  <th scope="col">
                    {t('template_gallery_admin_dedup_list_kept')}
                  </th>
                  <th scope="col">
                    {t('template_gallery_admin_dedup_list_removed')}
                  </th>
                  <th scope="col">
                    <span className="visually-hidden">
                      {t('template_gallery_admin_col_actions')}
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {duplicates.map(row => (
                  <tr key={row.token}>
                    <td>
                      {row.title || row.slug || row.token}
                      {row.family && (
                        <div className="small text-muted">{row.family}</div>
                      )}
                    </td>
                    <td className="text-break">{row.canonical}</td>
                    <td>{formatDateTime(row.duplicateAt, t)}</td>
                    <td className="text-end">
                      <OLButton
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        onClick={() => restore(row)}
                      >
                        {t('restore')}
                      </OLButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      <ConfirmActionModal
        show={confirming}
        title={t('template_gallery_admin_dedup_confirm_title')}
        body={
          <>
            <p>{t('template_gallery_admin_dedup_confirm_body')}</p>
            <OLFormCheckbox
              id="dedup-purge"
              label={t('template_gallery_admin_dedup_purge')}
              checked={purge}
              disabled={action.busy}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                setPurge(event.target.checked)
              }
            />
          </>
        }
        confirmLabel={t('template_gallery_admin_dedup_clean')}
        variant="danger"
        busy={action.busy}
        error={action.error}
        onConfirm={() => queue(false)}
        onHide={() => setConfirming(false)}
      />
    </SectionCard>
  )
}
