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

export interface PurgeDeletedUserModalProps {
  show: boolean
  onHide: () => void
  userRecord: {
    _id: string
    deleterData?: {
      deletedAt?: string
      deletedUserId?: string
    }
    user?: {
      _id?: string
      email?: string
      first_name?: string
      last_name?: string
    }
  } | null
  onSuccess: (msg?: string) => void
}

export default function PurgeDeletedUserModal({
  show,
  onHide,
  userRecord,
  onSuccess,
}: PurgeDeletedUserModalProps) {
  const [isPurging, setIsPurging] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!userRecord) return null

  const email = userRecord.user?.email || 'this user'
  const fullName = [userRecord.user?.first_name, userRecord.user?.last_name]
    .filter(Boolean)
    .join(' ')
  const targetId = userRecord.deleterData?.deletedUserId || userRecord._id

  async function handlePurge() {
    setIsPurging(true)
    setError(null)
    try {
      await postJSON(`/admin/users/api/deleted-users/${targetId}/purge`, {
        body: {},
      })
      onSuccess(`User ${email} has been permanently deleted from the database.`)
      onHide()
    } catch (err: any) {
      setError(err?.message || 'Failed to permanently delete user')
    } finally {
      setIsPurging(false)
    }
  }

  return (
    <OLModal show={show} onHide={onHide} size="md">
      <OLModalHeader className="bg-danger text-white" closeVariant="white">
        <OLModalTitle className="text-white d-flex align-items-center gap-2">
          <MaterialIcon type="warning" />
          Permanently Delete User
        </OLModalTitle>
      </OLModalHeader>

      <OLModalBody>
        {error ? (
          <Notification type="error" content={error} className="mb-3" />
        ) : null}

        <div className="alert alert-danger d-flex align-items-start gap-2 mb-3">
          <MaterialIcon
            type="warning"
            className="fs-5 mt-1 flex-shrink-0"
          />
          <div>
            <strong className="d-block mb-1">
              Warning: This action is permanent and irreversible!
            </strong>
            <span className="small">
              The archived account and all its soft-deleted projects and metadata
              will be permanently purged from the database. It cannot be recovered
              or restored after this.
            </span>
          </div>
        </div>

        <div className="border rounded p-3 bg-light">
          <div className="mb-2">
            <span className="text-muted small d-block">Account Email:</span>
            <strong className="text-break">{email}</strong>
          </div>
          {fullName ? (
            <div className="mb-2">
              <span className="text-muted small d-block">Name:</span>
              <span>{fullName}</span>
            </div>
          ) : null}
          {userRecord.deleterData?.deletedAt ? (
            <div>
              <span className="text-muted small d-block">Soft Deleted On:</span>
              <span>
                {new Date(userRecord.deleterData.deletedAt).toLocaleString()}
              </span>
            </div>
          ) : null}
        </div>
      </OLModalBody>

      <OLModalFooter>
        <OLButton variant="secondary" onClick={onHide} disabled={isPurging}>
          Cancel
        </OLButton>
        <OLButton
          variant="danger"
          onClick={handlePurge}
          disabled={isPurging}
        >
          {isPurging ? 'Deleting...' : 'Permanently Delete User'}
        </OLButton>
      </OLModalFooter>
    </OLModal>
  )
}
