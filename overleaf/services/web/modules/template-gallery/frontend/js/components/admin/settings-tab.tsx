import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Notification from '@/shared/components/notification'
import OLButton from '@/shared/components/ol/ol-button'
import OLSpinner from '@/shared/components/ol/ol-spinner'
import { getCredential, getSyncSettings } from '../../api/client'
import {
  errorMessage,
  toTemplateAdminApiError,
  TemplateAdminApiError,
} from '../../api/errors'
import type { Credential, SyncSettings } from '../../api/types'
import { useAsyncAction } from '../../hooks/use-async-action'
import type { Flash } from '../shared/flash'
import CredentialsCard from './settings/credentials-card'
import EgressCard from './settings/egress-card'
import RefetchCard from './settings/refetch-card'

type SettingsTabProps = {
  onFlash(flash: Flash): void
}

export default function SettingsTab({ onFlash }: SettingsTabProps) {
  const { t } = useTranslation()
  const [credential, setCredential] = useState<Credential | null>(null)
  const [settings, setSettings] = useState<SyncSettings | null>(null)
  const [error, setError] = useState<TemplateAdminApiError | null>(null)
  const reload = useAsyncAction()

  const load = useCallback(async () => {
    try {
      const [nextCredential, nextSettings] = await Promise.all([
        getCredential(),
        getSyncSettings(),
      ])
      setCredential(nextCredential)
      setSettings(nextSettings)
      setError(null)
    } catch (err) {
      setError(toTemplateAdminApiError(err))
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div>
      {error && (
        <Notification
          type="error"
          content={errorMessage(t, error)}
          className="mb-4"
          action={
            <OLButton
              variant="secondary"
              size="sm"
              isLoading={reload.busy}
              onClick={() => reload.run(load)}
            >
              {t('refresh')}
            </OLButton>
          }
        />
      )}

      {credential && settings ? (
        <div className="d-flex flex-column gap-4">
          <RefetchCard
            key={`${settings.autoSync}-${settings.refetchDays}`}
            settings={settings}
            onChanged={load}
            onFlash={onFlash}
          />
          <EgressCard onFlash={onFlash} />
          <CredentialsCard
            credential={credential}
            onChanged={load}
            onFlash={onFlash}
          />
        </div>
      ) : (
        !error && (
          <div className="py-5 text-center">
            <OLSpinner />
            <span className="visually-hidden">{t('loading')}</span>
          </div>
        )
      )}
    </div>
  )
}
