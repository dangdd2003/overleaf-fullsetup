import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Notification from '@/shared/components/notification'
import OLButton from '@/shared/components/ol/ol-button'
import type { ItemRow, SyncBlock, SyncFilter } from '../../api/types'
import { useDebouncedValue } from '../../hooks/use-debounced-value'
import { useItems } from '../../hooks/use-items'
import { usePoll } from '../../hooks/use-poll'
import { formatCount } from '../../utils/format'
import type { Flash } from '../shared/flash'
import ItemTable from './item-table'
import ItemsToolbar from './items-toolbar'

const PAGE_SIZE = 25
const SEARCH_DEBOUNCE_MS = 300

// While templates are waiting for or in the sync, the page is refreshed this often
const LIVE_POLL_MS = 5000

type ItemsTabProps = {
  initialSync?: SyncFilter
  onFlash(flash: Flash): void
}

export default function ItemsTab({
  initialSync = 'all',
  onFlash,
}: ItemsTabProps) {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const [sync, setSync] = useState<SyncFilter>(initialSync)
  const query = useDebouncedValue(search.trim(), SEARCH_DEBOUNCE_MS)

  // The page is stored with the filters it belongs to, so a filter change
  // goes back to page 1 in the same render and sends a single request
  const filterKey = JSON.stringify([query, sync])
  const [paging, setPaging] = useState({ key: filterKey, page: 1 })
  const page = paging.key === filterKey ? paging.page : 1
  const setPage = (next: number) => setPaging({ key: filterKey, page: next })

  const { data, error, isLoading, refresh, poll } = useItems({
    q: query || undefined,
    sync,
    page,
    pageSize: PAGE_SIZE,
  })

  // Sync blocks returned by a refetch replace the listed ones until the next
  // list response arrives
  const [synced, setSynced] = useState<Record<string, SyncBlock>>({})
  useEffect(() => {
    setSynced({})
  }, [data])

  const items: ItemRow[] = (data?.items ?? []).map(item =>
    synced[item.id] ? { ...item, sync: synced[item.id] } : item
  )

  const hasFilters = search !== '' || sync !== 'all'
  const live = items.some(
    item =>
      item.sync.detailStatus === 'syncing' ||
      item.sync.detailStatus === 'queued'
  )
  usePoll(poll, LIVE_POLL_MS, live || sync === 'syncing')

  function handleSynced(id: string, block: SyncBlock) {
    setSynced(current => ({ ...current, [id]: block }))
  }

  return (
    <>
      {error ? (
        <Notification
          type="error"
          className="mb-4"
          content={t('template_gallery_admin_load_failed')}
          action={
            <OLButton variant="secondary" size="sm" onClick={refresh}>
              {t('refresh')}
            </OLButton>
          }
        />
      ) : null}
      <ItemsToolbar
        search={search}
        onSearchChange={setSearch}
        sync={sync}
        onSyncChange={setSync}
      />
      <ItemTable
        caption={t('template_gallery_admin_tab_templates')}
        items={items}
        isLoading={isLoading}
        emptyText={
          hasFilters
            ? t('template_gallery_admin_empty_filtered')
            : t('template_gallery_admin_empty')
        }
        onFlash={onFlash}
        onSynced={handleSynced}
      />
      {data && data.total > 0 ? (
        <div className="d-flex justify-content-between align-items-center flex-wrap gap-2 mt-3">
          <span className="text-muted small">
            {t('template_gallery_admin_total_count', {
              total: formatCount(data.total),
            })}
          </span>
          {data.totalPages > 1 ? (
            <ItemsPagination
              currentPage={page}
              totalPages={data.totalPages}
              onPageChange={setPage}
            />
          ) : null}
        </div>
      ) : null}
    </>
  )
}

function ItemsPagination({
  currentPage,
  totalPages,
  onPageChange,
}: {
  currentPage: number
  totalPages: number
  onPageChange(page: number): void
}) {
  const { t } = useTranslation()
  if (totalPages <= 1 || currentPage < 1 || currentPage > totalPages) {
    return null
  }

  const firstPage = Math.max(1, currentPage - 4)
  const lastPage = Math.min(totalPages, currentPage + 4)
  const pages = Array.from(
    { length: lastPage - firstPage + 1 },
    (_, index) => firstPage + index
  )

  return (
    <nav role="navigation" aria-label={t('pagination_navigation')}>
      <ul className="pagination">
        {currentPage > 1 && (
          <>
            <li>
              <button
                type="button"
                aria-label={t('go_to_first_page')}
                onClick={() => onPageChange(1)}
              >
                <span aria-hidden="true">&lt;&lt;</span> {t('first')}
              </button>
            </li>
            <li>
              <button
                type="button"
                aria-label={t('go_to_previous_page')}
                onClick={() => onPageChange(currentPage - 1)}
              >
                <span aria-hidden="true">&lt;</span> {t('prev')}
              </button>
            </li>
          </>
        )}
        {firstPage > 1 && (
          <li aria-hidden="true">
            <span>…</span>
          </li>
        )}
        {pages.map(page => (
          <li
            key={page}
            className={page === currentPage ? 'active' : undefined}
          >
            {page === currentPage ? (
              <span
                aria-label={t('page_current', { page })}
                aria-current="true"
              >
                {page}
              </span>
            ) : (
              <button
                type="button"
                aria-label={t('go_page', { page })}
                onClick={() => onPageChange(page)}
              >
                {page}
              </button>
            )}
          </li>
        ))}
        {lastPage < totalPages && (
          <li className="ellipses" aria-hidden="true">
            <span>…</span>
          </li>
        )}
        {currentPage < totalPages && (
          <>
            <li>
              <button
                type="button"
                aria-label={t('go_to_next_page')}
                onClick={() => onPageChange(currentPage + 1)}
              >
                {t('next')} <span aria-hidden="true">&gt;</span>
              </button>
            </li>
            <li>
              <button
                type="button"
                aria-label={t('go_to_last_page')}
                onClick={() => onPageChange(totalPages)}
              >
                {t('last')} <span aria-hidden="true">&gt;&gt;</span>
              </button>
            </li>
          </>
        )}
      </ul>
    </nav>
  )
}
