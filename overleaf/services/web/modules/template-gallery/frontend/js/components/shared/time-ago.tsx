import { useTranslation } from 'react-i18next'
import { formatDate, fromNowDate } from '@/utils/dates'

// "3 hours ago", with the full date in the tooltip. A missing value is "Never".
export default function TimeAgo({ value }: { value: string | null }) {
  const { t } = useTranslation()
  if (!value) {
    return <span className="text-muted">{t('template_gallery_admin_never')}</span>
  }
  return <span title={formatDate(value)}>{fromNowDate(value)}</span>
}
