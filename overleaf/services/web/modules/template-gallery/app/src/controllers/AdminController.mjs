import Path from 'node:path'
import Lifecycle from '../Lifecycle.mjs'
import StorageHealth from '../storage/StorageHealth.mjs'
import StorageUsage from '../storage/StorageUsage.mjs'
import Scheduler from '../jobs/Scheduler.mjs'
import SyncSettings from '../jobs/SyncSettings.mjs'
import SyncRun from '../jobs/SyncRun.mjs'
import CatalogueService from '../services/CatalogueService.mjs'
import TemplateCrawlerService from '../services/TemplateCrawlerService.mjs'
import TemplateHydrationService from '../services/TemplateHydrationService.mjs'
import TemplateSourceAcquisitionService from '../services/TemplateSourceAcquisitionService.mjs'
import SessionCredentialStore from '../crypto/SessionCredentialStore.mjs'
import { configCol } from '../persistence/Collections.mjs'
import { logError } from '../observability/Log.mjs'
import { refetchReason } from '../transport/RefetchReason.mjs'

const VIEWS_DIR = Path.resolve(import.meta.dirname, '../../views')
const SYNC_FILTERS = Object.freeze([
  'all',
  'ok',
  'syncing',
  'queued',
  'failed',
  'removed',
])
const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100

// Error envelope: { error: <code> }. Unexpected errors are logged and answered
// as 'internal'. The codes are the ones the admin client maps.
function sendCode(res, status, code) {
  return res.status(status).json({ error: code })
}

function sendInternal(res, err) {
  logError('tg.admin.internal', err)
  return sendCode(res, 500, 'internal')
}

function sendNotFound(res) {
  return sendCode(res, 404, 'not_found')
}

function iso(value) {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function parsePositiveInt(value, fallback, max = Infinity) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return Math.min(parsed, max)
}

function queryString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

// Id first, then slug: the admin views have always accepted either.
// Returns the stored document (with _id), not the ItemDetail view.
async function findItemByIdOrSlug(idOrSlug, projection) {
  const value = String(idOrSlug || '')
  return (
    (await CatalogueService.findItemDoc(value, projection)) ||
    (await CatalogueService.findItemDocBySlug(value, projection))
  )
}

// Source acquisition synthesises from mainText, so it needs the full document
const SOURCE_PROJECTION = Object.freeze({ thumbDataUri: 0 })

const DAY_MS = 24 * 60 * 60 * 1000

// When the next automatic sync starts, or null while automatic sync is off
function nextAutoRunAt(settings, lastRun) {
  if (!settings.autoSync) return null
  if (lastRun?.state === 'running') return null
  if (!lastRun?.startedAt) return new Date().toISOString()
  return iso(
    new Date(lastRun.startedAt).getTime() + settings.refetchDays * DAY_MS
  )
}

export function renderAdminPage(req, res) {
  return res.render(Path.join(VIEWS_DIR, 'admin'), {
    title: 'Template Gallery Admin',
  })
}

/**
 * Item page (/admin/templates/items/:id). Accepts an _id, token or slug; the
 * token and slug forms redirect to the canonical _id.
 */
export async function renderItemPage(req, res, next) {
  try {
    const id = String(req.params.id || '')
    const item = await findItemByIdOrSlug(id)
    if (!item) {
      return res.status(404).render(Path.join(VIEWS_DIR, 'error'), {
        statusCode: 404,
        title: 'Template not found',
        message: 'This template does not exist or is no longer available.',
      })
    }
    const canonicalId = String(item._id)
    if (canonicalId !== id) {
      return res.redirect(
        302,
        `/admin/templates/items/${encodeURIComponent(canonicalId)}`
      )
    }
    return res.render(Path.join(VIEWS_DIR, 'item'), {
      title: 'Template Gallery Item',
      itemId: canonicalId,
    })
  } catch (err) {
    return next(err)
  }
}

export async function getStatus(req, res) {
  try {
    const [storageOk, catalogue, settings, lastRun, usage] = await Promise.all([
      StorageHealth.probe().then(
        (probe) => Boolean(probe?.ok),
        () => false
      ),
      TemplateCrawlerService.getCatalogueState(),
      SyncSettings.get(),
      SyncRun.read(),
      StorageUsage.measure().catch(() => null),
    ])
    return res.status(200).json({
      ready: Lifecycle.isReady() && storageOk,
      sync: {
        autoSync: settings.autoSync,
        refetchDays: settings.refetchDays,
        nextAutoRunAt: nextAutoRunAt(settings, lastRun),
        listUpdatedAt: iso(catalogue?.finishedAt),
      },
      storage: usage && {
        usedBytes: usage.usedBytes,
        files: usage.files,
        freeBytes: usage.freeBytes,
        totalBytes: usage.totalBytes,
      },
    })
  } catch (err) {
    return sendInternal(res, err)
  }
}

export async function getStatusSummary(req, res) {
  try {
    const [summary, run] = await Promise.all([
      CatalogueService.getSummaryCounts(),
      SyncRun.read(),
    ])
    return res.status(200).json({
      counts: summary.counts,
      run: SyncRun.view(run),
    })
  } catch (err) {
    return sendInternal(res, err)
  }
}

export async function listItems(req, res) {
  try {
    const sync = SYNC_FILTERS.includes(req.query?.sync)
      ? req.query.sync
      : 'all'
    const result = await CatalogueService.listAdmin({
      q: queryString(req.query?.q),
      sync,
      page: parsePositiveInt(req.query?.page, 1),
      pageSize: parsePositiveInt(
        req.query?.pageSize,
        DEFAULT_PAGE_SIZE,
        MAX_PAGE_SIZE
      ),
    })
    return res.status(200).json(result)
  } catch (err) {
    return sendInternal(res, err)
  }
}

export async function getItem(req, res) {
  try {
    const item = await findItemByIdOrSlug(req.params.id)
    if (!item) return sendNotFound(res)
    const syncing = await SyncRun.syncingTokens()
    return res
      .status(200)
      .json({ item: CatalogueService.toItemDetail(item, syncing) })
  } catch (err) {
    return sendInternal(res, err)
  }
}

/**
 * Re-reads the item and returns its sync block, after a refetch.
 */
async function currentSync(id, fallback) {
  const fresh = (await CatalogueService.getItemById(id)) || fallback
  return CatalogueService.toSyncBlock(fresh)
}

function retryAtOf(err) {
  const at = err?.retryAt
  if (at instanceof Date && !Number.isNaN(at.getTime())) return at.toISOString()
  return typeof at === 'string' ? at : null
}

export async function hydrateItem(req, res) {
  try {
    const item = await findItemByIdOrSlug(req.params.id)
    if (!item) return sendNotFound(res)
    const id = String(item._id)
    let failure = null
    try {
      await TemplateHydrationService.hydrateItem(id, { force: true })
    } catch (err) {
      failure = err
      logError('tg.admin.hydrate_failed', err)
    }
    const sync = await currentSync(id, item)
    const failed = Boolean(failure) || sync.detailStatus === 'failed'
    return res.status(200).json({
      status: failed ? 'failed' : 'ok',
      reason: failed ? (failure ? refetchReason(failure) : 'failed') : null,
      retryAt: failed ? retryAtOf(failure) : null,
      sync,
    })
  } catch (err) {
    return sendInternal(res, err)
  }
}

// The reason for a source refetch that did not produce a zip
function sourceReason(failure, result) {
  if (failure) return refetchReason(failure)
  if (result?.backoff) return 'backoff'
  const code = result?.code ?? result?.reason
  return code ? refetchReason({ code }) : 'failed'
}

export async function refetchSource(req, res) {
  try {
    const item = await findItemByIdOrSlug(req.params.id, SOURCE_PROJECTION)
    if (!item) return sendNotFound(res)
    const id = String(item._id)
    // force skips the cache, not the single-flight: an acquisition already in
    // flight for this item is reported as busy instead of being duplicated.
    if (TemplateSourceAcquisitionService.isAcquiring(item)) {
      return sendCode(res, 409, 'source_in_progress')
    }
    let result
    let failure = null
    try {
      // The admin asked for this now: it skips the item's acquisition backoff
      // and waits longer for a route than a public view does.
      result = await TemplateSourceAcquisitionService.acquire(item, {
        force: true,
        priority: 'admin',
      })
    } catch (err) {
      failure = err
      logError('tg.admin.source_failed', err)
      result = { status: 'failed' }
    }
    if (result?.status === 'in_progress') {
      return sendCode(res, 409, 'source_in_progress')
    }
    // A failed refetch can still come back acquired (the cached zip is served)
    const status =
      result?.status ??
      (result?.refetchFailed
        ? 'failed'
        : result?.acquired
          ? 'ok'
          : result?.backoff
            ? 'backoff'
            : 'failed')
    const reason = status === 'ok' ? null : sourceReason(failure, result)
    const retryAt = status === 'backoff' ? result?.retryAt ?? null : null
    const sync = await currentSync(id, item)
    return res.status(200).json({ status, reason, retryAt, sync })
  } catch (err) {
    return sendInternal(res, err)
  }
}

export async function triggerCrawlerSync(req, res) {
  const action = String(req.body?.action || '')
  if (!Scheduler.REQUEST_ACTIONS.includes(action)) {
    return sendCode(res, 400, 'invalid_action')
  }
  try {
    const result = await Scheduler.requestRun(action, adminId(req), {
      rescan: req.body?.rescan === true,
    })
    return res.status(202).json({ accepted: true, runId: result.runId })
  } catch (err) {
    if (err?.code === 'run_active') return sendCode(res, 409, 'run_active')
    return sendInternal(res, err)
  }
}

export async function stopCrawlerSync(req, res) {
  try {
    await Scheduler.requestStop()
    return res.status(202).json({ stopping: true })
  } catch (err) {
    if (err?.code === 'not_running') return sendCode(res, 409, 'not_running')
    return sendInternal(res, err)
  }
}

function adminId(req) {
  const id = req.session?.user?._id
  return id ? String(id) : null
}

export async function getSyncSettings(req, res) {
  try {
    return res.status(200).json(await SyncSettings.get())
  } catch (err) {
    return sendInternal(res, err)
  }
}

export async function saveSyncSettings(req, res) {
  try {
    const saved = await SyncSettings.save({
      autoSync: req.body?.autoSync,
      refetchDays: req.body?.refetchDays,
    })
    return res.status(200).json(saved)
  } catch (err) {
    if (err?.code === 'invalid_refetch_days' || err?.code === 'invalid_auto_sync') {
      return sendCode(res, 400, err.code)
    }
    return sendInternal(res, err)
  }
}

export async function getCredential(req, res) {
  try {
    return res
      .status(200)
      .json(await SessionCredentialStore.getStatus(await configCol()))
  } catch (err) {
    return sendInternal(res, err)
  }
}

export async function saveSessionCookie(req, res) {
  const cookie =
    typeof req.body?.cookie === 'string' ? req.body.cookie.trim() : ''
  if (!cookie) return sendCode(res, 400, 'invalid_cookie')
  try {
    const col = await configCol()
    const saved = await SessionCredentialStore.saveSessionCredential(col, cookie)
    return res.status(200).json({
      configured: true,
      updatedAt: iso(saved?.updatedAt),
      invalid: false,
    })
  } catch (err) {
    return sendInternal(res, err)
  }
}

export async function deleteSessionCookie(req, res) {
  try {
    const col = await configCol()
    await SessionCredentialStore.clearSessionCredential(col)
    return res.status(200).json({
      configured: false,
      updatedAt: null,
      invalid: false,
    })
  } catch (err) {
    return sendInternal(res, err)
  }
}

const AdminController = {
  renderAdminPage,
  renderItemPage,
  getStatus,
  getStatusSummary,
  listItems,
  getItem,
  hydrateItem,
  refetchSource,
  triggerCrawlerSync,
  stopCrawlerSync,
  getSyncSettings,
  saveSyncSettings,
  getCredential,
  saveSessionCookie,
  deleteSessionCookie,
}

export default AdminController
