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

export interface BatchRestoreUsersModalProps {
  show: boolean
  records: Array<{
    _id: string
    user?: { _id: string; email: string }
    deletedUserEmail?: string
  }>
  onHide: () => void
  onSuccess: (restoredCount: number, restoredProjectsCount: number) => void
}

export default function BatchRestoreUsersModal({
  show,
  records,
  onHide,
  onSuccess,
}: BatchRestoreUsersModalProps) {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleRestore() {
    setIsLoading(true)
    setError(null)
    try {
      const userIds = records.map(r => r.user?._id || r._id)
      const res = await postJSON<{
        success: boolean
        restoredCount: number
        restoredProjectsCount: number
        failed?: Array<{ userId: string; reason: string }>
        error?: string
      }>('/admin/users/api/users/batch-restore', {
        body: { userIds },
      })

      if (res.error) {
        setError(res.error)
      } else {
        onSuccess(res.restoredCount ?? 0, res.restoredProjectsCount ?? 0)
        onHide()
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to restore selected accounts')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <OLModal show={show} onHide={onHide}>
      <OLModalHeader closeButton>
        <OLModalTitle className="d-flex align-items-center gap-2">
          <MaterialIcon type="restore_from_trash" />
          Restore {records.length} User Account
          {records.length !== 1 ? 's' : ''}
        </OLModalTitle>
      </OLModalHeader>
      <OLModalBody>
        {error ? (
          <Notification type="error" content={error} className="mb-3" />
        ) : null}
        <p>
          Are you sure you want to restore the following{' '}
          <strong>{records.length}</strong> deleted user account
          {records.length !== 1 ? 's' : ''}?
        </p>
        <div
          className="border rounded p-2 mb-3 bg-light"
          style={{ maxHeight: '160px', overflowY: 'auto' }}
        >
          <ul className="mb-0 ps-3 small text-break">
            {records.map(r => (
              <li key={r._id}>
                {r.deletedUserEmail || r.user?.email || r._id}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-muted small">
          Restoring these accounts will un-archive their user records, restore
          associated email addresses, and unarchive their previously owned
          projects.
        </p>
      </OLModalBody>
      <OLModalFooter>
        <OLButton variant="secondary" onClick={onHide} disabled={isLoading}>
          Cancel
        </OLButton>
        <OLButton variant="primary" onClick={handleRestore} disabled={isLoading}>
          {isLoading
            ? 'Restoring...'
            : `Restore ${records.length} Account${records.length !== 1 ? 's' : ''}`}
        </OLButton>
      </OLModalFooter>
    </OLModal>
  )
}
