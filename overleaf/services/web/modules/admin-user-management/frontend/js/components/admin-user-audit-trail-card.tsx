import { useState, useEffect } from 'react'
import OLCard from '@/shared/components/ol/ol-card'
import OLButton from '@/shared/components/ol/ol-button'
import OLBadge from '@/shared/components/ol/ol-badge'
import OLSpinner from '@/shared/components/ol/ol-spinner'
import Notification from '@/shared/components/notification'
import MaterialIcon from '@/shared/components/material-icon'
import { getJSON } from '@/infrastructure/fetch-json'
import { fromNowDate } from '@/utils/dates'

export interface AuditLogEntry {
  _id: string
  userId: string
  operation: string
  initiatorId?: string
  initiator?: { name: string; email: string } | null
  ipAddress?: string
  info?: Record<string, any>
  timestamp?: string | Date
  createdAt?: string | Date
}

function getEntryDate(log: AuditLogEntry): Date | null {
  if (log.timestamp) {
    const d = new Date(log.timestamp)
    if (!isNaN(d.getTime())) return d
  }
  if (log.createdAt) {
    const d = new Date(log.createdAt)
    if (!isNaN(d.getTime())) return d
  }
  if (log._id && /^[0-9a-fA-F]{24}$/.test(log._id)) {
    const ts = parseInt(log._id.substring(0, 8), 16) * 1000
    const d = new Date(ts)
    if (!isNaN(d.getTime())) return d
  }
  return null
}

export interface AdminUserAuditTrailCardProps {
  userId: string
}

const OPERATION_BADGES: Record<string, { label: string; bg: string }> = {
  login: { label: 'Login', bg: 'success' },
  logout: { label: 'Logout', bg: 'dark' },
  'failed-password-match': { label: 'Failed Login', bg: 'danger' },
  'reset-password': { label: 'Password Reset', bg: 'warning' },
  'update-password': { label: 'Password Changed', bg: 'warning' },
  'must-reset-password-unset': { label: 'Reset Flag Cleared', bg: 'info' },
  'add-email': { label: 'Email Added', bg: 'info' },
  'add-email-auto-confirmed': { label: 'Email Added', bg: 'info' },
  'add-email-via-code': { label: 'Email Added', bg: 'info' },
  'request-add-email-code': { label: 'Email Code Requested', bg: 'info' },
  'confirm-email': { label: 'Email Confirmed', bg: 'success' },
  'confirm-email-via-code': { label: 'Email Confirmed', bg: 'success' },
  'remove-email': { label: 'Email Removed', bg: 'warning' },
  'change-primary-email': { label: 'Primary Email Changed', bg: 'info' },
  'set-default-email': { label: 'Primary Email Changed', bg: 'info' },
  'migrate-default-email': { label: 'Primary Email Migrated', bg: 'info' },
  'clear-sessions': { label: 'Sessions Cleared', bg: 'danger' },
  'link-sso': { label: 'SSO Linked', bg: 'info' },
  'unlink-sso': { label: 'SSO Unlinked', bg: 'warning' },
  'link-github': { label: 'GitHub Linked', bg: 'info' },
  'unlink-github': { label: 'GitHub Unlinked', bg: 'warning' },
  'clear-institution-sso-data': { label: 'SSO Data Cleared', bg: 'warning' },
  'clear-third-party-identifiers': {
    label: 'Identities Cleared',
    bg: 'warning',
  },
  'accept-group-invitation': {
    label: 'Group Invite Accepted',
    bg: 'success',
  },
  'join-group-subscription': { label: 'Joined Group', bg: 'success' },
  'leave-group-subscription': { label: 'Left Group', bg: 'warning' },
  'remove-from-group-subscription': {
    label: 'Removed From Group',
    bg: 'warning',
  },
  'account-suspension': { label: 'Account Suspended', bg: 'danger' },
  'ai-quota-breach': { label: 'AI Quota Exceeded', bg: 'warning' },
  'admin-set-admin-status': { label: 'Admin Access', bg: 'primary' },
  'admin-revoked-sessions': { label: 'Sessions Revoked', bg: 'danger' },
  'admin-revoke-sessions': { label: 'Sessions Revoked', bg: 'danger' },
  'admin-added-email': { label: 'Email Added', bg: 'info' },
  'admin-removed-email': { label: 'Email Removed', bg: 'warning' },
  'admin-set-primary-email': { label: 'Primary Email Changed', bg: 'info' },
  'admin-register': { label: 'Account Created', bg: 'success' },
  register: { label: 'Account Created', bg: 'success' },
  'transfer-project': { label: 'Project Transferred', bg: 'info' },
  'delete-account': { label: 'Account Deleted', bg: 'danger' },
  'restore-account': { label: 'Account Restored', bg: 'success' },
  'admin-restore-user': { label: 'Account Restored', bg: 'success' },
  'admin-update-user': { label: 'Profile Updated', bg: 'info' },
  'admin-generate-password-reset': {
    label: 'Password Reset Link',
    bg: 'primary',
  },
}

function humanize(key: string) {
  const text = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .trim()
    .toLowerCase()
  return text.charAt(0).toUpperCase() + text.slice(1)
}

// Fields that carry no meaning for an admin reading the trail
const HIDDEN_INFO_KEYS = new Set(['captcha', 'token', 'script'])

function getVisibleInfo(info: AuditLogEntry['info']): [string, unknown][] {
  if (!info || typeof info !== 'object') return []
  return Object.entries(info).filter(
    ([key, value]) =>
      !HIDDEN_INFO_KEYS.has(key) &&
      !(key === 'method' && value === 'Password login')
  )
}

function formatInfoValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (Array.isArray(value)) {
    return value.some(item => item && typeof item === 'object')
      ? String(value.length)
      : value.map(formatInfoValue).join(', ')
  }
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([k, v]) => `${humanize(k)}: ${formatInfoValue(v)}`)
      .join(', ')
  }
  return String(value)
}

function renderBadge(operation: string) {
  const badge = OPERATION_BADGES[operation]
  return (
    <OLBadge bg={badge?.bg ?? 'dark'} title={operation}>
      {badge?.label ?? humanize(operation)}
    </OLBadge>
  )
}

export default function AdminUserAuditTrailCard({
  userId,
}: AdminUserAuditTrailCardProps) {
  const [logs, setLogs] = useState<AuditLogEntry[]>([])
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let isCancelled = false

    async function fetchLogs() {
      if (page === 1) {
        setIsLoading(true)
      } else {
        setIsLoadingMore(true)
      }
      setError(null)

      try {
        const res = await getJSON<{
          auditLogs: AuditLogEntry[]
          total: number
          page: number
          totalPages: number
        }>(`/admin/users/api/users/${userId}/audit-logs?page=${page}&limit=10`)

        if (!isCancelled) {
          setLogs(prev =>
            page === 1 ? res.auditLogs || [] : [...prev, ...(res.auditLogs || [])]
          )
          setTotal(res.total ?? 0)
          setTotalPages(res.totalPages ?? 1)
        }
      } catch (err: any) {
        if (!isCancelled) {
          setError(err?.message || 'Failed to load audit logs')
        }
      } finally {
        if (!isCancelled) {
          setIsLoading(false)
          setIsLoadingMore(false)
        }
      }
    }

    fetchLogs()

    return () => {
      isCancelled = true
    }
  }, [userId, page])

  return (
    <OLCard className="mb-4">
      <div className="d-flex align-items-center gap-2 mb-3">
        <h2 className="h4 my-0">Security Audit Trail</h2>
        {total > 0 ? (
          <OLBadge bg="info">{total} Events</OLBadge>
        ) : (
          <OLBadge bg="light" text="dark" className="border">
            0 Events
          </OLBadge>
        )}
      </div>

      <div>
        {error ? (
          <Notification type="error" content={error} className="mb-3" />
        ) : null}

        {isLoading && logs.length === 0 ? (
          <div className="py-4 text-center">
            <OLSpinner />
          </div>
        ) : logs.length === 0 ? (
          <p className="text-muted small mb-0">
            No audit trail events recorded for this user.
          </p>
        ) : (
          <>
            <ul className="list-group list-group-flush border rounded mb-0">
              {logs.map(log => {
                const infoEntries = getVisibleInfo(log.info)
                const showInitiator =
                  log.initiatorId && log.initiatorId !== userId

                const logDate = getEntryDate(log)

                return (
                  <li
                    key={log._id}
                    className="list-group-item flex-column align-items-stretch gap-1 py-2 px-3"
                  >
                    <div className="d-flex justify-content-between align-items-center flex-wrap gap-2">
                      <div className="d-flex align-items-center gap-3 flex-wrap">
                        {renderBadge(log.operation)}
                        <span
                          className="small text-muted d-inline-flex align-items-center"
                          title="IP address"
                        >
                          <MaterialIcon
                            type="public"
                            className="me-1"
                            style={{ fontSize: '14px' }}
                          />
                          <span className="font-monospace">
                            {log.ipAddress || '—'}
                          </span>
                        </span>
                        {showInitiator ? (
                          <span
                            className="small text-muted d-inline-flex align-items-center"
                            title={log.initiator?.email ?? log.initiatorId}
                          >
                            <MaterialIcon
                              type="person"
                              className="me-1"
                              style={{ fontSize: '14px' }}
                            />
                            by{' '}
                            {log.initiator?.name ||
                              log.initiator?.email ||
                              'Deleted user'}
                          </span>
                        ) : null}
                      </div>

                      <div className="text-muted small text-nowrap">
                        {logDate ? (
                          <span title={logDate.toLocaleString()}>
                            {logDate.toLocaleString()} ·{' '}
                            {fromNowDate(logDate)}
                          </span>
                        ) : (
                          '—'
                        )}
                      </div>
                    </div>

                    {infoEntries.length > 0 ? (
                      <div className="d-flex flex-wrap column-gap-3 small">
                        {infoEntries.map(([key, value]) => (
                          <span key={key}>
                            <span className="text-muted">
                              {humanize(key)}:
                            </span>{' '}
                            {formatInfoValue(value)}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ul>

            {page < totalPages ? (
              <div className="text-center mt-3">
                <OLButton
                  variant="secondary"
                  size="sm"
                  onClick={() => setPage(p => p + 1)}
                  isLoading={isLoadingMore}
                  loadingLabel="Loading more history..."
                >
                  Load More History
                </OLButton>
              </div>
            ) : null}
          </>
        )}
      </div>
    </OLCard>
  )
}
