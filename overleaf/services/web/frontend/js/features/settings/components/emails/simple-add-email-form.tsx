import { useState, type FormEvent } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import { useUserEmailsContext } from '../../context/user-email-context'
import { postJSON } from '../../../../infrastructure/fetch-json'
import useAsync from '../../../../shared/hooks/use-async'
import getMeta from '../../../../utils/meta'
import { isValidEmail } from '../../../../shared/utils/email'
import OLButton from '@/shared/components/ol/ol-button'
import OLRow from '@/shared/components/ol/ol-row'
import OLCol from '@/shared/components/ol/ol-col'
import OLFormControl from '@/shared/components/ol/ol-form-control'
import OLForm from '@/shared/components/ol/ol-form'
import OLFormGroup from '@/shared/components/ol/ol-form-group'
import OLNotification from '@/shared/components/ol/ol-notification'
import AddAnotherEmailBtn from './add-email/add-another-email-btn'

function SimpleAddEmailForm() {
  const { t } = useTranslation()
  const [isFormVisible, setIsFormVisible] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const { isLoading, runAsync } = useAsync()
  const { state, getEmails } = useUserEmailsContext()

  const emailAddressLimit = getMeta('ol-emailAddressLimit') || 10

  const handleOpenForm = () => {
    setIsFormVisible(true)
    setErrorMessage(null)
    setSuccessMessage(null)
  }

  const handleCancel = () => {
    setIsFormVisible(false)
    setNewEmail('')
    setErrorMessage(null)
  }

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    const trimmed = newEmail.trim()
    if (!trimmed || !isValidEmail(trimmed)) {
      setErrorMessage(
        t('invalid_email_format', 'Please enter a valid email address.')
      )
      return
    }

    setErrorMessage(null)
    runAsync(
      postJSON('/user/emails/secondary', {
        body: { email: trimmed },
      })
    )
      .then(() => {
        setSuccessMessage(
          t('email_added_successfully', 'Secondary email added successfully.')
        )
        setNewEmail('')
        setIsFormVisible(false)
        getEmails()
      })
      .catch((err: any) => {
        const errorKey = err?.data?.error
        if (errorKey === 'email_already_registered') {
          setErrorMessage(
            t(
              'email_already_registered',
              'This email address is already registered.'
            )
          )
        } else if (errorKey === 'email_limit_exceeded') {
          setErrorMessage(
            t('email_limit_reached', 'Email address limit reached.')
          )
        } else {
          setErrorMessage(
            t(
              'error_performing_request',
              'An error occurred while adding email.'
            )
          )
        }
      })
  }

  if (!isFormVisible) {
    return (
      <div className="mt-3">
        {successMessage && (
          <div className="mb-2">
            <OLNotification type="success" content={successMessage} />
          </div>
        )}
        {state.data.emailCount >= emailAddressLimit ? (
          <p className="small text-muted mb-0">
            <Trans
              i18nKey="email_limit_reached"
              values={{ emailAddressLimit }}
              shouldUnescape
              tOptions={{ interpolation: { escapeValue: true } }}
              components={[<strong key="0" />]}
            />
          </p>
        ) : (
          <AddAnotherEmailBtn onClick={handleOpenForm} />
        )}
      </div>
    )
  }

  return (
    <div className="affiliations-table-row-highlighted p-3 my-2">
      {errorMessage && (
        <div className="mb-2">
          <OLNotification type="error" content={errorMessage} />
        </div>
      )}
      <OLForm onSubmit={handleSubmit} noValidate>
        <OLRow className="align-items-center g-2">
          <OLCol lg={7} sm={12}>
            <OLFormControl
              id="simple-secondary-email-input"
              type="email"
              placeholder="name@example.com"
              value={newEmail}
              onChange={(e: any) => setNewEmail(e.target.value)}
              disabled={isLoading}
            />
          </OLCol>
          <OLCol lg={5} sm={12} className="text-lg-end d-flex gap-2 justify-content-lg-end">
            <OLButton
              variant="primary"
              size="sm"
              type="submit"
              disabled={!newEmail.trim() || isLoading}
              isLoading={isLoading}
              loadingLabel={t('adding_email', 'Adding email...')}
            >
              {t('add_email', 'Add email')}
            </OLButton>
            <OLButton
              variant="secondary"
              size="sm"
              type="button"
              onClick={handleCancel}
              disabled={isLoading}
            >
              {t('cancel', 'Cancel')}
            </OLButton>
          </OLCol>
        </OLRow>
      </OLForm>
    </div>
  )
}

export default SimpleAddEmailForm
