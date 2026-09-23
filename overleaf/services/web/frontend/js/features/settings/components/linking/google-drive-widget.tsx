import {
  GoogleDriveImportPanel,
  useGoogleDriveImport,
  type ImportJob,
} from './google-drive-import-panel'
import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  OLModal,
  OLModalBody,
  OLModalFooter,
  OLModalHeader,
  OLModalTitle,
} from '@/shared/components/ol/ol-modal'
import OLButton from '@/shared/components/ol/ol-button'
import GoogleDriveLogo from '@/shared/svgs/google-drive-logo'
import LinkingStatus from './status'
import getMeta from '@/utils/meta'
import {
  BulkSyncJob,
  GoogleDriveBulkSyncPanel,
  useGoogleDriveBulkSync,
} from './google-drive-bulk-sync'

export interface GoogleDriveWidgetProps {
  initialIsLinked?: boolean
  initialGoogleEmail?: string
  initialLinkedAt?: string | Date
  onUnlinkSuccess?: () => void
  onUnlinkError?: (error: Error) => void
}

function formatDate(dateInput?: string | Date): string {
  if (!dateInput) return ''
  const date = new Date(dateInput)
  if (isNaN(date.getTime())) return ''
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export function GoogleDriveLinkingWidget({
  initialIsLinked,
  initialGoogleEmail,
  initialLinkedAt,
  onUnlinkSuccess,
  onUnlinkError,
}: GoogleDriveWidgetProps = {}) {
  const { t } = useTranslation()

  // Initialize state from props or metadata
  const metaGoogleDrive = getMeta('ol-googleDrive')
  const defaultIsLinked =
    initialIsLinked !== undefined
      ? initialIsLinked
      : Boolean(metaGoogleDrive?.registered || metaGoogleDrive?.linked)
  const defaultGoogleEmail =
    initialGoogleEmail !== undefined
      ? initialGoogleEmail
      : metaGoogleDrive?.email || ''
  const defaultLinkedAt =
    initialLinkedAt !== undefined ? initialLinkedAt : metaGoogleDrive?.linkedAt

  const [isLinked, setIsLinked] = useState<boolean>(defaultIsLinked)
  const [googleEmail, setGoogleEmail] = useState<string>(defaultGoogleEmail)
  const [linkedAt, setLinkedAt] = useState<string | Date | undefined>(
    defaultLinkedAt
  )
  const [showModal, setShowModal] = useState<boolean>(false)
  const [unlinkInflight, setUnlinkInflight] = useState<boolean>(false)
  const [errorMessage, setErrorMessage] = useState<string>('')
  const [scanInflight, setScanInflight] = useState<boolean>(false)
  const [scanMessage, setScanMessage] = useState<string>('')
  const [showBulkSync, setShowBulkSync] = useState<boolean>(false)

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/auth/google-drive/status')
      if (res.ok) {
        const data = await res.json()
        if (data.needsReauth || data.error === 'token_decryption_failed') {
          setIsLinked(false)
          setErrorMessage(
            t(
              'google_drive_reauth_required',
              'Your Google Drive authorization has expired or the server encryption key has changed. Please link your account again.'
            )
          )
          if (data.googleEmail) {
            setGoogleEmail(data.googleEmail)
          }
        } else if (typeof data.isLinked === 'boolean') {
          setIsLinked(data.isLinked)
          if (data.isLinked) {
            setErrorMessage('')
          }
          if (data.googleEmail) {
            setGoogleEmail(data.googleEmail)
          }
          if (data.linkedAt) {
            setLinkedAt(data.linkedAt)
          }
        }
      }
    } catch {
      // Endpoint may not be present or network error; keep current state
    }
  }, [t])

  useEffect(() => {
    // Only attempt fetch if initial props were not explicitly provided
    if (initialIsLinked === undefined && !metaGoogleDrive) {
      fetchStatus()
    }
  }, [initialIsLinked, metaGoogleDrive, fetchStatus])

  useEffect(() => {
    // Refresh linked status when tab visibility changes as a fallback
    if (isLinked) {
      return undefined
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        fetchStatus()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [isLinked, fetchStatus])

  useEffect(() => {
    // Listen for OAuth completion message from login popup window
    const handleMessage = (event: MessageEvent) => {
      if (
        typeof window !== 'undefined' &&
        event.origin !== window.location.origin
      ) {
        return
      }
      if (event.data?.type === 'google-drive:oauth-success') {
        fetchStatus()
      } else if (event.data?.type === 'google-drive:oauth-error') {
        // The popup sends back an error code, not something readable
        const fallback = t(
          'google_drive_oauth_failed',
          'Failed to link Google Drive account'
        )
        const messages: Record<string, string> = {
          google_drive_oauth_denied: t(
            'google_drive_oauth_denied',
            'Google Drive access was not granted'
          ),
          google_drive_oauth_invalid: t(
            'google_drive_oauth_invalid',
            'The Google Drive sign-in could not be verified. Please try again'
          ),
          google_drive_oauth_failed: fallback,
        }
        setErrorMessage(messages[event.data.error] || fallback)
        fetchStatus()
      }
    }

    window.addEventListener('message', handleMessage)
    return () => {
      window.removeEventListener('message', handleMessage)
    }
  }, [fetchStatus, t])

  const handleLinkClick = useCallback(() => {
    setErrorMessage('')
    setScanMessage('')

    const width = 600
    const height = 700
    const left =
      typeof window !== 'undefined' && window.screenX !== undefined
        ? window.screenX + (window.outerWidth - width) / 2
        : 100
    const top =
      typeof window !== 'undefined' && window.screenY !== undefined
        ? window.screenY + (window.outerHeight - height) / 2
        : 100

    const popup = window.open(
      '/auth/google-drive/oauth?popup=true',
      'google_drive_oauth',
      `width=${width},height=${height},left=${left},top=${top},scrollbars=yes,resizable=yes`
    )

    if (!popup) {
      window.location.href = '/auth/google-drive/oauth'
      return
    }

    if (popup.focus) {
      popup.focus()
    }

    const timer = setInterval(() => {
      if (popup.closed) {
        clearInterval(timer)
        fetchStatus()
      }
    }, 1000)
  }, [fetchStatus])

  const handleScanClick = useCallback(() => {
    setErrorMessage('')
    setScanMessage('')
    setShowBulkSync(false)
    setShowScanImport(prev => !prev)
  }, [])

  const handleScanImportClose = useCallback(() => {
    setShowScanImport(false)
  }, [])

  const handleBulkSyncFinished = useCallback(
    (job: BulkSyncJob) => {
      if (job.status !== 'completed') {
        return
      }
      if (job.failedCount > 0) {
        setErrorMessage(
          t(
            'google_drive_bulk_sync_partial',
            '{{failedCount}} of {{total}} project(s) failed to sync to Google Drive.',
            { failedCount: job.failedCount, total: job.total }
          )
        )
      }
      if (job.syncedCount > 0) {
        setScanMessage(
          t(
            'google_drive_bulk_sync_done',
            'Synced {{syncedCount}} project(s) to Google Drive.',
            { syncedCount: job.syncedCount }
          )
        )
      }
    },
    [t]
  )

  const [showScanImport, setShowScanImport] = useState<boolean>(false)

  const handleImportFinished = useCallback(
    (job: ImportJob) => {
      if (job.status !== 'completed') {
        return
      }
      if (job.failedCount > 0) {
        setErrorMessage(
          t(
            'google_drive_import_some_failed',
            `${job.failedCount} project(s) failed to import from Google Drive.`
          )
        )
      } else if (job.importedCount > 0) {
        setScanMessage(
          t(
            'google_drive_import_success',
            `Successfully imported or synced ${job.importedCount} project(s) from Google Drive.`
          )
        )
      }
    },
    [t]
  )

  const {
    job: importJob,
    active: importActive,
    applyJob: applyImportJob,
  } = useGoogleDriveImport(isLinked, handleImportFinished)

  const {
    job: bulkSyncJob,
    active: bulkSyncActive,
    applyJob: applyBulkSyncJob,
  } = useGoogleDriveBulkSync(isLinked, handleBulkSyncFinished)

  const handleBulkSyncClick = useCallback(() => {
    setErrorMessage('')
    setScanMessage('')
    setShowScanImport(false)
    setShowBulkSync(prev => !prev)
  }, [])

  const handleBulkSyncClose = useCallback(() => {
    setShowBulkSync(false)
  }, [])

  const handleUnlinkClick = useCallback(() => {
    setShowModal(true)
    setErrorMessage('')
  }, [])

  const handleModalHide = useCallback(() => {
    if (!unlinkInflight) {
      setShowModal(false)
    }
  }, [unlinkInflight])

  const handleConfirmUnlink = useCallback(async () => {
    setUnlinkInflight(true)
    setErrorMessage('')

    try {
      const csrfToken =
        (typeof window !== 'undefined' && (window as any).csrfToken) ||
        getMeta('ol-csrfToken') ||
        ''

      const res = await fetch('/auth/google-drive/unlink', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Csrf-Token': csrfToken,
        },
      })

      if (res.ok) {
        setIsLinked(false)
        setGoogleEmail('')
        setLinkedAt(undefined)
        setShowBulkSync(false)
        setShowModal(false)
        if (onUnlinkSuccess) {
          onUnlinkSuccess()
        }
      } else {
        const errorData = await res.json().catch(() => ({}))
        const errorMsg =
          errorData.message ||
          t('unlink_failed', 'Failed to unlink Google Drive account')
        setErrorMessage(errorMsg)
        setShowModal(false)
        if (onUnlinkError) {
          onUnlinkError(new Error(errorMsg))
        }
      }
    } catch (err: any) {
      const errorMsg =
        err?.message ||
        t('unlink_failed', 'Failed to unlink Google Drive account')
      setErrorMessage(errorMsg)
      setShowModal(false)
      if (onUnlinkError) {
        onUnlinkError(err instanceof Error ? err : new Error(errorMsg))
      }
    } finally {
      setUnlinkInflight(false)
    }
  }, [t, onUnlinkSuccess, onUnlinkError])

  const titleId = 'google-drive'
  const linkTextId = 'google-drive-link'
  const unlinkTextId = 'google-drive-unlink'

  return (
    <div
      className="settings-widget-container"
      data-testid="google-drive-linking-widget"
    >
      <div>
        <GoogleDriveLogo size={40} />
      </div>

      <div className="description-container">
        <div className="title-row">
          <h4 id={titleId}>{t('google_drive', 'Google Drive')}</h4>
        </div>

        <p className="small">
          {t(
            'google_drive_sync_description',
            'Keep your Overleaf projects in sync with your Google Drive account. Changes in Overleaf are automatically sent to your Google Drive account, and the other way around.'
          )}
        </p>

        {isLinked ? (
          <div>
            <LinkingStatus
              status="success"
              description={
                <span>
                  {t('linked_to_google_drive_as', 'Linked to Google Drive as')}{' '}
                  <strong>
                    {googleEmail || t('linked_account', 'Linked account')}
                  </strong>
                  {linkedAt
                    ? ` (${t('linked_on', 'Linked on')} ${formatDate(linkedAt)})`
                    : null}
                </span>
              }
            />
          </div>
        ) : null}

        {errorMessage ? (
          <div className="mt-2">
            <LinkingStatus status="error" description={errorMessage} />
          </div>
        ) : null}

        {scanMessage ? (
          <div className="mt-2">
            <LinkingStatus status="success" description={scanMessage} />
          </div>
        ) : null}
      </div>

      <div>
        {!isLinked ? (
          <OLButton
            variant="secondary"
            className="google-drive-link-btn"
            onClick={handleLinkClick}
            id={linkTextId}
            aria-labelledby={`${linkTextId} ${titleId}`}
          >
            {t('link', 'Link')}
          </OLButton>
        ) : (
          <div className="d-flex flex-column align-items-end gap-2">
            <OLButton
              variant="danger-ghost"
              className="google-drive-unlink-btn"
              onClick={handleUnlinkClick}
              disabled={unlinkInflight}
              id={unlinkTextId}
              aria-labelledby={`${unlinkTextId} ${titleId}`}
            >
              {t('unlink', 'Unlink')}
            </OLButton>
            <OLButton
              variant="secondary"
              className="google-drive-scan-btn"
              onClick={handleScanClick}
              disabled={unlinkInflight}
              isLoading={importActive}
              loadingLabel={t('scanning', 'Scanning...')}
              data-testid="google-drive-scan-button"
            >
              {t('scan_for_existing_projects', 'Scan for existing projects')}
            </OLButton>
            <OLButton
              variant="secondary"
              className="google-drive-bulk-sync-btn"
              onClick={handleBulkSyncClick}
              isLoading={bulkSyncActive}
              loadingLabel={t('syncing', 'Syncing...')}
              data-testid="google-drive-bulk-sync-button"
            >
              {t(
                'sync_projects_to_google_drive',
                'Sync projects to Google Drive'
              )}
            </OLButton>
          </div>
        )}
      </div>

      {isLinked && showScanImport ? (
        <GoogleDriveImportPanel
          job={importJob}
          onJobChange={applyImportJob}
          onClose={handleScanImportClose}
        />
      ) : null}

      {isLinked && showBulkSync ? (
        <GoogleDriveBulkSyncPanel
          job={bulkSyncJob}
          onJobChange={applyBulkSyncJob}
          onClose={handleBulkSyncClose}
        />
      ) : null}

      {/* Unlink Confirmation Modal */}
      <OLModal
        show={showModal}
        onHide={handleModalHide}
        animation={true}
        aria-labelledby="unlink-google-drive-modal-title"
      >
        <OLModalHeader closeButton>
          <OLModalTitle id="unlink-google-drive-modal-title" as="h2">
            {t('unlink_google_drive_title', 'Unlink Google Drive Account')}
          </OLModalTitle>
        </OLModalHeader>

        <OLModalBody>
          <p>
            {t(
              'unlink_google_drive_warning',
              'Any projects that you have synced with Google Drive will be disconnected and no longer kept in sync with Google Drive. Are you sure you want to unlink your Google Drive account?'
            )}
          </p>
        </OLModalBody>

        <OLModalFooter>
          <OLButton
            variant="secondary"
            onClick={handleModalHide}
            disabled={unlinkInflight}
          >
            {t('cancel', 'Cancel')}
          </OLButton>
          <OLButton
            variant="danger-ghost"
            className="google-drive-unlink-confirm-btn"
            onClick={handleConfirmUnlink}
            disabled={unlinkInflight}
            isLoading={unlinkInflight}
            loadingLabel={t('unlinking', 'Unlinking...')}
            aria-label={t('unlink', 'Unlink')}
          >
            {t('unlink', 'Unlink')}
          </OLButton>
        </OLModalFooter>
      </OLModal>
    </div>
  )
}

export { GoogleDriveLinkingWidget as GoogleDriveWidget }
export default GoogleDriveLinkingWidget
