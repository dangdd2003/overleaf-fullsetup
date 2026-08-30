import { useState, useEffect, useCallback } from 'react'
import OLCard from '@/shared/components/ol/ol-card'
import OLButton from '@/shared/components/ol/ol-button'
import OLRow from '@/shared/components/ol/ol-row'
import OLCol from '@/shared/components/ol/ol-col'
import OLForm from '@/shared/components/ol/ol-form'
import OLFormGroup from '@/shared/components/ol/ol-form-group'
import OLFormLabel from '@/shared/components/ol/ol-form-label'
import OLFormControl from '@/shared/components/ol/ol-form-control'
import OLFormCheckbox from '@/shared/components/ol/ol-form-checkbox'
import OLSpinner from '@/shared/components/ol/ol-spinner'
import OLBadge from '@/shared/components/ol/ol-badge'
import Notification from '@/shared/components/notification'
import MaterialIcon from '@/shared/components/material-icon'
import getMeta from '@/utils/meta'
import { getJSON, postJSON } from '@/infrastructure/fetch-json'
import UserStatusBadge from './user-status-badge'
import DeleteUserModal from './delete-user-modal'
import AdminUserEmailsCard from './admin-user-emails-card'
import AdminUserSessionsCard from './admin-user-sessions-card'
import AdminUserProjectsCard from './admin-user-projects-card'
import AdminUserAuditTrailCard from './admin-user-audit-trail-card'
import { copyTextToClipboard } from '../utils/clipboard'

interface UserDetail {
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
  loginCount?: number
  role?: string
  institution?: string
  emails?: Array<{
    email: string
    confirmedAt?: string | Date
    createdAt?: string
    default?: boolean
  }>
}

export default function AdminUserDetailPage() {
  const targetUserId = getMeta('ol-target-user-id') as string

  const [user, setUser] = useState<UserDetail | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  // Profile Form state
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [isSavingProfile, setIsSavingProfile] = useState(false)

  // Admin Toggle Form state
  const [isAdmin, setIsAdmin] = useState(false)
  const [isSavingAdmin, setIsSavingAdmin] = useState(false)

  // Password reset link state
  const [resetLink, setResetLink] = useState<string | null>(null)
  const [resetLinkExpiresAt, setResetLinkExpiresAt] = useState<string | null>(null)
  const [isGeneratingReset, setIsGeneratingReset] = useState(false)
  const [copiedLink, setCopiedLink] = useState(false)

  // Delete Modal state
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [retentionDays, setRetentionDays] = useState(90)

  const fetchUser = useCallback(async () => {
    if (!targetUserId) {
      setError('No target user ID provided')
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    setError(null)
    try {
      const res = await getJSON<{
        user: UserDetail
        config?: { retentionDays?: number }
      }>(`/admin/users/api/users/${targetUserId}`)
      setUser(res.user)
      setFirstName(res.user.first_name || '')
      setLastName(res.user.last_name || '')
      setIsAdmin(Boolean(res.user.isAdmin))
      if (res.config?.retentionDays) {
        setRetentionDays(res.config.retentionDays)
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to load user details')
    } finally {
      setIsLoading(false)
    }
  }, [targetUserId])

  const handleError = useCallback((err: string) => setError(err), [])
  const handleSuccess = useCallback(
    (msg: string) => setSuccessMessage(msg),
    []
  )

  useEffect(() => {
    fetchUser()
  }, [fetchUser])

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault()
    setIsSavingProfile(true)
    setError(null)
    setSuccessMessage(null)
    try {
      const res = await postJSON<{ success: boolean; user: UserDetail; error?: string }>(
        `/admin/users/api/users/${targetUserId}/profile`,
        {
          body: {
            first_name: firstName,
            last_name: lastName,
          },
        }
      )
      if (res.error) {
        setError(res.error)
      } else {
        setUser(res.user)
        setSuccessMessage('Profile information saved successfully.')
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to update profile')
    } finally {
      setIsSavingProfile(false)
    }
  }

  async function handleSaveAdmin(e: React.FormEvent) {
    e.preventDefault()
    setIsSavingAdmin(true)
    setError(null)
    setSuccessMessage(null)
    try {
      const res = await postJSON<{ success: boolean; isAdmin: boolean; error?: string }>(
        `/admin/users/api/users/${targetUserId}/admin`,
        {
          body: {
            isAdmin,
          },
        }
      )
      if (res.error) {
        setError(res.error)
      } else {
        setIsAdmin(res.isAdmin)
        if (user) {
          setUser({ ...user, isAdmin: res.isAdmin })
        }
        setSuccessMessage(
          `Administrator permissions ${res.isAdmin ? 'granted' : 'revoked'} successfully.`
        )
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to update admin permissions')
    } finally {
      setIsSavingAdmin(false)
    }
  }

  async function handleGenerateResetLink() {
    setIsGeneratingReset(true)
    setError(null)
    setResetLink(null)
    setCopiedLink(false)
    try {
      const res = await postJSON<{ resetUrl: string; expiresAt: string; error?: string }>(
        `/admin/users/api/users/${targetUserId}/password-reset-link`,
        { body: {} }
      )
      if (res.error) {
        setError(res.error)
      } else {
        setResetLink(res.resetUrl)
        setResetLinkExpiresAt(res.expiresAt)
        setSuccessMessage('Password reset link generated successfully.')
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to generate reset link')
    } finally {
      setIsGeneratingReset(false)
    }
  }

  function handleCopyLink() {
    if (resetLink) {
      copyTextToClipboard(resetLink)
      setCopiedLink(true)
      setTimeout(() => setCopiedLink(false), 3000)
    }
  }

  function handleDeleteSuccess() {
    window.location.href = '/admin/users'
  }

  if (isLoading) {
    return (
      <div className="py-5 text-center">
        <OLSpinner />
      </div>
    )
  }

  if (!user) {
    return (
      <div className="py-4">
        <Notification
          type="error"
          content={error || 'User account not found.'}
          className="mb-4"
        />
        <OLButton
          href="/admin/users"
          variant="secondary"
          className="d-inline-flex align-items-center gap-2"
        >
          <MaterialIcon type="arrow_back" />
          <span>Back to user directory</span>
        </OLButton>
      </div>
    )
  }

  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ')
  const currentUserId = getMeta('ol-user_id') as string | undefined
  const isSelf = Boolean(currentUserId && currentUserId === user._id)

  return (
    <div className="row">
      <div className="col-12">
        {/* Breadcrumb & Navigation */}
      <div className="mb-3">
        <a
          href="/admin/users"
          className="text-decoration-none text-muted d-inline-flex align-items-center gap-2 fw-medium"
        >
          <MaterialIcon type="arrow_back" />
          <span>Back to Manage Users</span>
        </a>
      </div>

      {/* User Header */}
      <div className="page-header d-flex justify-content-between align-items-center mb-4 flex-wrap gap-2">
        <div>
          <div className="d-flex align-items-center gap-3">
            <h1 className="mb-0">{fullName || user.email}</h1>
            <UserStatusBadge
              isAdmin={user.isAdmin}
              suspended={user.suspended}
              holdingAccount={user.holdingAccount}
            />
          </div>
          <p className="text-muted mb-0 mt-1">{user.email}</p>
        </div>
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

      <OLRow className="g-4">
        {/* Left Column: Profile & Admin Controls */}
        <OLCol lg={7}>
          {/* Card 1: Profile Info */}
          <OLCard className="mb-4">
            <div className="card-header bg-transparent py-3 px-3">
              <h2 className="h4 mb-0">Profile Information</h2>
            </div>
            <div className="card-body">
              <OLForm onSubmit={handleSaveProfile}>
                <OLRow className="g-3 mb-3">
                  <OLCol md={6}>
                    <OLFormGroup>
                      <OLFormLabel htmlFor="first-name">First Name</OLFormLabel>
                      <OLFormControl
                        id="first-name"
                        type="text"
                        value={firstName}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                          setFirstName(e.target.value)
                        }
                      />
                    </OLFormGroup>
                  </OLCol>
                  <OLCol md={6}>
                    <OLFormGroup>
                      <OLFormLabel htmlFor="last-name">Last Name</OLFormLabel>
                      <OLFormControl
                        id="last-name"
                        type="text"
                        value={lastName}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                          setLastName(e.target.value)
                        }
                      />
                    </OLFormGroup>
                  </OLCol>
                </OLRow>

                <div className="d-flex justify-content-end mb-3">
                  <OLButton
                    type="submit"
                    variant="primary"
                    isLoading={isSavingProfile}
                    loadingLabel="Saving..."
                  >
                    Save profile changes
                  </OLButton>
                </div>
              </OLForm>

              <hr className="my-4" />

              <AdminUserEmailsCard
                userId={user._id}
                primaryEmail={user.email}
                emails={user.emails}
                onUserUpdated={(updatedUser: UserDetail) => setUser(updatedUser)}
                onError={(err: string) => setError(err)}
                onSuccess={(msg: string) => setSuccessMessage(msg)}
              />
            </div>
          </OLCard>

          {/* Card 2: Site Administrator Privileges */}
          <OLCard className="mb-4">
            <div className="card-header bg-transparent py-3 px-3">
              <h2 className="h4 mb-0">Site Administrator Access</h2>
            </div>
            <div className="card-body">
              <OLForm onSubmit={handleSaveAdmin}>
                <div className="mb-3">
                  <OLFormCheckbox
                    id="is-site-admin"
                    type="checkbox"
                    label="Grant Site Administrator Privileges"
                    checked={isAdmin}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setIsAdmin(e.target.checked)
                    }
                  />
                  <small className="text-muted d-block mt-2">
                    Site administrators have complete administrative control over
                    all projects, server settings, maintenance modes, and user
                    accounts on this Overleaf instance.
                  </small>
                </div>

                <div className="d-flex justify-content-end">
                  <OLButton
                    type="submit"
                    variant="primary"
                    isLoading={isSavingAdmin}
                    loadingLabel="Updating..."
                  >
                    Save permissions
                  </OLButton>
                </div>
              </OLForm>
            </div>
          </OLCard>
        </OLCol>

        {/* Right Column: Password Reset & Account Metadata */}
        <OLCol lg={5}>
          {/* Card 3: Password Management */}
          <OLCard className="mb-4">
            <div className="card-header bg-transparent py-3 px-3">
              <h2 className="h4 mb-0">Password Management</h2>
            </div>
            <div className="card-body">
              <p className="text-muted small mb-3">
                Generate a single-use, 7-day password setup link to send directly
                to this user.
              </p>

              <OLButton
                variant="secondary"
                onClick={handleGenerateResetLink}
                isLoading={isGeneratingReset}
                loadingLabel="Generating..."
                className="w-100 mb-3"
              >
                Generate Password Reset Link
              </OLButton>

              {resetLink ? (
                <div className="mt-3">
                  <span className="form-label small fw-bold text-muted d-block mb-1">
                    Password Setup URL:
                  </span>
                  <div className="git-bridge-copy my-2 d-flex align-items-center justify-content-between">
                    <code
                      id="admin-user-password-reset-url"
                      aria-label="Password Reset URL"
                      style={{
                        minWidth: 0,
                        flex: '1 1 auto',
                        wordBreak: 'break-all',
                      }}
                    >
                      {resetLink}
                    </code>
                    <button
                      type="button"
                      className="git-copy-pill-btn"
                      style={{
                        minWidth: '78px',
                        width: '78px',
                        flexShrink: 0,
                        textAlign: 'center',
                      }}
                      onClick={handleCopyLink}
                      aria-label={copiedLink ? 'Copied' : 'Copy'}
                    >
                      {copiedLink ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  {resetLinkExpiresAt ? (
                    <small className="text-muted d-block mt-1">
                      Expires:{' '}
                      {new Date(resetLinkExpiresAt).toLocaleDateString()}
                    </small>
                  ) : null}
                </div>
              ) : null}
            </div>
          </OLCard>

          {/* Card: Active Sessions */}
          <AdminUserSessionsCard
            userId={user._id}
            userEmail={user.email}
            isSelf={isSelf}
            onError={handleError}
            onSuccess={handleSuccess}
          />

          {/* Account Metadata Summary Card */}
          <OLCard className="mb-4">
            <div className="card-header bg-transparent py-3 px-3">
              <h2 className="h4 mb-0">Account Metadata</h2>
            </div>
            <div className="card-body">
              <dl className="row mb-0 small">
                <dt className="col-sm-5 text-muted">User ID:</dt>
                <dd className="col-sm-7 font-monospace text-truncate">
                  {user._id}
                </dd>

                <dt className="col-sm-5 text-muted">Signed Up:</dt>
                <dd className="col-sm-7">
                  {user.signUpDate
                    ? new Date(user.signUpDate).toLocaleString()
                    : '—'}
                </dd>

                <dt className="col-sm-5 text-muted">Last Active:</dt>
                <dd className="col-sm-7">
                  {user.lastActive || user.lastLoggedIn
                    ? new Date(user.lastActive || user.lastLoggedIn!).toLocaleString()
                    : 'Never'}
                </dd>

                <dt className="col-sm-5 text-muted">Total Logins:</dt>
                <dd className="col-sm-7">{user.loginCount || 0}</dd>

                <dt className="col-sm-5 text-muted">Affiliation:</dt>
                <dd className="col-sm-7">
                  {user.institution || user.role || '—'}
                </dd>
              </dl>
            </div>
          </OLCard>

          {/* Card 4: Danger Zone */}
          <OLCard className="border-danger">
            <div className="card-header bg-danger text-white py-3 px-3">
              <h2 className="h4 mb-0 text-white">Danger Zone</h2>
            </div>
            <div className="card-body">
              <p className="small text-muted mb-3">
                Soft-deleting this account will archive all projects owned by the
                user and revoke all active login sessions.
              </p>
              <OLButton
                variant="danger"
                className="w-100"
                onClick={() => setShowDeleteModal(true)}
              >
                Delete User Account
              </OLButton>
            </div>
          </OLCard>
        </OLCol>
      </OLRow>

      {/* Owned Projects Section */}
      <OLRow className="mt-4">
        <OLCol xs={12}>
          <AdminUserProjectsCard
            userId={user._id}
            userEmail={user.email}
            onError={handleError}
            onSuccess={handleSuccess}
          />
        </OLCol>
      </OLRow>

      {/* Security Audit Trail Section */}
      <OLRow className="mt-4">
        <OLCol xs={12}>
          <AdminUserAuditTrailCard userId={targetUserId} />
        </OLCol>
      </OLRow>

      {/* Delete Confirmation Modal */}
      <DeleteUserModal
        show={showDeleteModal}
        userId={user._id}
        userEmail={user.email}
        retentionDays={retentionDays}
        onHide={() => setShowDeleteModal(false)}
        onSuccess={handleDeleteSuccess}
      />
      </div>
    </div>
  )
}
