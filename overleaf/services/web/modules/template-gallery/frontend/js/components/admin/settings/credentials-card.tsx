import { ChangeEvent, FormEvent, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Notification from '@/shared/components/notification'
import OLBadge from '@/shared/components/ol/ol-badge'
import OLButton from '@/shared/components/ol/ol-button'
import OLForm from '@/shared/components/ol/ol-form'
import OLFormControl from '@/shared/components/ol/ol-form-control'
import OLFormGroup from '@/shared/components/ol/ol-form-group'
import OLFormLabel from '@/shared/components/ol/ol-form-label'
import { clearCredential, saveCredential } from '../../../api/client'
import { errorMessage } from '../../../api/errors'
import type { Credential } from '../../../api/types'
import { useAsyncAction } from '../../../hooks/use-async-action'
import { ConfirmActionModal } from '../../shared/confirm-action-modal'
import type { Flash } from '../../shared/flash'
import SectionCard from '../../shared/section-card'

// The cookie is kept in component state only until it is saved. It is never
// rendered, logged or included in an error message.
const COOKIE_MAX_LENGTH = 4096

type CredentialsCardProps = {
  credential: Credential
  onChanged(): void
  onFlash(flash: Flash): void
}

export default function CredentialsCard({
  credential,
  onChanged,
  onFlash,
}: CredentialsCardProps) {
  const { t } = useTranslation()
  const idPrefix = useId()
  const [cookie, setCookie] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const save = useAsyncAction()
  const clear = useAsyncAction()
  const configured = credential.configured === true

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = cookie.trim()
    if (!value || save.busy) {
      return
    }
    void save.run(async () => {
      await saveCredential(value)
      setCookie('')
      onFlash({
        type: 'success',
        content: t('template_gallery_admin_settings_cookie_saved'),
      })
      onChanged()
    })
  }

  async function clearCookie() {
    const result = await clear.run(clearCredential)
    if (result) {
      setConfirmClear(false)
      onFlash({
        type: 'success',
        content: t('template_gallery_admin_settings_cookie_cleared'),
      })
      onChanged()
    }
  }

  function hideClearModal() {
    setConfirmClear(false)
    clear.clearError()
  }

  return (
    <SectionCard
      title={t('template_gallery_admin_settings_cookie_title')}
      actions={
        credential.invalid ? (
          <OLBadge bg="danger">
            {t('template_gallery_admin_settings_cookie_invalid')}
          </OLBadge>
        ) : configured ? (
          <OLBadge bg="primary">{t('configured')}</OLBadge>
        ) : (
          <OLBadge bg="transparent" text="body" className="border">
            {t('template_gallery_admin_settings_cookie_not_configured')}
          </OLBadge>
        )
      }
    >
      <p className="text-muted">{t('template_gallery_admin_session_help')}</p>
      <details className="mb-3">
        <summary>{t('template_gallery_admin_cookie_guide_title')}</summary>
        <ol className="mt-2 mb-0 ps-4">
          <li>{t('template_gallery_admin_cookie_guide_step_1')}</li>
          <li>{t('template_gallery_admin_cookie_guide_step_2')}</li>
          <li>{t('template_gallery_admin_cookie_guide_step_3')}</li>
          <li>{t('template_gallery_admin_cookie_guide_step_4')}</li>
        </ol>
        <p className="text-muted mt-2 mb-0">
          {t('template_gallery_admin_cookie_guide_note')}
        </p>
      </details>

      {save.error && (
        <Notification
          type="error"
          content={errorMessage(t, save.error)}
          className="mb-3"
        />
      )}

      <OLForm onSubmit={handleSubmit}>
        <OLFormGroup>
          <OLFormLabel htmlFor={`${idPrefix}-cookie`}>
            {t('template_gallery_admin_settings_cookie_label')}
          </OLFormLabel>
          <OLFormControl
            id={`${idPrefix}-cookie`}
            type="password"
            autoComplete="off"
            maxLength={COOKIE_MAX_LENGTH}
            required
            value={cookie}
            disabled={save.busy}
            aria-describedby={`${idPrefix}-cookie-help`}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setCookie(e.target.value)
            }
          />
          <small
            className="text-muted d-block mt-2"
            id={`${idPrefix}-cookie-help`}
          >
            {t('template_gallery_admin_settings_cookie_help')}
          </small>
        </OLFormGroup>
        <div className="d-flex justify-content-end gap-2 mt-3">
          {configured && (
            <OLButton
              variant="danger"
              disabled={clear.busy}
              onClick={() => setConfirmClear(true)}
            >
              {t('template_gallery_admin_settings_cookie_clear')}
            </OLButton>
          )}
          <OLButton
            type="submit"
            variant="primary"
            disabled={cookie.trim() === ''}
            isLoading={save.busy}
          >
            {t('template_gallery_admin_settings_cookie_save')}
          </OLButton>
        </div>
      </OLForm>

      <ConfirmActionModal
        show={confirmClear}
        title={t('template_gallery_admin_confirm_clear_cookie_title')}
        body={t('template_gallery_admin_confirm_clear_cookie_body')}
        confirmLabel={t('template_gallery_admin_settings_cookie_clear')}
        variant="danger"
        busy={clear.busy}
        error={clear.error}
        onConfirm={clearCookie}
        onHide={hideClearModal}
      />
    </SectionCard>
  )
}
