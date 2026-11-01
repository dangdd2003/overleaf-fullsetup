import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import OLCol from '@/shared/components/ol/ol-col'
import OLRow from '@/shared/components/ol/ol-row'
import OLSpinner from '@/shared/components/ol/ol-spinner'
import MaterialIcon from '@/shared/components/material-icon'
import Notification from '@/shared/components/notification'
import { getItem } from '../../api/client'
import { usePoll } from '../../hooks/use-poll'
import {
  errorMessage,
  toTemplateAdminApiError,
  type TemplateAdminApiError,
} from '../../api/errors'
import type { ItemDetail, SyncBlock } from '../../api/types'
import ItemSummaryCard from './item-summary-card'
import MirrorCard from './mirror-card'
import SourceCard from './source-card'

const TEMPLATES_TAB_PATH = '/admin/templates?tab=templates'
const ITEM_POLL_MS = 5000

type TemplateGalleryItemPageProps = {
  itemId: string
}

export default function TemplateGalleryItemPage({
  itemId,
}: TemplateGalleryItemPageProps) {
  const { t } = useTranslation()
  const [item, setItem] = useState<ItemDetail | null>(null)
  const [error, setError] = useState<TemplateAdminApiError | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  // Bumped after a refetch so the upstream fields reload too
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    getItem(itemId, controller.signal).then(
      result => {
        if (controller.signal.aborted) return
        setItem(result.item)
        setError(null)
        setIsLoading(false)
      },
      err => {
        if (controller.signal.aborted) return
        setError(toTemplateAdminApiError(err))
        setIsLoading(false)
      }
    )
    return () => {
      controller.abort()
    }
  }, [itemId, reloadKey])

  // While the template waits for or is in the sync, its status is refreshed
  const waiting =
    item?.sync.detailStatus === 'syncing' ||
    item?.sync.detailStatus === 'queued'
  usePoll(async () => setReloadKey(key => key + 1), ITEM_POLL_MS, waiting)

  // Refetch actions return the new sync block. The sync block is shown at once
  // and the whole item is reloaded, since a details refetch changes the upstream
  // fields (title, author, tags) as well.
  function handleSynced(sync: SyncBlock) {
    setItem(current => (current ? { ...current, sync } : current))
    setReloadKey(key => key + 1)
  }

  return (
    <div className="row">
      <div className="col-12">
        <div className="page-header d-flex justify-content-between align-items-center mb-4 flex-wrap gap-2">
          <div>
            <a
              className="text-decoration-none text-muted d-inline-flex align-items-center gap-2 fw-medium"
              href={TEMPLATES_TAB_PATH}
            >
              <MaterialIcon type="arrow_back" />
              {t('template_gallery_admin_item_back')}
            </a>
            {item && (
              <>
                <h1 className="mb-0 mt-1">{item.title || item.slug}</h1>
              </>
            )}
          </div>
        </div>

        {error && (
          <Notification
            type="error"
            content={errorMessage(t, error)}
            className="mb-4"
          />
        )}

        {isLoading && (
          <div className="py-5 text-center">
            <OLSpinner />
          </div>
        )}

        {item && (
          <OLRow className="g-4">
            <OLCol lg={7}>
              <ItemSummaryCard item={item} />
            </OLCol>
            <OLCol lg={5}>
              <MirrorCard item={item} onSynced={handleSynced} />
              <SourceCard item={item} onSynced={handleSynced} />
            </OLCol>
          </OLRow>
        )}
      </div>
    </div>
  )
}
