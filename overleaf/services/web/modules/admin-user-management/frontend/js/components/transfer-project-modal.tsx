import { useState, useEffect } from 'react'
import {
  OLModal,
  OLModalHeader,
  OLModalTitle,
  OLModalBody,
  OLModalFooter,
} from '@/shared/components/ol/ol-modal'
import OLButton from '@/shared/components/ol/ol-button'
import OLFormControl from '@/shared/components/ol/ol-form-control'
import OLFormLabel from '@/shared/components/ol/ol-form-label'
import OLBadge from '@/shared/components/ol/ol-badge'
import OLSpinner from '@/shared/components/ol/ol-spinner'
import Notification from '@/shared/components/notification'
import { getJSON, postJSON } from '@/infrastructure/fetch-json'

export interface SearchedUser {
  _id: string
  email: string
  first_name?: string
  last_name?: string
  isAdmin?: boolean
}

export interface TransferProjectModalProps {
  show: boolean
  onHide: () => void
  fromUserId: string
  fromUserEmail: string
  projectId?: string
  projectName?: string
  isBulk?: boolean
  totalProjectCount?: number
  onSuccess: (message: string) => void
}

export default function TransferProjectModal({
  show,
  onHide,
  fromUserId,
  fromUserEmail,
  projectId,
  projectName,
  isBulk = false,
  totalProjectCount = 0,
  onSuccess,
}: TransferProjectModalProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchedUser[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [selectedUser, setSelectedUser] = useState<SearchedUser | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!show) {
      setSearchQuery('')
      setSearchResults([])
      setSelectedUser(null)
      setError(null)
      setIsLoading(false)
      setIsSearching(false)
    }
  }, [show])

  useEffect(() => {
    const query = searchQuery.trim()
    if (!query || selectedUser) {
      setSearchResults([])
      setIsSearching(false)
      return
    }

    setIsSearching(true)
    const timeoutId = setTimeout(async () => {
      try {
        const res = await getJSON<{ users: SearchedUser[] }>(
          `/admin/users/api/search-users?query=${encodeURIComponent(query)}`
        )
        const matches = (res.users || []).filter(u => u._id !== fromUserId)
        setSearchResults(matches)
      } catch (err: any) {
        setSearchResults([])
      } finally {
        setIsSearching(false)
      }
    }, 250)

    return () => clearTimeout(timeoutId)
  }, [searchQuery, selectedUser, fromUserId])

  async function handleTransfer() {
    if (!selectedUser) {
      setError('Please select a destination user.')
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      if (isBulk) {
        const res = await postJSON<{
          success: boolean
          transferredCount?: number
          newTagName?: string
          error?: string
        }>(`/admin/users/api/users/${fromUserId}/projects/transfer-all`, {
          body: { toUserId: selectedUser._id },
        })

        if (res.error) {
          setError(res.error)
        } else {
          const count = res.transferredCount ?? totalProjectCount ?? 0
          onSuccess(
            `Successfully transferred ${count} project(s) to ${selectedUser.email}.`
          )
          onHide()
        }
      } else {
        if (!projectId) {
          setError('No project selected for transfer.')
          return
        }

        const res = await postJSON<{
          success: boolean
          projectId?: string
          newOwnerId?: string
          error?: string
        }>(
          `/admin/users/api/users/${fromUserId}/projects/${projectId}/transfer`,
          {
            body: { newOwnerId: selectedUser._id },
          }
        )

        if (res.error) {
          setError(res.error)
        } else {
          onSuccess(
            `Project "${projectName || 'project'}" transferred to ${selectedUser.email} successfully.`
          )
          onHide()
        }
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to transfer project ownership.')
    } finally {
      setIsLoading(false)
    }
  }

  const modalTitle = isBulk
    ? 'Transfer All Projects Ownership'
    : 'Transfer Project Ownership'

  return (
    <OLModal show={show} onHide={onHide}>
      <OLModalHeader closeButton>
        <OLModalTitle>{modalTitle}</OLModalTitle>
      </OLModalHeader>
      <OLModalBody>
        {error ? (
          <Notification type="error" content={error} className="mb-3" />
        ) : null}

        {isBulk ? (
          <>
            <p>
              Transfer ownership of all{' '}
              <strong>{totalProjectCount} project(s)</strong> owned by{' '}
              <strong>{fromUserEmail}</strong> to another user.
            </p>
            <div className="alert alert-warning small">
              <strong>Note:</strong> All transferred projects will be tagged in
              the destination user's account for easy identification. The
              current owner ({fromUserEmail}) will remain as a collaborator with
              read-write access.
            </div>
          </>
        ) : (
          <>
            <p>
              Transfer ownership of project{' '}
              <strong>{projectName || 'this project'}</strong> from{' '}
              <strong>{fromUserEmail}</strong> to another user.
            </p>
            <div className="alert alert-info small">
              <strong>Note:</strong> The new owner will have full administrative
              ownership of this project. The current owner ({fromUserEmail})
              will remain as a collaborator with read-write access.
            </div>
          </>
        )}

        <div className="mb-3">
          <OLFormLabel htmlFor="destination-user-search">
            Destination User
          </OLFormLabel>

          {selectedUser ? (
            <div className="border rounded p-3 bg-light d-flex justify-content-between align-items-center">
              <div>
                <div className="d-flex align-items-center gap-2">
                  <strong>{selectedUser.email}</strong>
                  {selectedUser.isAdmin ? (
                    <OLBadge bg="info">Admin</OLBadge>
                  ) : null}
                </div>
                {[selectedUser.first_name, selectedUser.last_name].filter(
                  Boolean
                ).length > 0 && (
                  <div className="text-muted small">
                    {[selectedUser.first_name, selectedUser.last_name]
                      .filter(Boolean)
                      .join(' ')}
                  </div>
                )}
                <div className="text-muted small font-monospace">
                  User ID: {selectedUser._id}
                </div>
              </div>
              <OLButton
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  setSelectedUser(null)
                  setSearchQuery('')
                }}
                disabled={isLoading}
              >
                Change
              </OLButton>
            </div>
          ) : (
            <div className="position-relative">
              <OLFormControl
                id="destination-user-search"
                type="search"
                placeholder="Search by email or name..."
                value={searchQuery}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setSearchQuery(e.target.value)
                }
                autoComplete="off"
                disabled={isLoading}
              />
              {isSearching && (
                <div className="position-absolute end-0 top-50 translate-middle-y me-3">
                  <OLSpinner size="sm" />
                </div>
              )}
              {searchResults.length > 0 && (
                <div
                  className="list-group position-absolute w-100 shadow-sm mt-1 border rounded z-3 bg-white"
                  style={{ maxHeight: '200px', overflowY: 'auto' }}
                >
                  {searchResults.map(u => {
                    const fullName = [u.first_name, u.last_name]
                      .filter(Boolean)
                      .join(' ')
                    return (
                      <button
                        key={u._id}
                        type="button"
                        className="list-group-item list-group-item-action d-flex justify-content-between align-items-center py-2 px-3 text-start"
                        onClick={() => {
                          setSelectedUser(u)
                          setSearchQuery('')
                          setSearchResults([])
                        }}
                      >
                        <div>
                          <div className="fw-semibold">{u.email}</div>
                          {fullName ? (
                            <small className="text-muted">{fullName}</small>
                          ) : null}
                        </div>
                        {u.isAdmin ? <OLBadge bg="info">Admin</OLBadge> : null}
                      </button>
                    )
                  })}
                </div>
              )}
              {!isSearching &&
                searchQuery.trim().length > 0 &&
                searchResults.length === 0 && (
                  <div className="text-muted small mt-2">
                    No matching users found.
                  </div>
                )}
            </div>
          )}
        </div>
      </OLModalBody>
      <OLModalFooter>
        <OLButton variant="secondary" onClick={onHide} disabled={isLoading}>
          Cancel
        </OLButton>
        <OLButton
          variant="primary"
          onClick={handleTransfer}
          disabled={!selectedUser || isLoading}
          isLoading={isLoading}
          loadingLabel="Transferring..."
        >
          {isBulk ? 'Transfer All Projects' : 'Transfer Project'}
        </OLButton>
      </OLModalFooter>
    </OLModal>
  )
}
