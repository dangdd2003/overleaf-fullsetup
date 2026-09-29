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
import MaterialIcon from '@/shared/components/material-icon'
import { postJSON } from '@/infrastructure/fetch-json'

interface DeleteUserModalProps {
  show: boolean
  userId: string
  userEmail: string
  retentionDays?: number
  onHide: () => void
  onSuccess: () => void
}

export default function DeleteUserModal({
  show,
  userId,
  userEmail,
  retentionDays = 90,
  onHide,
  onSuccess,
}: DeleteUserModalProps) {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleDelete() {
    setIsLoading(true)
    setError(null)
    try {
      await postJSON(`/admin/users/api/users/${userId}/delete`, {
        body: {},
      })
      onSuccess()
      onHide()
    } catch (err: any) {
      setError(err?.message || 'Failed to delete user account')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <OLModal show={show} onHide={onHide}>
      <OLModalHeader className="bg-danger text-white" closeVariant="white">
        <OLModalTitle className="text-white d-flex align-items-center gap-2">
          <MaterialIcon type="warning" />
          Delete User Account
        </OLModalTitle>
      </OLModalHeader>
      <OLModalBody>
        {error ? (
          <Notification type="error" content={error} className="mb-3" />
        ) : null}
        <p className="fs-6 mb-3">
          Are you sure you want to soft-delete the account for{' '}
          <strong className="text-break">{userEmail}</strong>?
        </p>

        <div className="alert alert-warning mb-0">
          <ul className="mb-0 ps-3 small">
            <li>All active sessions will be terminated and owned projects archived.</li>
            <li>
              The account can be restored within <strong>{retentionDays} days</strong> before permanent deletion.
            </li>
          </ul>
        </div>
      </OLModalBody>
      <OLModalFooter>
        <OLButton variant="secondary" onClick={onHide} disabled={isLoading}>
          Cancel
        </OLButton>
        <OLButton
          variant="danger"
          onClick={handleDelete}
          isLoading={isLoading}
          loadingLabel="Deleting..."
        >
          Soft Delete Account
        </OLButton>
      </OLModalFooter>
    </OLModal>
  )
}
