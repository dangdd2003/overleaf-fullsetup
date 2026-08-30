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

export interface BatchDeleteUsersModalProps {
  show: boolean
  users: Array<{ _id: string; email: string }>
  retentionDays?: number
  onHide: () => void
  onSuccess: (deletedCount: number) => void
}

export default function BatchDeleteUsersModal({
  show,
  users,
  retentionDays = 90,
  onHide,
  onSuccess,
}: BatchDeleteUsersModalProps) {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleDelete() {
    setIsLoading(true)
    setError(null)
    try {
      const userIds = users.map(u => u._id)
      const res = await postJSON<{
        success: boolean
        deletedCount: number
        failed?: Array<{ userId: string; reason: string }>
        error?: string
      }>('/admin/users/api/users/batch-delete', {
        body: { userIds },
      })

      if (res.error) {
        setError(res.error)
      } else {
        onSuccess(res.deletedCount ?? 0)
        onHide()
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to delete selected accounts')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <OLModal show={show} onHide={onHide}>
      <OLModalHeader className="bg-danger text-white" closeVariant="white">
        <OLModalTitle className="text-white d-flex align-items-center gap-2">
          <MaterialIcon type="warning" />
          Delete {users.length} User Account{users.length !== 1 ? 's' : ''}
        </OLModalTitle>
      </OLModalHeader>
      <OLModalBody>
        {error ? (
          <Notification type="error" content={error} className="mb-3" />
        ) : null}
        <p>
          Are you sure you want to delete the following{' '}
          <strong>{users.length}</strong> user account
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
          These accounts will be soft-deleted and retained for {retentionDays}{' '}
          days, during which they can be restored. Any owned projects will also
          be archived.
        </p>
      </OLModalBody>
      <OLModalFooter>
        <OLButton variant="secondary" onClick={onHide} disabled={isLoading}>
          Cancel
        </OLButton>
        <OLButton variant="danger" onClick={handleDelete} disabled={isLoading}>
          {isLoading
            ? 'Deleting...'
            : `Delete ${users.length} Account${users.length !== 1 ? 's' : ''}`}
        </OLButton>
      </OLModalFooter>
    </OLModal>
  )
}
