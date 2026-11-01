import { useTranslation } from 'react-i18next'
import OLTag from '@/shared/components/ol/ol-tag'
import MaterialIcon from '@/shared/components/material-icon'
import SectionCard from '../shared/section-card'
import type { ItemDetail } from '../../api/types'
import { DetailRow, MISSING } from './sync-view'

type ItemSummaryCardProps = {
  item: ItemDetail
}

// Read-only copy of the upstream metadata
export default function ItemSummaryCard({ item }: ItemSummaryCardProps) {
  const { t } = useTranslation()

  return (
    <SectionCard
      className="mb-4"
      title={t('template_gallery_admin_item_upstream')}
    >
      <dl className="row mb-0">
        <DetailRow label={t('title')}>{item.title}</DetailRow>
        <DetailRow label={t('author')}>{item.author ?? MISSING}</DetailRow>
        <DetailRow label={t('license')}>
          {item.licenseLabel ?? MISSING}
        </DetailRow>
        <DetailRow label={t('tags')}>
          {item.tags.length > 0 ? (
            <div className="d-flex flex-wrap gap-1">
              {item.tags.map(tag => (
                <OLTag key={tag.name}>{tag.title}</OLTag>
              ))}
            </div>
          ) : (
            MISSING
          )}
        </DetailRow>
        <DetailRow label={t('template_gallery_admin_col_upstream')}>
          <a
            href={item.upstreamUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="d-inline-flex align-items-center gap-1"
          >
            overleaf.com
            <MaterialIcon type="open_in_new" />
          </a>
        </DetailRow>
        <DetailRow label={t('template_gallery_admin_col_gallery')}>
          <a href={item.galleryUrl}>{t('view')}</a>
        </DetailRow>
      </dl>
    </SectionCard>
  )
}
