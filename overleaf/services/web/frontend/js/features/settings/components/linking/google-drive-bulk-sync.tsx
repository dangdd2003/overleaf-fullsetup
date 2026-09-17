import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import OLButton from '@/shared/components/ol/ol-button'
import OLTable from '@/shared/components/ol/ol-table'
import OLFormCheckbox from '@/shared/components/ol/ol-form-checkbox'
import OLSpinner from '@/shared/components/ol/ol-spinner'
import MaterialIcon from '@/shared/components/material-icon'
import { getJSON, postJSON } from '@/infrastructure/fetch-json'
import LinkingStatus from './status'

export type BulkSyncProjectStatus = 'queued' | 'syncing' | 'synced' | 'failed'

export interface BulkSyncJob {
  id: string
  status: 'queued' | 'running' | 'completed' | 'cancelled'
  total: number
  syncedCount: number
  failedCount: number
  projects: Array<{
    projectId: string
    name: string
    status: BulkSyncProjectStatus
    error: string | null
  }>
}

export interface SyncableProject {
  id: string
  name: string
  lastUpdated: string | null
  linked: boolean
  lastSyncedAt: string | null
}

const POLL_INTERVAL_MS = 3000

export function isBulkSyncActive(job: BulkSyncJob | null) {
  return job?.status === 'queued' || job?.status === 'running'
}

function formatDate(dateInput?: string | null): string {
  if (!dateInput) return ''
  const date = new Date(dateInput)
  if (isNaN(date.getTime())) return ''
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

/**
 * Tracks the user's background "sync projects to Google Drive" job.
 *
 * The job runs on the server, so this only observes it: on mount it picks up a
 * job started earlier (from another tab, or before the page was closed) and
 * polls while one is running. `onFinished` fires only for jobs this page saw
 * running, so an old result isn't announced on every visit.
 */
export function useGoogleDriveBulkSync(
  isLinked: boolean,
  onFinished: (job: BulkSyncJob) => void
) {
  const [job, setJob] = useState<BulkSyncJob | null>(null)
  const watchedJobId = useRef<string | null>(null)
  const onFinishedRef = useRef(onFinished)
  onFinishedRef.current = onFinished

  const applyJob = useCallback((next: BulkSyncJob | null) => {
    setJob(next)
    if (isBulkSyncActive(next)) {
      watchedJobId.current = next!.id
    } else if (next && watchedJobId.current === next.id) {
      watchedJobId.current = null
      onFinishedRef.current(next)
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const data = await getJSON<{ job: BulkSyncJob | null }>(
        '/auth/google-drive/bulk-sync'
      )
      applyJob(data.job)
    } catch {
      // Keep the last known state; the next poll tries again
    }
  }, [applyJob])

  useEffect(() => {
    if (isLinked) {
      refresh()
    } else {
      setJob(null)
      watchedJobId.current = null
    }
  }, [isLinked, refresh])

  const active = isBulkSyncActive(job)
  useEffect(() => {
    if (!active) {
      return undefined
    }
    const timer = setInterval(refresh, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [active, refresh])

  return { job, active, applyJob, refresh }
}

type GoogleDriveBulkSyncPanelProps = {
  job: BulkSyncJob | null
  onJobChange: (job: BulkSyncJob | null) => void
  onClose: () => void
}

export function GoogleDriveBulkSyncPanel({
  job,
  onJobChange,
  onClose,
}: GoogleDriveBulkSyncPanelProps) {
  const { t } = useTranslation()
  const [projects, setProjects] = useState<SyncableProject[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  const active = isBulkSyncActive(job)

  const loadProjects = useCallback(async () => {
    try {
      const data = await getJSON<{ projects: SyncableProject[] }>(
        '/auth/google-drive/projects'
      )
      setProjects(data.projects)
    } catch (err: any) {
      setProjects([])
      setError(
        err?.data?.message ||
          t('google_drive_load_projects_failed', 'Failed to load your projects')
      )
    }
  }, [t])

  useEffect(() => {
    loadProjects()
  }, [loadProjects])

  // Refresh "last synced" dates once a run finishes
  const previouslyActive = useRef(active)
  useEffect(() => {
    if (previouslyActive.current && !active) {
      loadProjects()
    }
    previouslyActive.current = active
  }, [active, loadProjects])

  const jobStatusById = new Map(
    active || job?.status === 'completed'
      ? (job?.projects || []).map(p => [p.projectId, p])
      : []
  )

  const allSelected =
    projects !== null &&
    projects.length > 0 &&
    selected.size === projects.length
  const someSelected = selected.size > 0 && !allSelected

  const selectAllRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someSelected
    }
  }, [someSelected, projects])

  const toggleAll = useCallback(() => {
    setSelected(
      allSelected ? new Set() : new Set((projects || []).map(p => p.id))
    )
  }, [allSelected, projects])

  const toggleOne = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  const handleSyncNow = useCallback(async () => {
    setStarting(true)
    setError('')
    try {
      const data = await postJSON<{ job: BulkSyncJob }>(
        '/auth/google-drive/bulk-sync',
        { body: { projectIds: [...selected] } }
      )
      onJobChange(data.job)
    } catch (err: any) {
      setError(
        err?.data?.message ||
          t(
            'google_drive_bulk_sync_failed',
            'Failed to start syncing projects to Google Drive'
          )
      )
    } finally {
      setStarting(false)
    }
  }, [selected, onJobChange, t])

  const handleCancel = useCallback(async () => {
    if (active) {
      setCancelling(true)
      try {
        const data = await postJSON<{ job: BulkSyncJob | null }>(
          '/auth/google-drive/bulk-sync/cancel'
        )
        onJobChange(data.job)
      } catch (err: any) {
        setError(
          err?.data?.message ||
            t(
              'google_drive_bulk_sync_cancel_failed',
              'Failed to cancel the Google Drive sync'
            )
        )
        setCancelling(false)
        return
      }
      setCancelling(false)
    }
    onClose()
  }, [active, onJobChange, onClose, t])

  const renderStatus = (project: SyncableProject) => {
    const entry = jobStatusById.get(project.id)
    switch (entry?.status) {
      case 'queued':
        return <span className="text-muted">{t('queued', 'Queued')}</span>
      case 'syncing':
        return (
          <span className="google-drive-bulk-sync-status">
            <OLSpinner size="sm" />
            {t('syncing', 'Syncing...')}
          </span>
        )
      case 'synced':
        return (
          <span className="google-drive-bulk-sync-status text-success">
            <MaterialIcon type="check_circle" />
            {t('synced', 'Synced')}
          </span>
        )
      case 'failed':
        return (
          <span
            className="google-drive-bulk-sync-status text-danger"
            title={entry.error || undefined}
          >
            <MaterialIcon type="error" />
            {t('failed', 'Failed')}
          </span>
        )
    }
    if (project.lastSyncedAt) {
      return (
        <span className="text-muted">
          {t('last_synced', 'Last synced')} {formatDate(project.lastSyncedAt)}
        </span>
      )
    }
    return (
      <span className="text-muted">
        {t('google_drive_not_synced_yet', 'Not synced yet')}
      </span>
    )
  }

  return (
    <div
      className="google-drive-bulk-sync"
      data-testid="google-drive-bulk-sync-panel"
    >
      {error ? (
        <div className="mb-2">
          <LinkingStatus status="error" description={error} />
        </div>
      ) : null}

      {projects === null ? (
        <div className="d-flex align-items-center gap-2 py-3">
          <OLSpinner size="sm" />
          <span>{t('loading', 'Loading…')}</span>
        </div>
      ) : projects.length === 0 ? (
        <p className="small text-muted py-2 mb-0">
          {t(
            'google_drive_no_projects_to_sync',
            'You have no projects to sync.'
          )}
        </p>
      ) : (
        <div className="google-drive-bulk-sync-table-container">
          <OLTable
            className="google-drive-bulk-sync-table"
            container={false}
            hover
            size="sm"
          >
            <thead>
              <tr>
                <th className="cell-checkbox">
                  <OLFormCheckbox
                    autoComplete="off"
                    checked={allSelected}
                    inputRef={selectAllRef}
                    onChange={toggleAll}
                    disabled={active}
                    aria-label={t('select_all_projects', 'Select all projects')}
                    data-testid="google-drive-bulk-sync-select-all"
                  />
                </th>
                <th>{t('name', 'Name')}</th>
                <th className="cell-status">{t('status', 'Status')}</th>
              </tr>
            </thead>
            <tbody>
              {projects.map(project => (
                <tr key={project.id}>
                  <td className="cell-checkbox">
                    <OLFormCheckbox
                      autoComplete="off"
                      checked={selected.has(project.id)}
                      onChange={() => toggleOne(project.id)}
                      disabled={active}
                      aria-label={project.name}
                    />
                  </td>
                  <td className="cell-name">{project.name}</td>
                  <td className="cell-status">{renderStatus(project)}</td>
                </tr>
              ))}
            </tbody>
          </OLTable>
        </div>
      )}

      <div className="google-drive-bulk-sync-actions">
        <OLButton
          variant="secondary"
          size="sm"
          onClick={handleCancel}
          disabled={cancelling}
          isLoading={cancelling}
          loadingLabel={t('cancelling', 'Cancelling...')}
          data-testid="google-drive-bulk-sync-cancel"
        >
          {t('cancel', 'Cancel')}
        </OLButton>
        <OLButton
          variant="primary"
          size="sm"
          onClick={handleSyncNow}
          disabled={active || selected.size === 0}
          isLoading={starting}
          loadingLabel={t('syncing', 'Syncing...')}
          data-testid="google-drive-bulk-sync-now"
        >
          {t('sync_now', 'Sync now')}
        </OLButton>
      </div>
    </div>
  )
}
