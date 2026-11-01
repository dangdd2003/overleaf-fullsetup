import { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  OLModal,
  OLModalBody,
  OLModalFooter,
  OLModalHeader,
  OLModalTitle,
} from '@/shared/components/ol/ol-modal'
import OLButton from '@/shared/components/ol/ol-button'
import MaterialIcon from '@/shared/components/material-icon'
import Notification from '@/shared/components/notification'
import { errorMessage, TemplateAdminApiError } from '../../api/errors'

export type ConfirmActionModalProps = {
  show: boolean
  title: string
  body: ReactNode
  confirmLabel: string
  variant: 'primary' | 'danger'
  busy?: boolean
  error?: TemplateAdminApiError | null
  onConfirm(): void
  onHide(): void
}

export function ConfirmActionModal({
  show,
  title,
  body,
  confirmLabel,
  variant,
  busy = false,
  error = null,
  onConfirm,
  onHide,
}: ConfirmActionModalProps) {
  const { t } = useTranslation()
  const isDanger = variant === 'danger'

  return (
    <OLModal show={show} onHide={onHide} size="sm">
      <OLModalHeader>
        <OLModalTitle className="d-flex align-items-center gap-2">
          {isDanger && <MaterialIcon type="warning" className="text-danger" />}
          {title}
        </OLModalTitle>
      </OLModalHeader>
      <OLModalBody>
        {error && (
          <Notification
            type="error"
            content={errorMessage(t, error)}
            className="mb-3"
          />
        )}
        {body}
      </OLModalBody>
      <OLModalFooter>
        <OLButton variant="secondary" onClick={onHide} disabled={busy}>
          {t('cancel')}
        </OLButton>
        <OLButton
          variant={variant}
          onClick={onConfirm}
          disabled={busy}
          isLoading={busy}
        >
          {confirmLabel}
        </OLButton>
      </OLModalFooter>
    </OLModal>
  )
}

export default ConfirmActionModal
