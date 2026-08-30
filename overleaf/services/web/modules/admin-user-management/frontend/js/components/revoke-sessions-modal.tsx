import { useState } from 'react'
import {
  OLModal,
  OLModalHeader,
  OLModalTitle,
  OLModalBody,
  OLModalFooter,
} from '@/shared/components/ol/ol-modal'
import OLButton from '@/shared/components/ol/ol-button'
import Notification from '@/shared/components/notification'
import { postJSON } from '@/infrastructure/fetch-json'

export interface RevokeSessionsModalProps {
  show: boolean
  onHide: () => void
  userId: string
  userEmail: string
  isSelf: boolean
  onSuccess: (revokedCount: number) => void
}

export default function RevokeSessionsModal({
  show,
  onHide,
  userId,
  userEmail,
  isSelf,
  onSuccess,
}: RevokeSessionsModalProps) {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleRevoke() {
    setIsLoading(true)
    setError(null)
    try {
      const response = await postJSON<{
        success: boolean
        revokedCount: number
        error?: string
      }>(`/admin/users/api/users/${userId}/sessions/revoke`, { body: {} })

      if (response.error) {
        setError(response.error)
      } else {
        onSuccess(response.revokedCount ?? 0)
        onHide()
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to revoke user sessions')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <OLModal show={show} onHide={onHide}>
      <OLModalHeader closeButton>
        <OLModalTitle>Revoke Active Sessions</OLModalTitle>
      </OLModalHeader>
      <OLModalBody>
        {error ? (
          <Notification type="error" content={error} className="mb-3" />
        ) : null}
        <p>
          Are you sure you want to revoke all active sessions for{' '}
          <strong>{userEmail}</strong>?
        </p>
        {isSelf ? (
          <div className="alert alert-info">
            <strong>Note:</strong> This will terminate active sessions across
            all other browsers and devices. Your current session will remain
            active.
          </div>
        ) : (
          <div className="alert alert-warning">
            <strong>Warning:</strong> This will immediately log the user out and
            terminate all active browser sessions across all devices.
          </div>
        )}
      </OLModalBody>
      <OLModalFooter>
        <OLButton variant="secondary" onClick={onHide} disabled={isLoading}>
          Cancel
        </OLButton>
        <OLButton
          variant="danger"
          onClick={handleRevoke}
          isLoading={isLoading}
          loadingLabel="Revoking..."
        >
          Revoke All Sessions
        </OLButton>
      </OLModalFooter>
    </OLModal>
  )
}
