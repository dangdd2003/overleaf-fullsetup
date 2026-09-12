import { useTranslation } from 'react-i18next'
import EmailCell from './cell'
import OLCol from '@/shared/components/ol/ol-col'
import OLRow from '@/shared/components/ol/ol-row'
import classnames from 'classnames'

function SimpleEmailsHeader() {
  const { t } = useTranslation()

  return (
    <>
      <OLRow>
        <OLCol lg={8} className="d-none d-sm-block">
          <EmailCell>
            <strong>{t('email', 'Email')}</strong>
          </EmailCell>
        </OLCol>
        <OLCol lg={4} className="d-none d-sm-block text-lg-end">
          <EmailCell>
            <strong>{t('actions', 'Actions')}</strong>
          </EmailCell>
        </OLCol>
      </OLRow>
      <div className={classnames('d-none d-sm-block', 'horizontal-divider')} />
      <div className={classnames('d-none d-sm-block', 'horizontal-divider')} />
    </>
  )
}

export default SimpleEmailsHeader
