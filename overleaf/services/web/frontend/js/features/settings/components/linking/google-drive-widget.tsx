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

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/auth/google-drive/status')
      if (res.ok) {
        const data = await res.json()
        if (typeof data.isLinked === 'boolean') {
          setIsLinked(data.isLinked)
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
  }, [])

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
        const errorMsg =
          event.data.error ||
          t('google_drive_oauth_failed', 'Failed to link Google Drive account')
        setErrorMessage(errorMsg)
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

  const handleScanClick = useCallback(async () => {
    setScanInflight(true)
    setErrorMessage('')
    setScanMessage('')

    try {
      const csrfToken =
        (typeof window !== 'undefined' && (window as any).csrfToken) ||
        getMeta('ol-csrfToken') ||
        ''

      const res = await fetch('/auth/google-drive/scan-existing-projects', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Csrf-Token': csrfToken,
        },
      })

      if (res.ok) {
        const data = await res.json()
        const createdCount = data.createdCount || 0
        const syncedCount = data.syncedCount || 0
        const scannedCount = data.scannedCount || 0

        if (createdCount > 0 && syncedCount > 0) {
          setScanMessage(
            `${t('imported', 'Imported')} ${createdCount} ${t(
              'new_and_synced',
              'new project(s) and synchronized'
            )} ${syncedCount} ${t(
              'existing_projects_from_google_drive',
              'existing project(s) from Google Drive.'
            )}`
          )
        } else if (createdCount > 0) {
          setScanMessage(
            `${t('imported', 'Imported')} ${createdCount} ${t(
              'projects_from_google_drive',
              'project(s) from Google Drive.'
            )}`
          )
        } else if (syncedCount > 0) {
          setScanMessage(
            `${t('synchronized', 'Synchronized')} ${syncedCount} ${t(
              'existing_projects_from_google_drive',
              'existing project(s) from Google Drive.'
            )}`
          )
        } else if (scannedCount > 0) {
          setScanMessage(
            t(
              'all_google_drive_projects_synced',
              `Found ${scannedCount} project(s) in Google Drive. All are linked and up to date.`
            )
          )
        } else {
          setScanMessage(
            t(
              'no_existing_google_drive_projects_found',
              'No existing projects found in your Google Drive folder.'
            )
          )
        }
      } else {
        const errorData = await res.json().catch(() => ({}))
        setErrorMessage(
          errorData.message ||
            t(
              'scan_existing_projects_failed',
              'Failed to scan for existing Google Drive projects'
            )
        )
      }
    } catch (err: any) {
      setErrorMessage(
        err?.message ||
          t(
            'scan_existing_projects_failed',
            'Failed to scan for existing Google Drive projects'
          )
      )
    } finally {
      setScanInflight(false)
    }
  }, [t])

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
              variant="secondary"
              className="google-drive-scan-btn"
              onClick={handleScanClick}
              disabled={scanInflight}
              isLoading={scanInflight}
              loadingLabel={t('scanning', 'Scanning...')}
            >
              {t('scan_for_existing_projects', 'Scan for existing projects')}
            </OLButton>
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
          </div>
        )}
      </div>

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
