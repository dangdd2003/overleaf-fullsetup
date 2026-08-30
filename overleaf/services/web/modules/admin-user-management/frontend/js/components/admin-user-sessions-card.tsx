import { useState, useEffect, useCallback, useRef } from 'react'
import OLCard from '@/shared/components/ol/ol-card'
import OLButton from '@/shared/components/ol/ol-button'
import OLBadge from '@/shared/components/ol/ol-badge'
import OLSpinner from '@/shared/components/ol/ol-spinner'
import MaterialIcon from '@/shared/components/material-icon'
import { getJSON } from '@/infrastructure/fetch-json'
import { fromNowDate } from '@/utils/dates'
import RevokeSessionsModal from './revoke-sessions-modal'

export interface SessionInfo {
  ip_address?: string
  session_created?: string | Date
}

export interface AdminUserSessionsCardProps {
  userId: string
  userEmail: string
  isSelf: boolean
  onError: (err: string) => void
  onSuccess: (msg: string) => void
}

export default function AdminUserSessionsCard({
  userId,
  userEmail,
  isSelf,
  onError,
  onSuccess,
}: AdminUserSessionsCardProps) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [count, setCount] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [showRevokeModal, setShowRevokeModal] = useState(false)

  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  const fetchSessions = useCallback(async () => {
    try {
      const data = await getJSON<{
        sessions: SessionInfo[]
        count: number
      }>(`/admin/users/api/users/${userId}/sessions`)
      setSessions(data.sessions || [])
      setCount(data.count ?? (data.sessions ? data.sessions.length : 0))
    } catch (err: any) {
      onErrorRef.current?.(err?.message || 'Failed to load active sessions')
    } finally {
      setIsLoading(false)
    }
  }, [userId])

  useEffect(() => {
    fetchSessions()
  }, [fetchSessions])

  function handleRevokeSuccess(revokedCount: number) {
    fetchSessions()
    const msg = isSelf
      ? `Revoked ${revokedCount} session(s). Your current session remains active.`
      : `Revoked ${revokedCount} session(s) successfully.`
    onSuccess(msg)
  }

  return (
    <OLCard className="mb-4">
      <div className="card-header bg-transparent py-3 px-3 d-flex justify-content-between align-items-center flex-wrap gap-2">
        <div className="d-flex align-items-center gap-2">
          <h2 className="h4 mb-0">Active Sessions</h2>
          {count > 0 ? (
            <OLBadge bg="info">{count} Active</OLBadge>
          ) : (
            <OLBadge bg="light" text="dark" className="border">
              0 Active
            </OLBadge>
          )}
        </div>
      </div>
      <div className="card-body">
        {isLoading && sessions.length === 0 ? (
          <div className="py-3 text-center">
            <OLSpinner />
          </div>
        ) : (
          <>
            {sessions.length === 0 ? (
              <p className="text-muted small mb-0">
                No active login sessions found for this user.
              </p>
            ) : (
              <>
                <p className="text-muted small mb-3">
                  Active browser sessions currently logged into this account.
                </p>
                <ul className="list-group list-group-flush border rounded mb-3">
                  {sessions.map((session, idx) => (
                    <li
                      key={idx}
                      className="list-group-item d-flex justify-content-between align-items-center flex-wrap gap-2"
                    >
                      <div>
                        <div className="fw-semibold font-monospace small d-inline-flex align-items-center">
                          <MaterialIcon
                            type="devices"
                            className="me-2 text-muted"
                            style={{ fontSize: '15px' }}
                          />
                          {session.ip_address || 'Unknown IP'}
                        </div>
                        {session.session_created ? (
                          <small className="text-muted">
                            Started {fromNowDate(session.session_created)}
                          </small>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
                <OLButton
                  variant="danger"
                  className="w-100"
                  onClick={() => setShowRevokeModal(true)}
                  disabled={isLoading || count === 0}
                >
                  Revoke All Sessions
                </OLButton>
              </>
            )}
          </>
        )}
      </div>
      <RevokeSessionsModal
        show={showRevokeModal}
        userId={userId}
        userEmail={userEmail}
        isSelf={isSelf}
        onHide={() => setShowRevokeModal(false)}
        onSuccess={handleRevokeSuccess}
      />
    </OLCard>
  )
}
