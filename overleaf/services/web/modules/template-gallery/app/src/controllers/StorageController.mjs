// overleaf/services/web/modules/template-gallery/app/src/controllers/StorageController.mjs
//
// Admin API of the storage and dedup collector (storage/DedupCollector.mjs).
// Routes are mounted in TemplateGalleryRouter.mjs under /admin/templates/api/storage.
import JobStore from '../jobs/JobStore.mjs'
import { jobsCol } from '../persistence/Collections.mjs'
import DedupCollector from '../storage/DedupCollector.mjs'
import StorageUsage from '../storage/StorageUsage.mjs'
import { isValidToken } from '../util/GalleryUrls.mjs'
import { logError } from '../observability/Log.mjs'

function sendCode(res, status, code) {
  return res.status(status).json({ error: code })
}

function sendInternal(res, err) {
  logError('tg.storage.internal', err)
  return sendCode(res, 500, 'internal')
}

function adminId(req) {
  const id = req.session?.user?._id
  return id ? String(id) : null
}

const isoOrNull = value => (value ? new Date(value).toISOString() : null)

// The dedup job that is queued or running, if any (payload stays server side)
async function activeDedupJob() {
  const col = await jobsCol()
  const job = await col.findOne(
    { kind: 'dedup', state: { $in: ['queued', 'running'] } },
    { sort: { createdAt: -1 } }
  )
  if (!job) return null
  const safe = JobStore.sanitizeJob(job)
  return {
    id: safe._id,
    state: safe.state,
    attempt: safe.attempt,
    createdAt: isoOrNull(safe.createdAt),
  }
}

/** GET /storage/dedup: last report, live counts, storage areas, active job */
export async function getDedupStatus(req, res) {
  try {
    const [status, usage, running] = await Promise.all([
      DedupCollector.getStatus(),
      StorageUsage.measure().catch(() => null),
      activeDedupJob(),
    ])
    return res.status(200).json({
      report: status.report,
      lastRunAt: isoOrNull(status.lastRunAt),
      tombstones: status.tombstones,
      pendingPurge: status.pendingPurge,
      running,
      storage: usage && {
        usedBytes: usage.usedBytes,
        files: usage.files,
        areas: usage.areas,
        freeBytes: usage.freeBytes,
        totalBytes: usage.totalBytes,
        measuredAt: isoOrNull(usage.measuredAt),
      },
    })
  } catch (err) {
    return sendInternal(res, err)
  }
}

/**
 * POST /storage/dedup/runs { dryRun?: boolean, purge?: boolean }
 * dryRun defaults to true (a preview). Clean: { dryRun: false }. purge is
 * only honoured for a clean run.
 */
export async function runDedup(req, res) {
  const body = req.body ?? {}
  if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
    return sendCode(res, 400, 'invalid_option')
  }
  if (body.purge !== undefined && typeof body.purge !== 'boolean') {
    return sendCode(res, 400, 'invalid_option')
  }
  const dryRun = body.dryRun !== false
  const purge = !dryRun && body.purge === true
  const mode = dryRun ? 'preview' : purge ? 'clean_purge' : 'clean'
  try {
    const { job, deduped } = await JobStore.enqueue({
      kind: 'dedup',
      dedupeKey: `admin:dedup:${mode}`,
      requestedBy: adminId(req),
      maxAttempts: 1,
      payload: { dryRun, purge },
    })
    return res.status(202).json({ queued: true, deduped, jobId: job._id, dryRun, purge })
  } catch (err) {
    return sendInternal(res, err)
  }
}

/** GET /storage/dedup/duplicates?limit=n: tombstones, newest first */
export async function listDuplicates(req, res) {
  try {
    const rows = await DedupCollector.listTombstones({ limit: req.query?.limit })
    return res.status(200).json({
      duplicates: rows.map(row => ({
        token: row.token,
        title: row.title || '',
        canonical: row.duplicateOf,
        duplicateAt: isoOrNull(row.duplicateAt),
        slug: row.slug || null,
        family: row.family || null,
      })),
    })
  } catch (err) {
    return sendInternal(res, err)
  }
}

/** POST /storage/dedup/duplicates/:token/restore */
export async function restoreDuplicate(req, res) {
  const token = req.params?.token
  if (!isValidToken(token)) return sendCode(res, 400, 'invalid_token')
  try {
    const result = await DedupCollector.restoreDuplicate(token)
    if (!result.restored) {
      return sendCode(res, result.reason === 'invalid_token' ? 400 : 404, result.reason)
    }
    return res.status(200).json({ restored: true, token, canonical: result.canonical })
  } catch (err) {
    return sendInternal(res, err)
  }
}

export default {
  getDedupStatus,
  runDedup,
  listDuplicates,
  restoreDuplicate,
}
