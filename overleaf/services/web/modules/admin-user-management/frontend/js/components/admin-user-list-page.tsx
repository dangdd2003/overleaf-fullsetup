import { useState, useEffect, useCallback, useRef } from 'react'
import OLCard from '@/shared/components/ol/ol-card'
import OLTable from '@/shared/components/ol/ol-table'
import OLButton from '@/shared/components/ol/ol-button'
import OLButtonGroup from '@/shared/components/ol/ol-button-group'
import OLFormControl from '@/shared/components/ol/ol-form-control'
import OLFormCheckbox from '@/shared/components/ol/ol-form-checkbox'
import OLSpinner from '@/shared/components/ol/ol-spinner'
import Pagination from '@/shared/components/pagination'
import Notification from '@/shared/components/notification'
import {
  Dropdown,
  DropdownToggle,
  DropdownMenu,
  DropdownItem,
} from '@/shared/components/dropdown/dropdown-menu'
import getMeta from '@/utils/meta'
import { getJSON, postJSON } from '@/infrastructure/fetch-json'
import UserStatusBadge from './user-status-badge'
import RestoreUserModal from './restore-user-modal'
import CreateUsersModal from './create-users-modal'
import PurgeDeletedUserModal from './purge-deleted-user-modal'
import DeleteUserModal from './delete-user-modal'
import RevokeSessionsModal from './revoke-sessions-modal'
import BatchActionBar from './batch-action-bar'
import BatchDeleteUsersModal from './batch-delete-users-modal'
import BatchRevokeSessionsModal from './batch-revoke-sessions-modal'
import BatchRestoreUsersModal from './batch-restore-users-modal'
import BatchPurgeUsersModal from './batch-purge-users-modal'

interface ActiveUser {
  _id: string
  email: string
  first_name?: string
  last_name?: string
  isAdmin?: boolean
  suspended?: boolean
  holdingAccount?: boolean
  signUpDate?: string
  lastActive?: string
  lastLoggedIn?: string
  role?: string
  institution?: string
}

interface DeletedUserRecord {
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
    isAdmin?: boolean
    signUpDate?: string
  }
}

export default function AdminUserListPage() {
  const [tab, setTab] = useState<'active' | 'deleted'>('active')
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [page, setPage] = useState(1)
  const [limit, setLimit] = useState(20)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const [activeData, setActiveData] = useState<{
    users: ActiveUser[]
    total: number
    totalPages: number
  }>({ users: [], total: 0, totalPages: 1 })

  const [deletedData, setDeletedData] = useState<{
    deletedUsers: DeletedUserRecord[]
    total: number
    totalPages: number
  }>({ deletedUsers: [], total: 0, totalPages: 1 })

  // Selection states
  const [selectedActiveUsers, setSelectedActiveUsers] = useState<
    Map<string, ActiveUser>
  >(new Map())
  const [selectedDeletedUsers, setSelectedDeletedUsers] = useState<
    Map<string, DeletedUserRecord>
  >(new Map())

  // Single-action Modals
  const [userToRestore, setUserToRestore] = useState<DeletedUserRecord | null>(
    null
  )
  const [userToPurge, setUserToPurge] = useState<DeletedUserRecord | null>(null)
  const [userToDelete, setUserToDelete] = useState<ActiveUser | null>(null)
  const [userToRevokeSessions, setUserToRevokeSessions] =
    useState<ActiveUser | null>(null)
  const [showCreateModal, setShowCreateModal] = useState(false)

  // Batch-action Modals
  const [showBatchDeleteModal, setShowBatchDeleteModal] = useState(false)
  const [showBatchRevokeModal, setShowBatchRevokeModal] = useState(false)
  const [showBatchRestoreModal, setShowBatchRestoreModal] = useState(false)
  const [showBatchPurgeModal, setShowBatchPurgeModal] = useState(false)

  const currentUserId = getMeta('ol-user_id') as string | undefined

  // Indeterminate refs for header checkboxes
  const activeHeaderCheckboxRef = useRef<HTMLInputElement>(null)
  const deletedHeaderCheckboxRef = useRef<HTMLInputElement>(null)

  // Debounce search input
  useEffect(() => {
    const handler = setTimeout(() => {
      setSearch(searchInput)
      setPage(1)
    }, 300)
    return () => clearTimeout(handler)
  }, [searchInput])

  const fetchData = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      if (tab === 'active') {
        const queryParams = new URLSearchParams({
          search,
          page: page.toString(),
          limit: limit.toString(),
          sortBy: 'signUpDate',
          sortOrder: 'desc',
        })
        const [activeRes, deletedRes] = await Promise.all([
          getJSON<{
            users: ActiveUser[]
            total: number
            totalPages: number
          }>(`/admin/users/api/users?${queryParams.toString()}`),
          getJSON<{
            deletedUsers: DeletedUserRecord[]
            total: number
            totalPages: number
          }>(`/admin/users/api/deleted-users?limit=1`),
        ])
        setActiveData(activeRes)
        setDeletedData(prev => ({ ...prev, total: deletedRes.total }))
      } else {
        const queryParams = new URLSearchParams({
          search,
          page: page.toString(),
          limit: limit.toString(),
        })
        const [deletedRes, activeRes] = await Promise.all([
          getJSON<{
            deletedUsers: DeletedUserRecord[]
            total: number
            totalPages: number
          }>(`/admin/users/api/deleted-users?${queryParams.toString()}`),
          getJSON<{
            users: ActiveUser[]
            total: number
            totalPages: number
          }>(`/admin/users/api/users?limit=1`),
        ])
        setDeletedData(deletedRes)
        setActiveData(prev => ({ ...prev, total: activeRes.total }))
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to load user directory')
    } finally {
      setIsLoading(false)
    }
  }, [tab, search, page, limit])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  function handleTabChange(newTab: 'active' | 'deleted') {
    setTab(newTab)
    setPage(1)
    setError(null)
    setSuccessMessage(null)
  }

  function handlePageClick(newPage: number) {
    setPage(newPage)
  }

  function handleRestoreSuccess(msg?: string) {
    setUserToRestore(null)
    if (msg) {
      setSuccessMessage(msg)
    } else {
      setSuccessMessage('User restored successfully')
    }
    fetchData()
  }

  function handlePurgeSuccess(msg?: string) {
    setUserToPurge(null)
    if (msg) {
      setSuccessMessage(msg)
    } else {
      setSuccessMessage('User record purged permanently')
    }
    fetchData()
  }

  function handleCreateSuccess(msg?: string) {
    setShowCreateModal(false)
    if (msg) {
      setSuccessMessage(msg)
    }
    fetchData()
  }

  async function handleToggleAdmin(user: ActiveUser) {
    try {
      const newIsAdmin = !user.isAdmin
      await postJSON(`/admin/users/api/users/${user._id}/admin`, {
        body: { isAdmin: newIsAdmin },
      })
      setSuccessMessage(
        newIsAdmin
          ? `Granted site admin privileges to ${user.email}.`
          : `Revoked site admin privileges from ${user.email}.`
      )
      fetchData()
    } catch (err: any) {
      setError(err?.message || 'Failed to update admin status')
    }
  }

  // Active Users Selection Handlers
  const visibleActiveUsers = activeData.users
  const allVisibleActiveSelected =
    visibleActiveUsers.length > 0 &&
    visibleActiveUsers.every(u => selectedActiveUsers.has(u._id))
  const someVisibleActiveSelected =
    visibleActiveUsers.some(u => selectedActiveUsers.has(u._id)) &&
    !allVisibleActiveSelected

  useEffect(() => {
    if (activeHeaderCheckboxRef.current) {
      activeHeaderCheckboxRef.current.indeterminate = someVisibleActiveSelected
    }
  }, [someVisibleActiveSelected])

  function handleToggleSelectAllActive() {
    const nextMap = new Map(selectedActiveUsers)
    if (allVisibleActiveSelected) {
      for (const u of visibleActiveUsers) {
        nextMap.delete(u._id)
      }
    } else {
      for (const u of visibleActiveUsers) {
        nextMap.set(u._id, u)
      }
    }
    setSelectedActiveUsers(nextMap)
  }

  function handleToggleActiveUser(user: ActiveUser) {
    const nextMap = new Map(selectedActiveUsers)
    if (nextMap.has(user._id)) {
      nextMap.delete(user._id)
    } else {
      nextMap.set(user._id, user)
    }
    setSelectedActiveUsers(nextMap)
  }

  // Deleted Users Selection Handlers
  const visibleDeletedRecords = deletedData.deletedUsers
  const allVisibleDeletedSelected =
    visibleDeletedRecords.length > 0 &&
    visibleDeletedRecords.every(r => selectedDeletedUsers.has(r._id))
  const someVisibleDeletedSelected =
    visibleDeletedRecords.some(r => selectedDeletedUsers.has(r._id)) &&
    !allVisibleDeletedSelected

  useEffect(() => {
    if (deletedHeaderCheckboxRef.current) {
      deletedHeaderCheckboxRef.current.indeterminate =
        someVisibleDeletedSelected
    }
  }, [someVisibleDeletedSelected])

  function handleToggleSelectAllDeleted() {
    const nextMap = new Map(selectedDeletedUsers)
    if (allVisibleDeletedSelected) {
      for (const r of visibleDeletedRecords) {
        nextMap.delete(r._id)
      }
    } else {
      for (const r of visibleDeletedRecords) {
        nextMap.set(r._id, r)
      }
    }
    setSelectedDeletedUsers(nextMap)
  }

  function handleToggleDeletedRecord(record: DeletedUserRecord) {
    const nextMap = new Map(selectedDeletedUsers)
    if (nextMap.has(record._id)) {
      nextMap.delete(record._id)
    } else {
      nextMap.set(record._id, record)
    }
    setSelectedDeletedUsers(nextMap)
  }

  const currentTotal = tab === 'active' ? activeData.total : deletedData.total
  const currentTotalPages =
    tab === 'active' ? activeData.totalPages : deletedData.totalPages
  const selectedCount =
    tab === 'active' ? selectedActiveUsers.size : selectedDeletedUsers.size

  return (
    <div className="row">
      <div className="col-12">
        <OLCard>
          <div className="page-header">
            <h1>User Management</h1>
          </div>

          {successMessage ? (
            <Notification
              type="success"
              content={successMessage}
              className="mb-4"
            />
          ) : null}

          {error ? (
            <Notification type="error" content={error} className="mb-4" />
          ) : null}

          <div className="ol-tabs">
            <div className="nav-tabs-container">
              <ul className="nav nav-tabs align-left" role="tablist">
                <li role="presentation">
                  <button
                    type="button"
                    role="tab"
                    className={`nav-link ${tab === 'active' ? 'active' : ''}`}
                    aria-selected={tab === 'active'}
                    onClick={() => handleTabChange('active')}
                  >
                    Active Users ({activeData.total})
                  </button>
                </li>
                <li role="presentation">
                  <button
                    type="button"
                    role="tab"
                    className={`nav-link ${tab === 'deleted' ? 'active' : ''}`}
                    aria-selected={tab === 'deleted'}
                    onClick={() => handleTabChange('deleted')}
                  >
                    Deleted Users ({deletedData.total})
                  </button>
                </li>
              </ul>
            </div>

            <div className="tab-content">
              <div className="tab-pane active" role="tabpanel">
                <p className="text-muted mb-4">
                  {tab === 'active'
                    ? 'Manage all active and registered user accounts on this Overleaf instance.'
                    : 'Review soft-deleted user accounts, restore projects, or permanently purge accounts.'}
                </p>

                {/* Persistent Search and Action Controls */}
                <div className="d-flex justify-content-between align-items-center mb-3 flex-wrap gap-2">
                  <div className="col-md-6 col-lg-4">
                    <OLFormControl
                      type="search"
                      placeholder="Search users by name or email..."
                      value={searchInput}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                        setSearchInput(e.target.value)
                      }
                    />
                  </div>
                  {tab === 'active' ? (
                    <OLButton
                      variant="primary"
                      leadingIcon="person_add"
                      onClick={() => setShowCreateModal(true)}
                    >
                      Add new users
                    </OLButton>
                  ) : null}
                </div>

                {/* Dynamic Batch Actions Toolbar */}
                <BatchActionBar
                  selectedCount={selectedCount}
                  tab={tab}
                  onDeselectAll={() => {
                    if (tab === 'active') {
                      setSelectedActiveUsers(new Map())
                    } else {
                      setSelectedDeletedUsers(new Map())
                    }
                  }}
                  onRevokeSessions={() => setShowBatchRevokeModal(true)}
                  onDelete={() => setShowBatchDeleteModal(true)}
                  onRestore={() => setShowBatchRestoreModal(true)}
                  onPurge={() => setShowBatchPurgeModal(true)}
                />

                {isLoading ? (
                  <div className="text-center py-5">
                    <OLSpinner />
                  </div>
                ) : tab === 'active' ? (
                  <OLTable
                    container={false}
                    hover
                    className="mb-0 align-middle"
                    style={{ tableLayout: 'fixed' }}
                  >
                    <colgroup>
                      <col style={{ width: '40px' }} />
                      <col style={{ width: '28%' }} />
                      <col style={{ width: '18%' }} />
                      <col style={{ width: '12%' }} />
                      <col style={{ width: '12%' }} />
                      <col style={{ width: '14%' }} />
                      <col style={{ width: '16%' }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th style={{ width: '40px' }}>
                          <OLFormCheckbox
                            ref={activeHeaderCheckboxRef}
                            autoComplete="off"
                            checked={allVisibleActiveSelected}
                            onChange={handleToggleSelectAllActive}
                            aria-label="Select all active users on page"
                          />
                        </th>
                        <th>Email</th>
                        <th>Name</th>
                        <th>Role</th>
                        <th>Registered</th>
                        <th>Last Active</th>
                        <th className="text-end">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeData.users.length === 0 ? (
                        <tr>
                          <td
                            colSpan={7}
                            className="text-center py-4 text-muted"
                          >
                            No active users found.
                          </td>
                        </tr>
                      ) : (
                        activeData.users.map(user => {
                          const fullName = [user.first_name, user.last_name]
                            .filter(Boolean)
                            .join(' ')
                          const isSelected = selectedActiveUsers.has(user._id)

                          return (
                            <tr
                              key={user._id}
                              className={isSelected ? 'table-active' : ''}
                            >
                              <td style={{ width: '40px' }}>
                                <OLFormCheckbox
                                  autoComplete="off"
                                  checked={isSelected}
                                  onChange={() => handleToggleActiveUser(user)}
                                  aria-label={`Select user ${user.email}`}
                                />
                              </td>
                              <td className="text-truncate">
                                <a
                                  href={`/admin/users/${user._id}`}
                                  className="fw-bold text-decoration-none"
                                >
                                  {user.email}
                                </a>
                              </td>
                              <td className="text-truncate">
                                {fullName || (
                                  <span className="text-muted">—</span>
                                )}
                              </td>
                              <td>
                                <UserStatusBadge
                                  isAdmin={user.isAdmin}
                                  suspended={user.suspended}
                                  holdingAccount={user.holdingAccount}
                                />
                              </td>
                              <td>
                                {user.signUpDate
                                  ? new Date(
                                      user.signUpDate
                                    ).toLocaleDateString()
                                  : '—'}
                              </td>
                              <td>
                                {user.lastActive || user.lastLoggedIn
                                  ? new Date(
                                      user.lastActive || user.lastLoggedIn!
                                    ).toLocaleDateString()
                                  : 'Never'}
                              </td>
                              <td className="text-end">
                                <Dropdown
                                  as={OLButtonGroup}
                                  align="end"
                                  size="sm"
                                >
                                  <OLButton
                                    href={`/admin/users/${user._id}`}
                                    variant="secondary"
                                    size="sm"
                                  >
                                    Manage
                                  </OLButton>
                                  <DropdownToggle
                                    split
                                    variant="secondary"
                                    size="sm"
                                    id={`active-user-actions-${user._id}`}
                                    aria-label="More actions"
                                  />
                                  <DropdownMenu className="dropdown-menu-sm-width">
                                    <li role="none">
                                      <DropdownItem
                                        as="button"
                                        onClick={() => handleToggleAdmin(user)}
                                        leadingIcon={
                                          user.isAdmin
                                            ? 'remove_moderator'
                                            : 'shield'
                                        }
                                      >
                                        {user.isAdmin
                                          ? 'Revoke Site Admin'
                                          : 'Grant Site Admin'}
                                      </DropdownItem>
                                    </li>
                                    <li role="none">
                                      <DropdownItem
                                        as="button"
                                        onClick={() =>
                                          setUserToRevokeSessions(user)
                                        }
                                        leadingIcon="logout"
                                      >
                                        Revoke All Sessions
                                      </DropdownItem>
                                    </li>
                                    <li role="none">
                                      <DropdownItem
                                        as="button"
                                        variant="danger"
                                        onClick={() => setUserToDelete(user)}
                                        leadingIcon="delete"
                                      >
                                        Delete Account
                                      </DropdownItem>
                                    </li>
                                  </DropdownMenu>
                                </Dropdown>
                              </td>
                            </tr>
                          )
                        })
                      )}
                    </tbody>
                  </OLTable>
                ) : (
                  <OLTable
                    container={false}
                    hover
                    className="mb-0 align-middle"
                    style={{ tableLayout: 'fixed' }}
                  >
                    <colgroup>
                      <col style={{ width: '40px' }} />
                      <col style={{ width: '30%' }} />
                      <col style={{ width: '20%' }} />
                      <col style={{ width: '34%' }} />
                      <col style={{ width: '16%' }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th style={{ width: '40px' }}>
                          <OLFormCheckbox
                            ref={deletedHeaderCheckboxRef}
                            autoComplete="off"
                            checked={allVisibleDeletedSelected}
                            onChange={handleToggleSelectAllDeleted}
                            aria-label="Select all deleted users on page"
                          />
                        </th>
                        <th>Email</th>
                        <th>Name</th>
                        <th>Deleted At</th>
                        <th className="text-end">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {deletedData.deletedUsers.length === 0 ? (
                        <tr>
                          <td
                            colSpan={5}
                            className="text-center py-4 text-muted"
                          >
                            No soft-deleted users found.
                          </td>
                        </tr>
                      ) : (
                        deletedData.deletedUsers.map(record => {
                          const email = record.user?.email || '—'
                          const fullName = [
                            record.user?.first_name,
                            record.user?.last_name,
                          ]
                            .filter(Boolean)
                            .join(' ')
                          const deletedAt = record.deleterData?.deletedAt
                            ? new Date(
                                record.deleterData.deletedAt
                              ).toLocaleDateString()
                            : '—'
                          const isSelected = selectedDeletedUsers.has(
                            record._id
                          )

                          return (
                            <tr
                              key={record._id}
                              className={isSelected ? 'table-active' : ''}
                            >
                              <td style={{ width: '40px' }}>
                                <OLFormCheckbox
                                  autoComplete="off"
                                  checked={isSelected}
                                  onChange={() =>
                                    handleToggleDeletedRecord(record)
                                  }
                                  aria-label={`Select deleted user ${email}`}
                                />
                              </td>
                              <td className="fw-bold text-truncate">
                                {email}
                              </td>
                              <td className="text-truncate">
                                {fullName || (
                                  <span className="text-muted">—</span>
                                )}
                              </td>
                              <td>{deletedAt}</td>
                              <td className="text-end">
                                <Dropdown
                                  as={OLButtonGroup}
                                  align="end"
                                  size="sm"
                                >
                                  <OLButton
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => setUserToRestore(record)}
                                  >
                                    Restore
                                  </OLButton>
                                  <DropdownToggle
                                    split
                                    variant="secondary"
                                    size="sm"
                                    id={`deleted-user-actions-${record._id}`}
                                    aria-label="More actions"
                                  />
                                  <DropdownMenu className="dropdown-menu-sm-width">
                                    <li role="none">
                                      <DropdownItem
                                        as="button"
                                        variant="danger"
                                        onClick={() => setUserToPurge(record)}
                                        leadingIcon="delete_forever"
                                      >
                                        Delete Permanently
                                      </DropdownItem>
                                    </li>
                                  </DropdownMenu>
                                </Dropdown>
                              </td>
                            </tr>
                          )
                        })
                      )}
                    </tbody>
                  </OLTable>
                )}

                {currentTotalPages > 1 ? (
                  <div className="p-3 border-top d-flex justify-content-between align-items-center">
                    <div className="text-muted small">
                      Showing page {page} of {currentTotalPages} ({currentTotal}{' '}
                      total)
                    </div>
                    <Pagination
                      currentPage={page}
                      totalPages={currentTotalPages}
                      handlePageClick={handlePageClick}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </OLCard>

        {/* Single Item Modals */}
        <RestoreUserModal
          show={userToRestore !== null}
          user={userToRestore}
          onHide={() => setUserToRestore(null)}
          onSuccess={handleRestoreSuccess}
        />

        <PurgeDeletedUserModal
          show={userToPurge !== null}
          userRecord={userToPurge}
          onHide={() => setUserToPurge(null)}
          onSuccess={handlePurgeSuccess}
        />

        <CreateUsersModal
          show={showCreateModal}
          onHide={() => setShowCreateModal(false)}
          onSuccess={handleCreateSuccess}
        />

        {userToDelete ? (
          <DeleteUserModal
            show={userToDelete !== null}
            userId={userToDelete._id}
            userEmail={userToDelete.email}
            onHide={() => setUserToDelete(null)}
            onSuccess={() => {
              setUserToDelete(null)
              setSuccessMessage(
                `Account ${userToDelete.email} successfully deleted.`
              )
              fetchData()
            }}
          />
        ) : null}

        {userToRevokeSessions ? (
          <RevokeSessionsModal
            show={userToRevokeSessions !== null}
            userId={userToRevokeSessions._id}
            userEmail={userToRevokeSessions.email}
            isSelf={Boolean(
              currentUserId && currentUserId === userToRevokeSessions._id
            )}
            onHide={() => setUserToRevokeSessions(null)}
            onSuccess={count => {
              setUserToRevokeSessions(null)
              setSuccessMessage(
                `Successfully revoked ${count} active session(s) for ${userToRevokeSessions.email}.`
              )
            }}
          />
        ) : null}

        {/* Batch Action Modals */}
        {showBatchDeleteModal ? (
          <BatchDeleteUsersModal
            show={showBatchDeleteModal}
            users={Array.from(selectedActiveUsers.values())}
            onHide={() => setShowBatchDeleteModal(false)}
            onSuccess={count => {
              setShowBatchDeleteModal(false)
              setSelectedActiveUsers(new Map())
              setSuccessMessage(
                `Successfully deleted ${count} selected account(s).`
              )
              fetchData()
            }}
          />
        ) : null}

        {showBatchRevokeModal ? (
          <BatchRevokeSessionsModal
            show={showBatchRevokeModal}
            users={Array.from(selectedActiveUsers.values())}
            onHide={() => setShowBatchRevokeModal(false)}
            onSuccess={count => {
              setShowBatchRevokeModal(false)
              setSelectedActiveUsers(new Map())
              setSuccessMessage(
                `Successfully revoked sessions for ${count} selected user(s).`
              )
            }}
          />
        ) : null}

        {showBatchRestoreModal ? (
          <BatchRestoreUsersModal
            show={showBatchRestoreModal}
            records={Array.from(selectedDeletedUsers.values())}
            onHide={() => setShowBatchRestoreModal(false)}
            onSuccess={(count, pCount) => {
              setShowBatchRestoreModal(false)
              setSelectedDeletedUsers(new Map())
              setSuccessMessage(
                `Successfully restored ${count} user account(s) and ${pCount} project(s).`
              )
              fetchData()
            }}
          />
        ) : null}

        {showBatchPurgeModal ? (
          <BatchPurgeUsersModal
            show={showBatchPurgeModal}
            records={Array.from(selectedDeletedUsers.values())}
            onHide={() => setShowBatchPurgeModal(false)}
            onSuccess={count => {
              setShowBatchPurgeModal(false)
              setSelectedDeletedUsers(new Map())
              setSuccessMessage(
                `Successfully purged ${count} deleted user record(s) permanently.`
              )
              fetchData()
            }}
          />
        ) : null}
      </div>
    </div>
  )
}
