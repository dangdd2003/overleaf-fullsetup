import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import OLButton from '@/shared/components/ol/ol-button'
import OLTable from '@/shared/components/ol/ol-table'
import OLFormCheckbox from '@/shared/components/ol/ol-form-checkbox'
import OLSpinner from '@/shared/components/ol/ol-spinner'
import MaterialIcon from '@/shared/components/material-icon'
import { getJSON, postJSON } from '@/infrastructure/fetch-json'
import LinkingStatus from './status'

export type ImportFolderStatus = 'queued' | 'importing' | 'synced' | 'failed'

export interface ImportJob {
  id: string
  status: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed'
  total: number
  importedCount: number
  failedCount: number
  error?: string | null
  folders: Array<{
    folderId: string
    name: string
    status: ImportFolderStatus
    projectId: string | null
    error: string | null
  }>
}

export interface DriveFolder {
  folderId: string
  name: string
  linked: boolean
  projectId: string | null
  lastSyncedAt: string | null
}

const POLL_INTERVAL_MS = 3000

export function isImportActive(job: ImportJob | null) {
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
 * Tracks the user's background "scan and import folders from Google Drive" job.
 */
export function useGoogleDriveImport(
  isLinked: boolean,
  onFinished: (job: ImportJob) => void
) {
  const [job, setJob] = useState<ImportJob | null>(null)
  const watchedJobId = useRef<string | null>(null)
  const onFinishedRef = useRef(onFinished)
  onFinishedRef.current = onFinished

  const applyJob = useCallback((next: ImportJob | null) => {
    setJob(next)
    if (isImportActive(next)) {
      watchedJobId.current = next!.id
    } else if (next && watchedJobId.current === next.id) {
      watchedJobId.current = null
      onFinishedRef.current(next)
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const data = await getJSON<{ job: ImportJob | null }>(
        '/auth/google-drive/import-job'
      )
      applyJob(data.job)
    } catch {
      // Retried on next poll
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

  const active = isImportActive(job)
  useEffect(() => {
    if (!active) {
      return undefined
    }
    const timer = setInterval(refresh, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [active, refresh])

  return { job, active, applyJob, refresh }
}

type GoogleDriveImportPanelProps = {
  job: ImportJob | null
  onJobChange: (job: ImportJob | null) => void
  onClose: () => void
}

export function GoogleDriveImportPanel({
  job,
  onJobChange,
  onClose,
}: GoogleDriveImportPanelProps) {
  const { t } = useTranslation()
  const [folders, setFolders] = useState<DriveFolder[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  const active = isImportActive(job)

  const loadFolders = useCallback(async () => {
    try {
      // Fast query: fetches top-level folder names only
      const data = await getJSON<{ folders: DriveFolder[] }>(
        '/auth/google-drive/import-folders'
      )
      setFolders(data.folders)
      // Pre-select all folders that are not yet imported
      const initialSelected = new Set(
        (data.folders || []).filter(f => !f.linked).map(f => f.folderId)
      )
      setSelected(initialSelected)
    } catch (err: any) {
      setFolders([])
      setError(
        err?.data?.message ||
          t(
            'google_drive_scan_folders_failed',
            'Failed to scan Google Drive folders'
          )
      )
    }
  }, [t])

  useEffect(() => {
    loadFolders()
  }, [loadFolders])

  // Refresh folder list once a run completes
  const previouslyActive = useRef(active)
  useEffect(() => {
    if (previouslyActive.current && !active) {
      loadFolders()
    }
    previouslyActive.current = active
  }, [active, loadFolders])

  const jobStatusById = new Map(
    active || job?.status === 'completed'
      ? (job?.folders || []).map(f => [f.folderId, f])
      : []
  )

  const allSelected =
    folders !== null && folders.length > 0 && selected.size === folders.length
  const someSelected = selected.size > 0 && !allSelected

  const selectAllRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someSelected
    }
  }, [someSelected, folders])

  const toggleAll = useCallback(() => {
    setSelected(
      allSelected
        ? new Set()
        : new Set((folders || []).map(f => f.folderId))
    )
  }, [allSelected, folders])

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

  const handleImportNow = useCallback(async () => {
    setStarting(true)
    setError('')
    try {
      const data = await postJSON<{ job: ImportJob }>(
        '/auth/google-drive/import-job',
        { body: { folderIds: [...selected] } }
      )
      onJobChange(data.job)
    } catch (err: any) {
      setError(
        err?.data?.message ||
          t(
            'google_drive_import_failed',
            'Failed to start importing projects from Google Drive'
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
        const data = await postJSON<{ job: ImportJob | null }>(
          '/auth/google-drive/import-job/cancel'
        )
        onJobChange(data.job)
      } catch (err: any) {
        setError(
          err?.data?.message ||
            t(
              'google_drive_import_cancel_failed',
              'Failed to cancel the Google Drive import'
            )
        )
        setCancelling(false)
        return
      }
      setCancelling(false)
    }
    onClose()
  }, [active, onJobChange, onClose, t])

  const renderStatus = (folder: DriveFolder) => {
    const entry = jobStatusById.get(folder.folderId)
    switch (entry?.status) {
      case 'queued':
        return <span className="text-muted">{t('queued', 'Queued')}</span>
      case 'importing':
        return (
          <span className="google-drive-bulk-sync-status">
            <OLSpinner size="sm" />
            {t('importing', 'Importing...')}
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
    if (folder.linked) {
      return (
        <span className="text-muted">
          {t('already_linked', 'Already linked')}
          {folder.lastSyncedAt ? ` (${formatDate(folder.lastSyncedAt)})` : ''}
        </span>
      )
    }
    return (
      <span className="text-primary">
        {t('new_in_drive', 'New in Google Drive')}
      </span>
    )
  }

  return (
    <div
      className="google-drive-bulk-sync"
      data-testid="google-drive-import-panel"
    >
      {error ? (
        <div className="mb-2">
          <LinkingStatus status="error" description={error} />
        </div>
      ) : null}

      {folders === null ? (
        <div className="d-flex align-items-center gap-2 py-3">
          <OLSpinner size="sm" />
          <span>{t('scanning_drive_folders', 'Scanning Google Drive folders…')}</span>
        </div>
      ) : folders.length === 0 ? (
        <p className="small text-muted py-2 mb-0">
          {t(
            'google_drive_no_folders_found',
            'No project folders found in your Google Drive Overleaf directory.'
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
                    aria-label={t('select_all_drive_folders', 'Select all folders')}
                    data-testid="google-drive-import-select-all"
                  />
                </th>
                <th>{t('folder_project_name', 'Folder / Project Name')}</th>
                <th className="cell-status">{t('status', 'Status')}</th>
              </tr>
            </thead>
            <tbody>
              {folders.map(folder => (
                <tr key={folder.folderId}>
                  <td className="cell-checkbox">
                    <OLFormCheckbox
                      autoComplete="off"
                      checked={selected.has(folder.folderId)}
                      onChange={() => toggleOne(folder.folderId)}
                      disabled={active}
                      aria-label={folder.name}
                    />
                  </td>
                  <td className="cell-name">{folder.name}</td>
                  <td className="cell-status">{renderStatus(folder)}</td>
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
          data-testid="google-drive-import-cancel"
        >
          {t('cancel', 'Cancel')}
        </OLButton>
        <OLButton
          variant="primary"
          size="sm"
          onClick={handleImportNow}
          disabled={active || selected.size === 0}
          isLoading={starting}
          loadingLabel={t('importing', 'Importing...')}
          data-testid="google-drive-import-now"
        >
          {t('import_now', 'Import now')}
        </OLButton>
      </div>
    </div>
  )
}
