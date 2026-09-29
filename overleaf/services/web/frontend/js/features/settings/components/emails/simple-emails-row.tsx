import { useTranslation } from 'react-i18next'
import { UserEmailData } from '../../../../../../types/user-email'
import EmailCell from './cell'
import Actions from './actions'
import OLRow from '@/shared/components/ol/ol-row'
import OLCol from '@/shared/components/ol/ol-col'
import OLBadge from '@/shared/components/ol/ol-badge'

type SimpleEmailsRowProps = {
  userEmailData: UserEmailData
  primary?: UserEmailData
}

function SimpleEmailsRow({ userEmailData, primary }: SimpleEmailsRowProps) {
  const { t } = useTranslation()
  const isPrimary = userEmailData.default

  return (
    <OLRow data-testid="simple-email-row" className="align-items-center py-2">
      <OLCol lg={8}>
        <EmailCell>
          <span className="me-2">{userEmailData.email}</span>
          {isPrimary && (
            <OLBadge bg="info">{t('primary', 'Primary')}</OLBadge>
          )}
          {!userEmailData.confirmedAt && (
            <span className="text-muted small ms-2">
              ({t('unconfirmed', 'Unconfirmed')})
            </span>
          )}
        </EmailCell>
      </OLCol>
      <OLCol lg={4}>
        <EmailCell className="text-lg-end">
          <Actions userEmailData={userEmailData} primary={primary} />
        </EmailCell>
      </OLCol>
    </OLRow>
  )
}

export default SimpleEmailsRow
