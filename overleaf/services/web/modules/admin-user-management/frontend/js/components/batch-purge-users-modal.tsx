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

export interface BatchPurgeUsersModalProps {
  show: boolean
  records: Array<{
    _id: string
    user?: { _id: string; email: string }
    deletedUserEmail?: string
  }>
  onHide: () => void
  onSuccess: (purgedCount: number) => void
}

export default function BatchPurgeUsersModal({
  show,
  records,
  onHide,
  onSuccess,
}: BatchPurgeUsersModalProps) {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handlePurge() {
    setIsLoading(true)
    setError(null)
    try {
      const recordIds = records.map(r => r._id)
      const res = await postJSON<{
        success: boolean
        purgedCount: number
        failed?: Array<{ recordId: string; reason: string }>
        error?: string
      }>('/admin/users/api/deleted-users/batch-purge', {
        body: { recordIds },
      })

      if (res.error) {
        setError(res.error)
      } else {
        onSuccess(res.purgedCount ?? 0)
        onHide()
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to permanently purge selected accounts')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <OLModal show={show} onHide={onHide}>
      <OLModalHeader className="bg-danger text-white" closeVariant="white">
        <OLModalTitle className="text-white d-flex align-items-center gap-2">
          <MaterialIcon type="warning" />
          Permanently Purge {records.length} Account
          {records.length !== 1 ? 's' : ''}
        </OLModalTitle>
      </OLModalHeader>
      <OLModalBody>
        {error ? (
          <Notification type="error" content={error} className="mb-3" />
        ) : null}
        <div className="alert alert-danger py-2">
          <strong>Warning: This action is irreversible!</strong> All associated
          metadata and backup archives will be permanently wiped from the
          database.
        </div>
        <p>
          Are you sure you want to purge the following{' '}
          <strong>{records.length}</strong> deleted user record
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
      </OLModalBody>
      <OLModalFooter>
        <OLButton variant="secondary" onClick={onHide} disabled={isLoading}>
          Cancel
        </OLButton>
        <OLButton variant="danger" onClick={handlePurge} disabled={isLoading}>
          {isLoading
            ? 'Purging...'
            : `Purge ${records.length} Account${records.length !== 1 ? 's' : ''} Permanently`}
        </OLButton>
      </OLModalFooter>
    </OLModal>
  )
}
