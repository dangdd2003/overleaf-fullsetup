import { useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  OLModal,
  OLModalBody,
  OLModalFooter,
  OLModalHeader,
  OLModalTitle,
} from '@/shared/components/ol/ol-modal'
import OLButton from '@/shared/components/ol/ol-button'
import OLSpinner from '@/shared/components/ol/ol-spinner'
import MaterialIcon from '@/shared/components/material-icon'
import GoogleDriveLogo from '@/shared/svgs/google-drive-logo'
import { useProjectContext } from '@/shared/context/project-context'
import { useRailContext } from '@/features/ide-react/context/rail-context'
import getMeta from '@/utils/meta'

export interface GoogleDriveConflict {
  path: string
  conflictPath: string
  detectedAt?: string
}

export interface GoogleDriveStatus {
  linked?: boolean
  driveFolderId?: string | null
  folderName?: string | null
  folderUrl?: string | null
  syncStatus?: 'idle' | 'syncing' | 'error' | 'unlinked' | 'up_to_date' | string
  lastSyncedAt?: string | Date | null
  lastManualSyncAt?: string | Date | null
  lastError?: string | null
  isSyncing?: boolean
  fileCount?: number
  conflicts?: Array<GoogleDriveConflict> | Array<any> | boolean
  syncSuspended?: boolean
  suspendReason?: string
}

const MANUAL_SYNC_COOLDOWN_MS = 60000

function secondsRemaining(lastManualSyncAt?: string | Date | null): number {
  if (!lastManualSyncAt) return 0
  const lastSyncTime = new Date(lastManualSyncAt).getTime()
  if (isNaN(lastSyncTime)) return 0
  const elapsedMs = Date.now() - lastSyncTime
  return Math.max(0, Math.ceil((MANUAL_SYNC_COOLDOWN_MS - elapsedMs) / 1000))
}

export type GoogleDriveModalProps = {
  show: boolean
  onHide?: () => void
}

function formatDate(dateInput?: string | Date | null): string {
  if (!dateInput) return ''
  const date = new Date(dateInput)
  if (isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function GoogleDriveModal({
  show,
  onHide,
}: GoogleDriveModalProps) {
  const { t } = useTranslation()
  const { project, projectId: ctxProjectId } = useProjectContext()
  const { setActiveModal } = useRailContext()

  const [status, setStatus] = useState<GoogleDriveStatus | null>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const [syncing, setSyncing] = useState<boolean>(false)
  const [dismissing, setDismissing] = useState<boolean>(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [cooldownSecondsLeft, setCooldownSecondsLeft] = useState<number>(0)

  const projectId = project?._id || ctxProjectId || ''

  const handleClose = useCallback(() => {
    setActionError(null)
    if (onHide) {
      onHide()
    } else {
      setActiveModal(null)
    }
  }, [onHide, setActiveModal])

  const fetchStatus = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    setActionError(null)
    try {
      const res = await fetch(`/project/${projectId}/google-drive/status`)
      if (res.ok) {
        const data = await res.json()
        setStatus(data)
        setCooldownSecondsLeft(secondsRemaining(data?.lastManualSyncAt))
      } else {
        const errData = await res.json().catch(() => ({}))
        setActionError(
          errData.message ||
            t(
              'failed_to_fetch_status',
              'Failed to fetch Google Drive sync status'
            )
        )
      }
    } catch (err: any) {
      setActionError(
        err?.message ||
          t(
            'failed_to_fetch_status',
            'Failed to fetch Google Drive sync status'
          )
      )
    } finally {
      setLoading(false)
    }
  }, [projectId, t])

  useEffect(() => {
    if (show && projectId) {
      fetchStatus()
    } else {
      setActionError(null)
    }
  }, [show, projectId, fetchStatus])

  // Ticks the cooldown countdown down to zero once a second while it's active.
  useEffect(() => {
    if (cooldownSecondsLeft <= 0) return
    const intervalId = setInterval(() => {
      setCooldownSecondsLeft(prev => Math.max(0, prev - 1))
    }, 1000)
    return () => clearInterval(intervalId)
  }, [cooldownSecondsLeft])

  const handleSyncNow = useCallback(async () => {
    if (!projectId || syncing || cooldownSecondsLeft > 0) return
    setSyncing(true)
    setActionError(null)
    try {
      const csrfToken =
        (typeof window !== 'undefined' && (window as any).csrfToken) ||
        getMeta('ol-csrfToken') ||
        ''
      const res = await fetch(`/project/${projectId}/google-drive/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Csrf-Token': csrfToken,
        },
      })
      if (res.ok) {
        await fetchStatus()
      } else {
        const errData = await res.json().catch(() => ({}))
        if (res.status === 429 && errData.retryAfterSeconds) {
          setCooldownSecondsLeft(errData.retryAfterSeconds)
        }
        setActionError(
          errData.message ||
            t('sync_failed', 'Failed to sync project with Google Drive')
        )
      }
    } catch (err: any) {
      setActionError(
        err?.message ||
          t('sync_failed', 'Failed to sync project with Google Drive')
      )
    } finally {
      setSyncing(false)
    }
  }, [projectId, syncing, cooldownSecondsLeft, fetchStatus, t])

  const handleDismissConflicts = useCallback(async () => {
    if (!projectId || dismissing) return
    setDismissing(true)
    setActionError(null)
    try {
      const csrfToken =
        (typeof window !== 'undefined' && (window as any).csrfToken) ||
        getMeta('ol-csrfToken') ||
        ''
      const res = await fetch(
        `/project/${projectId}/google-drive/conflicts/dismiss`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Csrf-Token': csrfToken,
          },
        }
      )
      if (res.ok) {
        const data = await res.json()
        setStatus(data)
      } else {
        const errData = await res.json().catch(() => ({}))
        setActionError(
          errData.message ||
            t('dismiss_conflicts_failed', 'Failed to dismiss conflicts')
        )
      }
    } catch (err: any) {
      setActionError(
        err?.message ||
          t('dismiss_conflicts_failed', 'Failed to dismiss conflicts')
      )
    } finally {
      setDismissing(false)
    }
  }, [projectId, dismissing, t])

  const isUnlinked = !status?.linked || status?.syncStatus === 'unlinked'
  const isSyncInProgress =
    syncing || status?.isSyncing || status?.syncStatus === 'syncing'
  const isErrorState =
    Boolean(status?.lastError) ||
    status?.syncStatus === 'error' ||
    Boolean(actionError)
  const neverSynced =
    !isUnlinked && !isSyncInProgress && !isErrorState && !status?.lastSyncedAt
  const isUpToDate =
    !isUnlinked &&
    !isSyncInProgress &&
    !isErrorState &&
    !neverSynced &&
    (status?.syncStatus === 'idle' ||
      status?.syncStatus === 'up_to_date' ||
      status?.linked)

  const hasConflicts =
    Boolean(status?.conflicts) &&
    (Array.isArray(status?.conflicts) ? status.conflicts.length > 0 : true)

  const folderUrl =
    status?.folderUrl ||
    (status?.driveFolderId
      ? `https://drive.google.com/drive/folders/${status.driveFolderId}`
      : null)

  return (
    <OLModal
      show={show}
      onHide={handleClose}
      className="google-drive-modal"
      animation={true}
      data-testid="google-drive-modal"
      aria-labelledby="google-drive-modal-title"
    >
      <OLModalHeader closeButton>
        <OLModalTitle id="google-drive-modal-title" as="h2">
          {t('google_drive_sync_title', 'Google Drive')}
        </OLModalTitle>
      </OLModalHeader>

      <OLModalBody>
        <div className="d-flex align-items-center mb-3">
          <div className="me-3">
            <GoogleDriveLogo size={36} />
          </div>
          <div>
            <h4 className="mb-0">
              {t('google_drive_sync', 'Google Drive Synchronization')}
            </h4>
            <p className="small text-muted mb-0">
              {t(
                'google_drive_modal_desc',
                'Synchronize this project with your Google Drive folder.'
              )}
            </p>
          </div>
        </div>

        {/* Loading status */}
        {loading && !status && (
          <div
            className="d-flex align-items-center py-3"
            data-testid="google-drive-loading-status"
          >
            <OLSpinner size="sm" className="me-2" />
            <span>{t('loading_status', 'Loading sync status...')}</span>
          </div>
        )}

        {/* Unlinked State */}
        {!loading && isUnlinked && (
          <div
            className="alert alert-info py-2 px-3 d-flex align-items-start my-3"
            data-testid="google-drive-unlinked-status"
          >
            <MaterialIcon type="info" className="me-2 mt-1 text-info" />
            <div>
              <p className="mb-1">
                {t(
                  'google_drive_not_linked',
                  'Not linked to Google Drive. Link your account in Account Settings.'
                )}
              </p>
              <a
                href="/user/settings#project-sync"
                target="_blank"
                rel="noopener noreferrer"
                className="small fw-bold"
              >
                {t('go_to_account_settings', 'Go to Account Settings')} &rarr;
              </a>
            </div>
          </div>
        )}

        {/* Sync in progress */}
        {!loading && !isUnlinked && isSyncInProgress && (
          <div
            className="d-flex align-items-center py-2 my-2 text-primary"
            data-testid="google-drive-syncing-status"
          >
            <OLSpinner size="sm" className="me-2" />
            <span className="fw-semibold">{t('syncing', 'Syncing...')}</span>
          </div>
        )}

        {/* Never synced yet notice */}
        {!loading && neverSynced && (
          <div
            className="alert alert-info py-2 px-3 d-flex align-items-start my-3"
            data-testid="google-drive-never-synced-status"
          >
            <MaterialIcon type="info" className="me-2 mt-1 text-info" />
            <div>
              <p className="mb-1">
                {t(
                  'google_drive_never_synced',
                  "This project hasn't been synced with Google Drive yet."
                )}
              </p>
              <p className="small mb-0">
                {t(
                  'google_drive_never_synced_hint',
                  'Click "Sync now" below to start.'
                )}
              </p>
            </div>
          </div>
        )}

        {/* Up to date status */}
        {!loading && isUpToDate && (
          <div
            className="d-flex align-items-center py-2 my-2 text-success"
            data-testid="google-drive-up-to-date-status"
          >
            <MaterialIcon
              type="check_circle"
              className="me-2 text-success fs-5"
            />
            <div>
              <span className="fw-semibold text-success">
                {t('up_to_date', 'Up to date')}
              </span>
              {status?.lastSyncedAt && (
                <span className="small text-muted ms-2 google-drive-original-muted">
                  ({t('last_synced', 'Last synced')}:{' '}
                  {formatDate(status.lastSyncedAt)})
                </span>
              )}
            </div>
          </div>
        )}

        {/* Error notification */}
        {isErrorState && (
          <div
            className="alert alert-danger py-2 px-3 d-flex align-items-start my-3"
            data-testid="google-drive-error-alert"
          >
            <MaterialIcon type="error" className="me-2 mt-1 text-danger" />
            <div>
              <strong>{t('sync_error_title', 'Sync Error')}:</strong>{' '}
              <span>
                {actionError ||
                  status?.lastError ||
                  t(
                    'sync_error_unknown',
                    'An error occurred during synchronization.'
                  )}
              </span>
            </div>
          </div>
        )}

        {/* Suspended notification */}
        {status?.syncSuspended && (
          <div
            className="alert alert-danger py-2 px-3 d-flex align-items-start my-3"
            data-testid="google-drive-suspended-alert"
          >
            <MaterialIcon type="error" className="me-2 mt-1 text-danger" />
            <div>
              <strong>{t('sync_suspended_title', 'Sync Suspended')}:</strong>{' '}
              <span>
                {status.suspendReason
                  ? `${t('sync_suspended_reason', 'Synchronization has been suspended')}: ${status.suspendReason}`
                  : t(
                      'sync_suspended_message',
                      'Synchronization has been suspended for this project.'
                    )}
              </span>
            </div>
          </div>
        )}

        {/* Conflict notification */}
        {hasConflicts && (
          <div
            className="alert alert-warning py-2 px-3 my-3"
            data-testid="google-drive-conflict-alert"
          >
            <div className="d-flex align-items-start">
              <MaterialIcon type="warning" className="me-2 mt-1 text-warning" />
              <div className="flex-grow-1">
                <div>
                  <strong>
                    {t('conflict_warning_title', 'Conflicts detected')}:
                  </strong>{' '}
                  <span>
                    {t(
                      'conflict_warning_message',
                      'Overleaf preserved your live edits and created timestamped conflict copies for conflicting Google Drive files.'
                    )}
                  </span>
                </div>
                {Array.isArray(status?.conflicts) &&
                  status.conflicts.length > 0 && (
                    <ul
                      className="mb-2 mt-2 ps-3 small"
                      data-testid="google-drive-conflict-list"
                    >
                      {status.conflicts.map((conflict: any, idx: number) => {
                        const conflictText =
                          typeof conflict === 'string'
                            ? conflict
                            : conflict.conflictPath
                              ? `${conflict.path} → ${conflict.conflictPath}`
                              : conflict.path || JSON.stringify(conflict)
                        return <li key={idx}>{conflictText}</li>
                      })}
                    </ul>
                  )}
                <div className="mt-2">
                  <OLButton
                    variant="secondary"
                    size="sm"
                    onClick={handleDismissConflicts}
                    disabled={dismissing}
                    isLoading={dismissing}
                    data-testid="dismiss-conflicts-button"
                  >
                    {t('dismiss_conflicts', 'Dismiss conflicts')}
                  </OLButton>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Google Drive folder link */}
        {folderUrl && (
          <div className="mt-3 pt-3 border-top">
            <h6
              className="google-drive-folder-heading small text-uppercase fw-bold mb-2"
              style={{ color: '#1b222c' }}
            >
              {t('google_drive_folder', 'Google Drive Folder')}
            </h6>
            <OLButton
              variant="secondary"
              size="sm"
              href={folderUrl}
              target="_blank"
              rel="noopener noreferrer"
              trailingIcon="open_in_new"
              data-testid="google-drive-folder-link"
            >
              {t('open_folder_in_google_drive', 'Open folder in Google Drive')}
            </OLButton>
          </div>
        )}
      </OLModalBody>

      <OLModalFooter>
        <OLButton
          variant="secondary"
          onClick={handleClose}
          aria-label={t('close', 'Close')}
        >
          {t('close', 'Close')}
        </OLButton>

        <OLButton
          variant="primary"
          className="google-drive-sync-btn"
          style={{ color: '#ffffff' }}
          onClick={handleSyncNow}
          disabled={
            syncing ||
            loading ||
            isUnlinked ||
            isSyncInProgress ||
            Boolean(status?.syncSuspended) ||
            cooldownSecondsLeft > 0
          }
          isLoading={syncing}
          loadingLabel={t('syncing', 'Syncing...')}
          data-testid="sync-now-button"
          aria-label={t('sync_now', 'Sync now')}
        >
          {cooldownSecondsLeft > 0
            ? `${t('sync_now', 'Sync now')} (${cooldownSecondsLeft}s)`
            : t('sync_now', 'Sync now')}
        </OLButton>
      </OLModalFooter>
    </OLModal>
  )
}
