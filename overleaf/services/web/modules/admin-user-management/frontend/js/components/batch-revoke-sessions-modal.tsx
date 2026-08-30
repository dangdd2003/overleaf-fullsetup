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

export interface BatchRevokeSessionsModalProps {
  show: boolean
  users: Array<{ _id: string; email: string }>
  onHide: () => void
  onSuccess: (revokedCount: number) => void
}

export default function BatchRevokeSessionsModal({
  show,
  users,
  onHide,
  onSuccess,
}: BatchRevokeSessionsModalProps) {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleRevoke() {
    setIsLoading(true)
    setError(null)
    try {
      const userIds = users.map(u => u._id)
      const res = await postJSON<{
        success: boolean
        totalRevoked: number
        failed?: Array<{ userId: string; reason: string }>
        error?: string
      }>('/admin/users/api/users/batch-revoke-sessions', {
        body: { userIds },
      })

      if (res.error) {
        setError(res.error)
      } else {
        onSuccess(res.totalRevoked ?? 0)
        onHide()
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to revoke sessions')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <OLModal show={show} onHide={onHide}>
      <OLModalHeader closeButton>
        <OLModalTitle className="d-flex align-items-center gap-2">
          <MaterialIcon type="logout" />
          Revoke Active Sessions ({users.length} Users)
        </OLModalTitle>
      </OLModalHeader>
      <OLModalBody>
        {error ? (
          <Notification type="error" content={error} className="mb-3" />
        ) : null}
        <p>
          Are you sure you want to terminate all active browser sessions for the
          following <strong>{users.length}</strong> user
          {users.length !== 1 ? 's' : ''}?
        </p>
        <div
          className="border rounded p-2 mb-3 bg-light"
          style={{ maxHeight: '160px', overflowY: 'auto' }}
        >
          <ul className="mb-0 ps-3 small text-break">
            {users.map(u => (
              <li key={u._id}>{u.email}</li>
            ))}
          </ul>
        </div>
        <p className="text-muted small">
          These users will be immediately logged out of all connected browsers,
          active tabs, and mobile devices. They will need to sign in again with
          their credentials.
        </p>
      </OLModalBody>
      <OLModalFooter>
        <OLButton variant="secondary" onClick={onHide} disabled={isLoading}>
          Cancel
        </OLButton>
        <OLButton
          variant="outline-danger"
          onClick={handleRevoke}
          disabled={isLoading}
        >
          {isLoading
            ? 'Revoking...'
            : `Revoke Sessions for ${users.length} User${users.length !== 1 ? 's' : ''}`}
        </OLButton>
      </OLModalFooter>
    </OLModal>
  )
}
