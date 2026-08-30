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

function renderBadge(operation: string) {
  switch (operation) {
    case 'admin-set-admin-status':
      return <OLBadge bg="primary">Admin Access</OLBadge>
    case 'admin-revoked-sessions':
    case 'admin-revoke-sessions':
      return <OLBadge bg="danger">Sessions Revoked</OLBadge>
    case 'admin-added-email':
      return <OLBadge bg="info">Email Added</OLBadge>
    case 'admin-removed-email':
      return <OLBadge bg="warning">Email Removed</OLBadge>
    case 'admin-set-primary-email':
      return <OLBadge bg="info">Primary Email Changed</OLBadge>
    case 'admin-register':
    case 'register':
      return <OLBadge bg="success">Account Created</OLBadge>
    case 'transfer-project':
      return <OLBadge bg="info">Project Transferred</OLBadge>
    case 'delete-account':
      return <OLBadge bg="danger">Account Deleted</OLBadge>
    case 'restore-account':
      return <OLBadge bg="success">Account Restored</OLBadge>
    case 'admin-update-user':
      return <OLBadge bg="info">Profile Updated</OLBadge>
    case 'admin-generate-password-reset':
      return <OLBadge bg="primary">Password Reset Link</OLBadge>
    default:
      return (
        <OLBadge bg="light" text="dark" className="border">
          {operation}
        </OLBadge>
      )
  }
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
      <div className="card-header bg-transparent py-3 px-3 d-flex justify-content-between align-items-center flex-wrap gap-2">
        <div className="d-flex align-items-center gap-2">
          <h2 className="h4 mb-0">Security Audit Trail</h2>
          {total > 0 ? (
            <OLBadge bg="info">{total} Events</OLBadge>
          ) : (
            <OLBadge bg="light" text="dark" className="border">
              0 Events
            </OLBadge>
          )}
        </div>
      </div>

      <div className="card-body">
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
                const hasInfo =
                  log.info &&
                  typeof log.info === 'object' &&
                  Object.keys(log.info).length > 0

                const logDate = getEntryDate(log)

                return (
                  <li key={log._id} className="list-group-item py-3">
                    <div className="d-flex justify-content-between align-items-start flex-wrap gap-2 mb-2">
                      <div className="d-flex align-items-center gap-2 flex-wrap">
                        {renderBadge(log.operation)}
                        <span className="font-monospace small text-muted d-inline-flex align-items-center">
                          <MaterialIcon
                            type="public"
                            className="me-1"
                            style={{ fontSize: '14px' }}
                          />
                          {log.ipAddress || '—'}
                        </span>
                        {log.initiatorId ? (
                          <span className="text-muted small">
                            (Initiator: <code>{log.initiatorId}</code>)
                          </span>
                        ) : null}
                      </div>

                      <div className="text-muted small">
                        {logDate ? (
                          <span
                            title={logDate.toLocaleString()}
                          >
                            {logDate.toLocaleString()} (
                            {fromNowDate(logDate)})
                          </span>
                        ) : (
                          '—'
                        )}
                      </div>
                    </div>

                    {hasInfo ? (
                      <div className="mt-2">
                        <pre className="bg-light p-2 rounded small mb-0 font-monospace text-dark border">
                          {JSON.stringify(log.info, null, 2)}
                        </pre>
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
