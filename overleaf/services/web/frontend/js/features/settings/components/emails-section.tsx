import { Fragment } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import getMeta from '../../../utils/meta'
import {
  UserEmailsProvider,
  useUserEmailsContext,
} from '../context/user-email-context'
import EmailsHeader from './emails/header'
import EmailsRow from './emails/row'
import AddEmail from './emails/add-email'
import SimpleEmailsHeader from './emails/simple-emails-header'
import SimpleEmailsRow from './emails/simple-emails-row'
import SimpleAddEmailForm from './emails/simple-add-email-form'
import Notification from '@/shared/components/notification'
import LoadingSpinner from '@/shared/components/loading-spinner'

type EmailsSectionContentProps = {
  isSimpleMode: boolean
}

function EmailsSectionContent({ isSimpleMode }: EmailsSectionContentProps) {
  const { t } = useTranslation()
  const {
    state: { data: userEmailsData },
    isInitializing,
    isInitializingError,
    isInitializingSuccess,
  } = useUserEmailsContext()
  const userEmails = Object.values(userEmailsData.byId)
  const primary = userEmails.find(userEmail => userEmail.default)

  // Only show the "add email" button if the user has permission to add a secondary email
  const hideAddSecondaryEmail = getMeta('ol-cannot-add-secondary-email')

  // Sort emails: primary first, then confirmed secondary emails, then unconfirmed secondary emails
  const sortedUserEmails = [...userEmails].sort((a, b) => {
    // Primary email comes first
    if (a.default) return -1
    if (b.default) return 1

    // Then sort by confirmation status
    if (a.confirmedAt && !b.confirmedAt) return -1
    if (!a.confirmedAt && b.confirmedAt) return 1

    // If both have the same status, sort by email string
    return a.email.localeCompare(b.email)
  })

  if (isSimpleMode) {
    return (
      <>
        <h2 className="h3">{t('emails', 'Emails')}</h2>
        <p className="small">
          {t(
            'emails_explanation',
            'Add additional email addresses to your account to make sure you can recover your account and collaborators can find you.'
          )}
        </p>
        <>
          <SimpleEmailsHeader />
          {isInitializing ? (
            <div className="affiliations-table-row-highlighted">
              <div className="affiliations-table-cell text-center">
                <LoadingSpinner size="sm" />
              </div>
            </div>
          ) : (
            <>
              {sortedUserEmails.map(userEmail => (
                <Fragment key={userEmail.email}>
                  <SimpleEmailsRow userEmailData={userEmail} primary={primary} />
                  <div className="horizontal-divider" />
                </Fragment>
              ))}
            </>
          )}
          {isInitializingSuccess && !hideAddSecondaryEmail && <SimpleAddEmailForm />}
          {isInitializingError && (
            <OLNotification
              type="error"
              content={t('error_performing_request')}
            />
          )}
        </>
      </>
    )
  }

  return (
    <>
      <h2 className="h3">{t('emails_and_affiliations_title')}</h2>
      <p className="small">{t('emails_and_affiliations_explanation')}</p>
      <p className="small">
        <Trans
          i18nKey="change_primary_email_address_instructions"
          components={[
            // eslint-disable-next-line react/jsx-key
            <strong />,
            // eslint-disable-next-line jsx-a11y/anchor-has-content, react/jsx-key
            <a
              href="https://docs.overleaf.com/accounts-and-security/email-address-and-login-options"
              target="_blank"
              rel="noopener noreferrer"
            />,
          ]}
        />
      </p>
      <>
        <EmailsHeader />
        {isInitializing ? (
          <div className="affiliations-table-row-highlighted">
            <div className="affiliations-table-cell text-center">
              <LoadingSpinner size="sm" />
            </div>
          </div>
        ) : (
          <>
            {sortedUserEmails.map(userEmail => (
              <Fragment key={userEmail.email}>
                <EmailsRow userEmailData={userEmail} primary={primary} />
                <div className="horizontal-divider" />
              </Fragment>
            ))}
          </>
        )}
        {isInitializingSuccess && !hideAddSecondaryEmail && <AddEmail />}
        {isInitializingError && (
          <div className="notification-list">
            <Notification
              type="error"
              content={t('error_performing_request')}
            />
          </div>
        )}
      </>
    </>
  )
}

function EmailsSection() {
  const exposedSettings = (getMeta('ol-ExposedSettings') || {}) as {
    hasAffiliationsFeature?: boolean
    hasAdminUserManagement?: boolean
  }
  const hasAffiliationsFeature = Boolean(exposedSettings.hasAffiliationsFeature)
  const hasAdminUserManagement = Boolean(
    exposedSettings.hasAdminUserManagement ||
      (getMeta as (key: string) => unknown)('ol-adminUserManagementEnabled')
  )

  if (!hasAffiliationsFeature && !hasAdminUserManagement) {
    return null
  }

  const isSimpleMode = !hasAffiliationsFeature && hasAdminUserManagement

  return (
    <UserEmailsProvider>
      <EmailsSectionContent isSimpleMode={isSimpleMode} />
    </UserEmailsProvider>
  )
}

export default EmailsSection
