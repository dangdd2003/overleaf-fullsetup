import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Notification from '@/shared/components/notification'
import OLCol from '@/shared/components/ol/ol-col'
import OLRow from '@/shared/components/ol/ol-row'
import OLSpinner from '@/shared/components/ol/ol-spinner'
import { fetchStatus, fetchStatusSummary } from '../../api/client'
import {
  errorMessage,
  toTemplateAdminApiError,
  TemplateAdminApiError,
} from '../../api/errors'
import type {
  StatusFull,
  StatusSummary,
  SyncDetailStatus,
} from '../../api/types'
import { usePoll } from '../../hooks/use-poll'
import { formatDateTime } from '../../utils/format'
import type { Flash } from '../shared/flash'
import CrawlerCard from './monitor/crawler-card'
import StorageCard from './monitor/storage-card'
import DedupCard from './monitor/dedup-card'
import SummaryCard from './monitor/summary-card'

// Only the counts and progress are polled, faster while a sync is running. The
// crawler status is loaded on mount and after a crawler action.
const SUMMARY_POLL_MS = 15000
const RUNNING_POLL_MS = 3000

type MonitorTabProps = {
  onFlash(flash: Flash): void
  onShowTemplates(state: SyncDetailStatus): void
}

export default function MonitorTab({
  onFlash,
  onShowTemplates,
}: MonitorTabProps) {
  const { t } = useTranslation()
  const [summary, setSummary] = useState<StatusSummary | null>(null)
  const [summaryAt, setSummaryAt] = useState<string | null>(null)
  const [summaryFailed, setSummaryFailed] = useState(false)
  const [status, setStatus] = useState<StatusFull | null>(null)
  const [statusError, setStatusError] = useState<TemplateAdminApiError | null>(
    null
  )

  // A failed poll keeps the last summary on screen. The notice shows when
  // that data was loaded.
  const loadSummary = useCallback(async () => {
    try {
      const next = await fetchStatusSummary()
      const now = new Date().toISOString()
      setSummary(next)
      setSummaryAt(now)
      setSummaryFailed(false)
    } catch {
      setSummaryFailed(true)
    }
  }, [])

  const loadStatus = useCallback(async () => {
    try {
      const next = await fetchStatus()
      setStatus(next)
      setStatusError(null)
    } catch (err) {
      setStatusError(toTemplateAdminApiError(err))
    }
  }, [])

  const reloadAll = useCallback(async () => {
    await Promise.all([loadSummary(), loadStatus()])
  }, [loadSummary, loadStatus])

  useEffect(() => {
    reloadAll()
  }, [reloadAll])

  const running = summary?.run?.state === 'running'
  usePoll(loadSummary, running ? RUNNING_POLL_MS : SUMMARY_POLL_MS, true)

  return (
    <div>
      {summaryFailed && summary && summaryAt && (
        <Notification
          type="warning"
          content={t('template_gallery_admin_monitor_poll_failed', {
            time: formatDateTime(summaryAt, t),
          })}
          className="mb-4"
        />
      )}
      {status && !status.ready && (
        <Notification
          type="error"
          content={t('template_gallery_admin_monitor_not_ready_notice')}
          className="mb-4"
        />
      )}
      {statusError && (
        <Notification
          type="error"
          content={errorMessage(t, statusError)}
          className="mb-4"
        />
      )}

      {status === null && statusError === null && (
        <div className="py-5 text-center">
          <OLSpinner />
          <span className="visually-hidden">{t('loading')}</span>
        </div>
      )}

      {status && (
        <OLRow className="g-4">
          <OLCol xs={12} lg={6}>
            <CrawlerCard
              overview={status.sync}
              run={summary?.run ?? null}
              onChanged={reloadAll}
              onFlash={onFlash}
            />
          </OLCol>
          {summary && (
            <OLCol xs={12} lg={6}>
              <SummaryCard
                summary={summary}
                onShowTemplates={onShowTemplates}
              />
            </OLCol>
          )}
          {status.storage && (
            <OLCol xs={12} lg={6}>
              <StorageCard storage={status.storage} />
            </OLCol>
          )}
          <OLCol xs={12} lg={6}>
            <DedupCard onFlash={onFlash} />
          </OLCol>
        </OLRow>
      )}
    </div>
  )
}
