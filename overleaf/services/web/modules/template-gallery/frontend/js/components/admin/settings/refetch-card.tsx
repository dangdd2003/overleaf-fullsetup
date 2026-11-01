import { ChangeEvent, FormEvent, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Notification from '@/shared/components/notification'
import OLButton from '@/shared/components/ol/ol-button'
import OLForm from '@/shared/components/ol/ol-form'
import OLFormCheckbox from '@/shared/components/ol/ol-form-checkbox'
import OLFormControl from '@/shared/components/ol/ol-form-control'
import OLFormGroup from '@/shared/components/ol/ol-form-group'
import OLFormLabel from '@/shared/components/ol/ol-form-label'
import { saveSyncSettings } from '../../../api/client'
import { errorMessage } from '../../../api/errors'
import type { SyncSettings } from '../../../api/types'
import { useAsyncAction } from '../../../hooks/use-async-action'
import type { Flash } from '../../shared/flash'
import SectionCard from '../../shared/section-card'

const MIN_DAYS = 1
const MAX_DAYS = 365

type RefetchCardProps = {
  settings: SyncSettings
  onChanged(): void
  onFlash(flash: Flash): void
}

export default function RefetchCard({
  settings,
  onChanged,
  onFlash,
}: RefetchCardProps) {
  const { t } = useTranslation()
  const id = useId()
  const [days, setDays] = useState(String(settings.refetchDays))
  const [autoSync, setAutoSync] = useState(settings.autoSync)
  const save = useAsyncAction()
  const value = Number(days)
  const valid =
    Number.isInteger(value) && value >= MIN_DAYS && value <= MAX_DAYS
  const changed =
    valid &&
    (value !== settings.refetchDays || autoSync !== settings.autoSync)

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!changed || save.busy) return
    void save.run(async () => {
      // Only the edited fields, so a stale form never reverts another admin's change
      const changes: Partial<SyncSettings> = {}
      if (autoSync !== settings.autoSync) changes.autoSync = autoSync
      if (value !== settings.refetchDays) changes.refetchDays = value
      await saveSyncSettings(changes)
      onFlash({
        type: 'success',
        content: t('template_gallery_admin_settings_saved'),
      })
      onChanged()
    })
  }

  return (
    <SectionCard title={t('template_gallery_admin_refetch_title')}>
      {save.error && (
        <Notification
          type="error"
          content={errorMessage(t, save.error)}
          className="mb-3"
        />
      )}
      <OLForm onSubmit={handleSubmit}>
        <OLFormGroup>
          <OLFormCheckbox
            id={`${id}-auto`}
            label={t('template_gallery_admin_sync_auto_label')}
            checked={autoSync}
            disabled={save.busy}
            aria-describedby={`${id}-auto-help`}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setAutoSync(e.target.checked)
            }
          />
          <small className="text-muted d-block mt-1" id={`${id}-auto-help`}>
            {t('template_gallery_admin_sync_auto_help')}
          </small>
        </OLFormGroup>
        <OLFormGroup className="mt-3">
          <OLFormLabel htmlFor={`${id}-days`}>
            {t('template_gallery_admin_refetch_label')}
          </OLFormLabel>
          <div className="d-flex align-items-center gap-2">
            <OLFormControl
              id={`${id}-days`}
              type="number"
              min={MIN_DAYS}
              max={MAX_DAYS}
              step={1}
              required
              className="w-auto"
              value={days}
              disabled={save.busy}
              aria-describedby={`${id}-help`}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setDays(e.target.value)
              }
            />
            <span>{t('template_gallery_admin_refetch_days_unit')}</span>
          </div>
          <small className="text-muted d-block mt-2" id={`${id}-help`}>
            {t('template_gallery_admin_refetch_help')}
          </small>
        </OLFormGroup>
        <div className="d-flex justify-content-end mt-3">
          <OLButton
            type="submit"
            variant="primary"
            disabled={!changed}
            isLoading={save.busy}
          >
            {t('save')}
          </OLButton>
        </div>
      </OLForm>
    </SectionCard>
  )
}
