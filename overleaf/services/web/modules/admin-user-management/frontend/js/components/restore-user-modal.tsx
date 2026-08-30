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

interface RestoreUserModalProps {
  show: boolean
  user: {
    _id: string
    email?: string
    user?: {
      _id?: string
      email?: string
      first_name?: string
      last_name?: string
    }
  } | null
  onHide: () => void
  onSuccess: (restoredProjectCount: number) => void
}

export default function RestoreUserModal({
  show,
  user,
  onHide,
  onSuccess,
}: RestoreUserModalProps) {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!user) return null

  const targetUserId = user.user?._id || user._id
  const targetEmail = user.user?.email || user.email || 'this user'

  async function handleRestore() {
    setIsLoading(true)
    setError(null)
    try {
      const response = await postJSON<{
        success: boolean
        restoredProjectCount: number
        error?: string
      }>(`/admin/users/api/users/${targetUserId}/restore`, { body: {} })

      if (response.error) {
        setError(response.error)
      } else {
        onSuccess(response.restoredProjectCount || 0)
        onHide()
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to restore account')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <OLModal show={show} onHide={onHide}>
      <OLModalHeader closeButton>
        <OLModalTitle>Restore Account & Projects</OLModalTitle>
      </OLModalHeader>
      <OLModalBody>
        {error ? (
          <Notification type="error" content={error} className="mb-3" />
        ) : null}
        <p>
          Are you sure you want to restore the account for{' '}
          <strong>{targetEmail}</strong>?
        </p>
        <p className="text-muted small">
          This will reactivate their account and restore all projects associated
          with their original account deletion.
        </p>
      </OLModalBody>
      <OLModalFooter>
        <OLButton variant="secondary" onClick={onHide} disabled={isLoading}>
          Cancel
        </OLButton>
        <OLButton
          variant="primary"
          onClick={handleRestore}
          isLoading={isLoading}
          loadingLabel="Restoring..."
        >
          Restore Account
        </OLButton>
      </OLModalFooter>
    </OLModal>
  )
}
