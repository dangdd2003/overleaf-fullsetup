import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  OLModal,
  OLModalBody,
  OLModalFooter,
  OLModalHeader,
  OLModalTitle,
} from '@/shared/components/ol/ol-modal'
import OLButton from '@/shared/components/ol/ol-button'
import { useLocation } from '@/shared/hooks/use-location'
import getMeta from '@/utils/meta'

export default function GithubSettingsWidget() {
  if (!getMeta('ol-githubSyncEnabled')) return null
  return <GithubSettingsWidgetInner />
}

function GithubSettingsWidgetInner() {
  const { t } = useTranslation()
  const csrfToken = getMeta('ol-csrfToken')
  const location = useLocation()

  const [linked, setLinked] = useState(false)
  const [username, setUsername] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [showUnlinkModal, setShowUnlinkModal] = useState(false)
  const [working, setWorking] = useState(false)

  useEffect(() => {
    fetch('/auth/github/status', { credentials: 'same-origin' })
      .then(res => (res.ok ? res.json() : { linked: false, username: null }))
      .then(data => {
        setLinked(Boolean(data.linked))
        setUsername(data.username)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const handleUnlink = useCallback(async () => {
    setWorking(true)
    try {
      const res = await fetch('/auth/github/unlink', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Csrf-Token': csrfToken ?? '' },
      })
      if (res.ok) {
        try {
          location.reload()
        } catch {
          setLinked(false)
          setShowUnlinkModal(false)
        }
      }
    } finally {
      setWorking(false)
    }
  }, [csrfToken, location])

  if (loading) return null

  if (!linked) {
    return (
      <div className="settings-widget">
        <div className="settings-widget-header">
          <h4>GitHub</h4>
        </div>
        <div className="settings-widget-body">
          <p>{t('github_sync_description')}</p>
          <a href="/auth/github/oauth" className="btn btn-primary">
            {t('link_to_github')}
          </a>
        </div>
      </div>
    )
  }

  return (
    <div className="settings-widget">
      <div className="settings-widget-header">
        <h4>GitHub</h4>
      </div>
      <div className="settings-widget-body">
        <p>
          @{username} — {t('github_sync_description')}
        </p>
        <OLButton variant="danger" onClick={() => setShowUnlinkModal(true)}>
          {t('unlink_github_repository')}
        </OLButton>
      </div>
      <OLModal show={showUnlinkModal} onHide={() => setShowUnlinkModal(false)}>
        <OLModalHeader>
          <OLModalTitle>{t('unlink_github_repository')}</OLModalTitle>
        </OLModalHeader>
        <OLModalBody>
          <p>{t('unlink_github_warning')}</p>
        </OLModalBody>
        <OLModalFooter>
          <OLButton variant="secondary" onClick={() => setShowUnlinkModal(false)}>
            {t('cancel')}
          </OLButton>
          <OLButton variant="danger" onClick={handleUnlink} disabled={working}>
            {t('unlink_github_repository')}
          </OLButton>
        </OLModalFooter>
      </OLModal>
    </div>
  )
}
