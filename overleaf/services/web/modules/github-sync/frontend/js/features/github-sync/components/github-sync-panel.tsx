import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import getMeta from '@/utils/meta'
import OLButton from '@/shared/components/ol/ol-button'
import GitLogoOrange from '@/shared/svgs/git-logo-orange'

type SyncStatus = {
  linked: boolean
  repo?: { owner: string; name: string }
  syncState?: 'idle' | 'syncing' | 'conflict' | 'error'
  outgoing?: boolean
  incoming?: number
  conflictBranch?: string | null
  lastError?: { code: string; message: string } | null
}

// Slot registrations resolve at webpack build time, so the feature flag has to
// be enforced here at render time. Returning null before the inner component
// mounts also stops the /status request firing on every editor load.
export default function GithubSyncPanel() {
  if (!getMeta('ol-githubSyncEnabled')) return null
  return <GithubSyncPanelInner />
}

function GithubSyncPanelInner() {
  const { t } = useTranslation()
  const projectId = getMeta('ol-project_id')
  const csrfToken = getMeta('ol-csrfToken')

  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [showPushPrompt, setShowPushPrompt] = useState(false)
  const [message, setMessage] = useState('')

  const refresh = useCallback(() => {
    if (!projectId) return
    fetch(`/project/${projectId}/github/status`, { credentials: 'same-origin' })
      .then(res => (res.ok ? res.json() : { linked: false }))
      .then(setStatus)
      .catch(() => setStatus({ linked: false }))
  }, [projectId])

  useEffect(() => {
    refresh()
  }, [refresh])

  const post = useCallback(
    async (path: string, body?: Record<string, unknown>) => {
      if (!projectId) return
      setBusy(true)
      try {
        const res = await fetch(`/project/${projectId}/github/${path}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            'X-Csrf-Token': csrfToken ?? '',
          },
          body: body ? JSON.stringify(body) : undefined,
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          throw new Error(
            data?.message ||
              data?.code ||
              `Request failed with status ${res.status}`
          )
        }
        return data
      } finally {
        setBusy(false)
        refresh()
      }
    },
    [projectId, csrfToken, refresh]
  )

  if (!status?.linked || !status.repo) {
    return null
  }

  const incoming = status.incoming ?? 0

  return (
    <div className="integrations-panel-card-button" style={{ cursor: 'default' }}>
      <div className="integrations-panel-card-contents">
        <div className="integrations-panel-card-icon">
          <GitLogoOrange size={24} />
        </div>
        <div className="integrations-panel-card-inner">
          <div className="integrations-panel-card-header">
            <span className="integrations-panel-card-title">
              {status.repo.owner}/{status.repo.name}
            </span>
          </div>
          <p className="integrations-panel-card-description">
            {status.syncState === 'conflict'
              ? status.conflictBranch
              : incoming > 0
                ? `${incoming}`
                : t('no_new_commits_in_github')}
          </p>
          <div className="btn-toolbar" style={{ gap: '4px', display: 'flex', flexWrap: 'wrap' }}>
            {status.syncState === 'conflict' ? (
              <OLButton size="sm" disabled={busy} onClick={() => post('continue-merge')}>
                {t('continue_github_merge')}
              </OLButton>
            ) : (
              <OLButton size="sm" disabled={busy} onClick={() => post('pull')}>
                {t('pull_github_changes_into_sharelatex')}
              </OLButton>
            )}
            <OLButton size="sm" disabled={busy} onClick={() => setShowPushPrompt(true)}>
              {t('push_sharelatex_changes_to_github')}
            </OLButton>
            <OLButton size="sm" variant="link" disabled={busy} onClick={() => post('unlink')}>
              {t('unlink_github_repository')}
            </OLButton>
          </div>
          {showPushPrompt ? (
            <div className="github-push-prompt" style={{ marginTop: '4px' }}>
              <input
                type="text"
                className="form-control"
                placeholder={t('commit_message', 'Commit message')}
                value={message}
                onChange={e => setMessage(e.target.value)}
              />
              <OLButton
                size="sm"
                variant="primary"
                disabled={busy}
                onClick={async () => {
                  try {
                    await post('push', { message })
                    setShowPushPrompt(false)
                    setMessage('')
                  } catch {
                    // post() sets error state, refreshes status and resets busy
                  }
                }}
              >
                {t('push')}
              </OLButton>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
