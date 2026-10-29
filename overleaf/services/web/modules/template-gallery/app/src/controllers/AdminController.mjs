import fs from 'node:fs'
import Path from 'node:path'
import multer from 'multer'
import Settings from '@overleaf/settings'
import SessionManager from '../../../../../app/src/Features/Authentication/SessionManager.mjs'
import Lifecycle from '../Lifecycle.mjs'
import StorageHealth from '../storage/StorageHealth.mjs'
import BlobStore from '../storage/BlobStore.mjs'
import Paths from '../storage/Paths.mjs'
import SandboxGate from '../validation/SandboxGate.mjs'
import Runner from '../jobs/Runner.mjs'
import JobStore from '../jobs/JobStore.mjs'
import Lock from '../jobs/Lock.mjs'
import CatalogueService from '../services/CatalogueService.mjs'
import ItemService from '../services/ItemService.mjs'
import PublishGate from '../services/PublishGate.mjs'
import ImageMapper from '../services/ImageMapper.mjs'
import TemplateCrawlerService from '../services/TemplateCrawlerService.mjs'
import TemplateHydrationService from '../services/TemplateHydrationService.mjs'
import Tier4AdminUploadAcquisition from '../services/tiers/Tier4AdminUploadAcquisition.mjs'
import SessionCredentialStore from '../crypto/SessionCredentialStore.mjs'
import { itemsCol, jobsCol, configCol, tagsCol, listingsCol } from '../persistence/Collections.mjs'
import Scheduler from '../jobs/Scheduler.mjs'
import HostLimiter from '../transport/HostLimiter.mjs'
import Audit from '../persistence/Audit.mjs'
import { logWarn, logError } from '../observability/Log.mjs'

const VIEWS_DIR = Path.resolve(import.meta.dirname, '../../views')

function createZipUploadMiddleware() {
  const cfg = Settings.templateGallery || {}
  const storageDir = cfg.storageDir || '/var/lib/overleaf/data/template-gallery'
  const maxZipBytes = Math.min(
    cfg.limits?.maxZipBytes || 50 * 1024 * 1024,
    Settings.maxUploadSize || 50 * 1024 * 1024
  )
  const storage = multer.diskStorage({
    destination(req, file, cb) {
      const tmpDir = Path.join(storageDir, 'tmp')
      fs.mkdirSync(tmpDir, { recursive: true })
      cb(null, tmpDir)
    },
    filename(req, file, cb) {
      cb(null, Path.basename(Paths.tmpPath(storageDir, undefined, '.upload')))
    },
  })
  return multer({ storage, limits: { fileSize: maxZipBytes } }).single('archive')
}

function createThumbnailUploadMiddleware() {
  const cfg = Settings.templateGallery || {}
  const storageDir = cfg.storageDir || '/var/lib/overleaf/data/template-gallery'
  const maxThumbnailBytes = cfg.limits?.maxThumbnailBytes || 512 * 1024
  const storage = multer.diskStorage({
    destination(req, file, cb) {
      const tmpDir = Path.join(storageDir, 'tmp')
      fs.mkdirSync(tmpDir, { recursive: true })
      cb(null, tmpDir)
    },
    filename(req, file, cb) {
      cb(null, Path.basename(Paths.tmpPath(storageDir, undefined, '.thumb')))
    },
  })
  return multer({ storage, limits: { fileSize: maxThumbnailBytes } }).single('thumbnail')
}

export function renderAdminPage(req, res) {
  return res.render(Path.join(VIEWS_DIR, 'admin'), {
    title: 'Template Gallery Admin',
    csrfToken: req.csrfToken ? req.csrfToken() : '',
  })
}

export async function getStatus(req, res) {
  const cfg = Settings.templateGallery || {}
  try {
    const [
      probe,
      crawler,
      runnerStatus,
      runtimeDoc,
      usageDoc,
      credDoc,
      itemsCollection,
      jobsCollection,
      tagsCollection,
      schedulerStatus,
      catalogueDoc,
    ] = await Promise.all([
      StorageHealth.probe(cfg).catch(err => ({ ok: false, code: err?.code || 'probe_failed' })),
      TemplateCrawlerService.getStatus().catch(() => ({ status: 'IDLE' })),
      Promise.resolve(Runner.getStatus ? Runner.getStatus() : {}),
      configCol().then(c => c.findOne({ _id: 'runtime' })).catch(() => null),
      configCol().then(c => c.findOne({ _id: 'usage' })).catch(() => null),
      configCol().then(c => c.findOne({ _id: 'credentials' })).catch(() => null),
      itemsCol().catch(() => null),
      jobsCol().catch(() => null),
      tagsCol().catch(() => null),
      Scheduler.getStatus().catch(() => ({})),
      TemplateCrawlerService.getCatalogueState().catch(() => null),
    ])

    const sandbox = SandboxGate.check(cfg, runtimeDoc || {})
    const hostLimiter = HostLimiter.getHostStatus()

    let totalCount = 0
    let withDetail = 0
    let withPdf = 0
    let withThumb = 0
    const stateCounts = {}
    const tierCounts = { 1: 0, 2: 0, 3: 0, 4: 0 }

    if (itemsCollection && typeof itemsCollection.find === 'function') {
      const allItems = await itemsCollection
        .find(
          {},
          {
            projection: {
              state: 1,
              acquisitionTier: 1,
              'mirror.detailAt': 1,
              'mirror.pdfAt': 1,
              'mirror.thumbAt': 1,
              media: 1,
            },
          }
        )
        .toArray()
        .catch(() => [])

      totalCount = allItems.length
      for (const it of allItems) {
        const st = it.state || 'published'
        stateCounts[st] = (stateCounts[st] || 0) + 1
        if (it.acquisitionTier) {
          tierCounts[it.acquisitionTier] = (tierCounts[it.acquisitionTier] || 0) + 1
        }
        if (it.mirror?.detailAt || it.abstractHtml) {
          withDetail++
        }
        if (it.media?.pdfSha || it.mirror?.pdfAt) {
          withPdf++
        }
        if (it.media?.thumbSha || it.mirror?.thumbAt || it.thumbDataUri) {
          withThumb++
        }
      }
    } else if (itemsCollection && typeof itemsCollection.countDocuments === 'function') {
      totalCount = await itemsCollection.countDocuments({}).catch(() => 0)
    }

    let tagsScraped = 0
    if (tagsCollection && typeof tagsCollection.countDocuments === 'function') {
      tagsScraped = await tagsCollection
        .countDocuments({
          $or: [
            { byScope: { $exists: true, $ne: null } },
            { 'byScope.templates.scrapedAt': { $exists: true } },
            { catalogAt: { $exists: true } },
          ],
        })
        .catch(() => 0)
    } else if (tagsCollection && typeof tagsCollection.find === 'function') {
      const allTags = await tagsCollection.find({}).toArray().catch(() => [])
      tagsScraped = allTags.filter(
        t => (t.byScope && Object.keys(t.byScope).length > 0) || t.catalogAt
      ).length
    }

    let queuedJobs = 0
    let runningJobs = 0
    if (jobsCollection && typeof jobsCollection.countDocuments === 'function') {
      queuedJobs = await jobsCollection.countDocuments({ state: 'queued' }).catch(() => 0)
      runningJobs = await jobsCollection.countDocuments({ state: 'running' }).catch(() => 0)
    }

    const mirrorCounts = {
      total: totalCount,
      withDetail,
      withPdf,
      withThumb,
      tagsScraped,
      // snake_case aliases for convenience
      with_detail: withDetail,
      with_pdf: withPdf,
      with_thumb: withThumb,
      tags_scraped: tagsScraped,
    }

    const mirror = {
      counts: mirrorCounts,
      recentScan: schedulerStatus?.recentScan || null,
      hostLimiter,
      lastCatalogue: catalogueDoc || null,
      scheduler: schedulerStatus || {},
      paused: Boolean(crawler?.paused),
    }

    return res.status(200).json({
      ready: Lifecycle.isReady(),
      readiness: Lifecycle.getReadinessState(),
      storage: {
        storageDir: cfg.storageDir,
        mounted: Boolean(probe?.ok),
        code: probe?.code || 'ok',
        acceptedParent: probe?.acceptedParent || null,
        writable: Boolean(probe?.ok),
        freeBytes: probe?.freeBytes ?? 0,
        usageBytes: usageDoc?.bytes ?? 0,
        capBytes: cfg.storage?.maxStorageBytes ?? 0,
      },
      crawler: {
        ...crawler,
        status: crawler?.catalogue?.status || (crawler?.running ? 'RUNNING' : 'IDLE'),
        totalIndexed: totalCount,
        mirror,
      },
      mirror,
      runner: runnerStatus,
      jobs: { queued: queuedJobs, running: runningJobs },
      items: { byState: stateCounts, byTier: tierCounts },
      sandbox,
      credentials: {
        configured: Boolean(credDoc?.ciphertext),
        valid: credDoc ? credDoc.valid !== false : false,
        updatedAt: credDoc?.updatedAt || null,
        invalidReason: credDoc?.invalidReason || null,
      },
      images: {
        allowed: Array.isArray(Settings.allowedImageNames) ? Settings.allowedImageNames : [],
        map: cfg.images?.map || {},
      },
    })
  } catch (err) {
    logError('tg.admin.status_failed', err)
    return res.status(500).json({ error: 'status_failed', message: err?.message })
  }
}

export async function listItems(req, res) {
  try {
    const state = req.query?.state ? String(req.query.state) : undefined
    const tier = req.query?.tier ? Number(req.query.tier) : undefined
    const q = req.query?.q ? String(req.query.q) : undefined
    const page = Math.max(1, Number.parseInt(String(req.query?.page || '1'), 10) || 1)
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(String(req.query?.pageSize || '25'), 10) || 25))

    const result = await CatalogueService.listAdmin({ state, tier, q, page, pageSize })
    return res.status(200).json(result)
  } catch (err) {
    logError('tg.admin.list_items_failed', err)
    return res.status(500).json({ error: 'list_failed' })
  }
}

export async function getItem(req, res) {
  const cfg = Settings.templateGallery || {}
  try {
    const idOrSlug = String(req.params.id || '')
    const item = (await ItemService.getById(idOrSlug)) || (await ItemService.getBySlug(idOrSlug))
    if (!item) return res.status(404).json({ error: 'item_not_found' })

    const runtimeDoc = await configCol()
      .then(c => c.findOne({ _id: 'runtime' }))
      .catch(() => null)
    const gate = PublishGate.evaluate(item, cfg, runtimeDoc || {})

    return res.status(200).json({ item, publishGate: gate })
  } catch (err) {
    logError('tg.admin.get_item_failed', err)
    return res.status(500).json({ error: 'get_item_failed' })
  }
}

export async function patchItem(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  try {
    const updated = await ItemService.updateMetadata(req.params.id, req.body || {}, userId)
    if (!updated) return res.status(404).json({ error: 'item_not_found' })
    return res.status(200).json({ item: updated })
  } catch (err) {
    const code = err?.code || 'update_failed'
    const status =
      code === 'revision_conflict'
        ? 409
        : code === 'item_not_found' || code === 'not_found'
          ? 404
          : 400
    return res.status(status).json({ error: code, message: err?.message })
  }
}

export function uploadByoZip(req, res) {
  if (!Lifecycle.isReady()) {
    return res.status(503).json({ error: 'gallery_unavailable' })
  }
  const upload = createZipUploadMiddleware()
  upload(req, res, async err => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'file_too_large' })
      return res.status(400).json({ error: 'upload_error', message: err.message })
    }
    if (!req.file?.path) {
      return res.status(400).json({ error: 'missing_archive' })
    }
    const userId = SessionManager.getLoggedInUserId(req.session)
    const cfg = Settings.templateGallery || {}
    try {
      let meta = {}
      if (typeof req.body?.meta === 'string') {
        meta = JSON.parse(req.body.meta)
      } else if (req.body && typeof req.body === 'object') {
        meta = req.body
      }
      const result = await Tier4AdminUploadAcquisition.ingestAdminZip(req.file.path, meta, userId, cfg)
      return res.status(202).json(result)
    } catch (ingestErr) {
      const code = ingestErr?.code || 'invalid_zip'
      const status = code === 'duplicate_zip' ? 409 : code === 'quota_exceeded' ? 507 : 422
      return res.status(status).json({ error: code, message: ingestErr?.message })
    } finally {
      fs.promises.unlink(req.file.path).catch(() => {})
    }
  })
}

export function replaceItemPackage(req, res) {
  if (!Lifecycle.isReady()) {
    return res.status(503).json({ error: 'gallery_unavailable' })
  }
  const upload = createZipUploadMiddleware()
  upload(req, res, async err => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'file_too_large' })
      return res.status(400).json({ error: 'upload_error', message: err.message })
    }
    if (!req.file?.path) {
      return res.status(400).json({ error: 'missing_archive' })
    }
    const userId = SessionManager.getLoggedInUserId(req.session)
    const cfg = Settings.templateGallery || {}
    try {
      const meta = { ...(req.body || {}), itemId: req.params.id, replaceExisting: true }
      const result = await Tier4AdminUploadAcquisition.ingestAdminZip(req.file.path, meta, userId, cfg)
      return res.status(202).json(result)
    } catch (ingestErr) {
      const code = ingestErr?.code || 'invalid_zip'
      return res.status(422).json({ error: code, message: ingestErr?.message })
    } finally {
      fs.promises.unlink(req.file.path).catch(() => {})
    }
  })
}

export function uploadThumbnail(req, res) {
  const upload = createThumbnailUploadMiddleware()
  upload(req, res, async err => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'file_too_large' })
      return res.status(400).json({ error: 'upload_error', message: err.message })
    }
    if (!req.file?.path) return res.status(400).json({ error: 'missing_thumbnail' })
    const cfg = Settings.templateGallery || {}
    try {
      const buf = await fs.promises.readFile(req.file.path)
      const isPng =
        buf.length >= 8 &&
        buf[0] === 0x89 &&
        buf[1] === 0x50 &&
        buf[2] === 0x4e &&
        buf[3] === 0x47
      const isJpeg = buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
      if (!isPng && !isJpeg) {
        return res.status(422).json({ error: 'invalid_image_magic' })
      }
      const mime = isPng ? 'image/png' : 'image/jpeg'
      const committed = await BlobStore.putBuffer(buf, {
        maxBytes: cfg.limits?.maxThumbnailBytes || 512 * 1024,
        storageDir: cfg.storageDir,
      })
      const col = await itemsCol()
      const filter = { $or: [ItemService.toIdFilter(req.params.id), { slug: req.params.id }] }
      const updateResult = await col.updateOne(
        filter,
        {
          $set: {
            'media.thumbSha': committed.sha256,
            'media.thumbMime': mime,
            'mirror.thumbAt': new Date(),
            thumbnail: { sha256: committed.sha256, mime, sizeBytes: committed.sizeBytes },
            updatedAt: new Date(),
          },
        }
      )
      if (updateResult.matchedCount === 0) {
        return res.status(404).json({ error: 'item_not_found' })
      }
      return res.status(200).json({ thumbnail: { sha256: committed.sha256, mime, sizeBytes: committed.sizeBytes } })
    } catch (thumbErr) {
      return res.status(422).json({ error: 'thumbnail_failed', message: thumbErr?.message })
    } finally {
      fs.promises.unlink(req.file.path).catch(() => {})
    }
  })
}

export async function validateItem(req, res) {
  const cfg = Settings.templateGallery || {}
  const userId = SessionManager.getLoggedInUserId(req.session)
  try {
    const idOrSlug = String(req.params.id || '')
    const item = (await ItemService.getById(idOrSlug)) || (await ItemService.getBySlug(idOrSlug))
    if (!item) return res.status(404).json({ error: 'item_not_found' })

    const zipSha = item.sourceBlobStoreKey || item.zip?.sha256
    if (!zipSha) return res.status(422).json({ error: 'source_missing' })

    const compileHash = ImageMapper.computeCompileHash(item.compile || {})
    const job = await JobStore.enqueue(
      {
        kind: 'validate',
        itemId: item._id || item.slug,
        zipSha256Expected: zipSha,
        compileHash,
        dedupeKey: `validate:${item._id || item.slug}`,
        requestedBy: userId ? String(userId) : null,
        maxAttempts: cfg.validation?.maxAttempts || 3,
      },
      cfg
    )
    return res.status(202).json({ jobId: job._id, state: job.state })
  } catch (err) {
    if (err?.code === 'queue_full') {
      return res.status(429).json({ error: 'queue_full' })
    }
    return res.status(500).json({ error: 'validate_enqueue_failed', message: err?.message })
  }
}

export async function hydrateItem(req, res) {
  const cfg = Settings.templateGallery || {}
  try {
    const item = await TemplateHydrationService.hydrateItem(req.params.id, { cfg, force: true })
    if (!item) return res.status(404).json({ error: 'item_not_found' })
    return res.status(200).json({ item })
  } catch (err) {
    return res.status(500).json({ error: 'hydration_failed', message: err?.message })
  }
}

export async function acknowledgeLicence(req, res) {
  const cfg = Settings.templateGallery || {}
  const userId = SessionManager.getLoggedInUserId(req.session)
  try {
    const note = String(req.body?.note || '')
    const item = await ItemService.acknowledgeLicence(req.params.id, note, userId, cfg)
    return res.status(200).json({ item })
  } catch (err) {
    const code = err?.code || 'ack_failed'
    const status =
      code === 'licence_blocked'
        ? 409
        : code === 'item_not_found' || code === 'not_found'
          ? 404
          : 400
    return res.status(status).json({ error: code, message: err?.message })
  }
}

export async function publishItem(req, res) {
  const cfg = Settings.templateGallery || {}
  const userId = SessionManager.getLoggedInUserId(req.session)
  try {
    const runtimeDoc = await configCol()
      .then(c => c.findOne({ _id: 'runtime' }))
      .catch(() => null)
    const result = await ItemService.publish(req.params.id, userId, cfg, runtimeDoc || {})
    if (result?.unmet) {
      return res.status(422).json({ error: 'publish_gate_unmet', unmet: result.unmet })
    }
    return res.status(200).json({ item: result.item || result })
  } catch (err) {
    if (err?.unmet) {
      return res.status(422).json({ error: 'publish_gate_unmet', unmet: err.unmet })
    }
    const status = err?.code === 'item_not_found' || err?.code === 'not_found' ? 404 : 422
    return res.status(status).json({ error: err?.code || 'publish_failed', message: err?.message })
  }
}

export async function unpublishItem(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  try {
    const item = await ItemService.unpublish(req.params.id, userId)
    if (!item) return res.status(404).json({ error: 'item_not_found' })
    return res.status(200).json({ item })
  } catch (err) {
    const status = err?.code === 'item_not_found' || err?.code === 'not_found' ? 404 : 400
    return res.status(status).json({ error: err?.code || 'unpublish_failed', message: err?.message })
  }
}

export async function archiveItem(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  try {
    const item = await ItemService.archive(req.params.id, userId)
    if (!item) return res.status(404).json({ error: 'item_not_found' })
    return res.status(200).json({ item })
  } catch (err) {
    const status = err?.code === 'item_not_found' || err?.code === 'not_found' ? 404 : 400
    return res.status(status).json({ error: err?.code || 'archive_failed', message: err?.message })
  }
}

export async function deleteItem(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  try {
    const confirmSlug = String(req.body?.confirmSlug || '')
    await ItemService.deleteItem(req.params.id, confirmSlug, userId)
    return res.status(200).json({ deleted: true })
  } catch (err) {
    const status = err?.code === 'item_not_found' || err?.code === 'not_found' ? 404 : 400
    return res.status(status).json({ error: err?.code || 'delete_failed', message: err?.message })
  }
}

export async function getValidationLog(req, res) {
  const cfg = Settings.templateGallery || {}
  try {
    const idOrSlug = String(req.params.id || '')
    const item = (await ItemService.getById(idOrSlug)) || (await ItemService.getBySlug(idOrSlug))
    if (!item || !item.validation?.logSha256) {
      return res.status(404).json({ error: 'log_not_found' })
    }
    const buf = await BlobStore.readBuffer(item.validation.logSha256, cfg.storageDir)
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    return res.status(200).send(buf.toString('utf8'))
  } catch (err) {
    return res.status(404).json({ error: 'log_not_found', message: err?.message })
  }
}

export async function getJob(req, res) {
  try {
    const col = await jobsCol()
    const job = await col.findOne({ _id: req.params.id })
    if (!job) return res.status(404).json({ error: 'job_not_found' })
    return res.status(200).json({ job })
  } catch (err) {
    return res.status(500).json({ error: 'job_lookup_failed' })
  }
}

export async function triggerCrawlerSync(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  try {
    const action =
      req.body?.action ||
      (req.body?.recent ? (req.body?.full ? 'recent-full' : 'recent') : 'catalogue')
    const result = await Scheduler.requestRun(action, userId ? String(userId) : null)
    return res.status(202).json(result)
  } catch (err) {
    return res.status(500).json({ error: 'crawler_sync_failed', message: err?.message })
  }
}

export async function triggerCatalogue(req, res) {
  return triggerCrawlerSync({ ...req, body: { ...req.body, action: 'catalogue' } }, res)
}

export async function triggerRecentScan(req, res) {
  const full = Boolean(req.body?.full)
  return triggerCrawlerSync(
    { ...req, body: { ...req.body, action: full ? 'recent-full' : 'recent' } },
    res
  )
}

export async function pauseCrawler(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  try {
    const state = await TemplateCrawlerService.pause(userId ? String(userId) : null)
    return res.status(200).json({ paused: true, crawler: state })
  } catch (err) {
    return res.status(500).json({ error: 'crawler_pause_failed', message: err?.message })
  }
}

export async function resumeCrawler(req, res) {
  try {
    const state = await TemplateCrawlerService.resume()
    return res.status(200).json({ paused: false, crawler: state })
  } catch (err) {
    return res.status(500).json({ error: 'crawler_resume_failed', message: err?.message })
  }
}

export async function saveSessionCookie(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  try {
    const cookieValue = String(req.body?.cookie || req.body?.overleafSession2 || '').trim()
    if (!cookieValue) {
      return res.status(400).json({ error: 'cookie_required' })
    }
    const col = await configCol()
    await SessionCredentialStore.saveSessionCredential(col, cookieValue, userId ? String(userId) : null)
    await Audit.record('session_cookie_updated', { userId, detail: 'Tier 1 cloud session cookie updated' })
    return res.status(200).json({ configured: true, valid: true })
  } catch (err) {
    return res.status(500).json({ error: 'credential_save_failed', message: err?.message })
  }
}

export async function deleteSessionCookie(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  try {
    const col = await configCol()
    await SessionCredentialStore.clearSessionCredential(col)
    await Audit.record('session_cookie_cleared', { userId, detail: 'Tier 1 cloud session cookie removed' })
    return res.status(200).json({ configured: false })
  } catch (err) {
    return res.status(500).json({ error: 'credential_clear_failed', message: err?.message })
  }
}

export async function controlRunner(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  const action = String(req.body?.action || '').trim()
  try {
    if (action === 'pause') {
      await Lock.pause('validator', userId ? String(userId) : null)
      await Audit.record('runner_paused', { userId })
      return res.status(200).json({ paused: true })
    }
    if (action === 'resume') {
      await Lock.resume('validator')
      await Audit.record('runner_resumed', { userId })
      return res.status(200).json({ paused: false })
    }
    return res.status(400).json({ error: 'invalid_action' })
  } catch (err) {
    return res.status(500).json({ error: 'runner_control_failed', message: err?.message })
  }
}

export async function acknowledgeUnsandboxed(req, res) {
  const cfg = Settings.templateGallery || {}
  if (cfg.validation?.allowUnsandboxedAck !== true) {
    return res.status(403).json({ error: 'unsandboxed_ack_disallowed' })
  }
  const confirmText = String(req.body?.confirmText || '').trim()
  if (confirmText.length < 10) {
    return res.status(400).json({ error: 'confirm_text_required' })
  }
  const userId = SessionManager.getLoggedInUserId(req.session)
  try {
    const col = await configCol()
    const ack = { by: userId ? String(userId) : null, at: new Date(), text: confirmText }
    await col.updateOne({ _id: 'runtime' }, { $set: { unsandboxedAck: ack } }, { upsert: true })
    await Audit.record('unsandboxed_ack', { userId, detail: confirmText })
    return res.status(200).json({ unsandboxedAck: ack })
  } catch (err) {
    logWarn('tg.admin.unsandboxed_ack_failed', { message: err?.message })
    return res.status(500).json({ error: 'unsandboxed_ack_failed' })
  }
}

const AdminController = {
  renderAdminPage,
  getStatus,
  listItems,
  getItem,
  patchItem,
  uploadByoZip,
  replaceItemPackage,
  uploadThumbnail,
  validateItem,
  hydrateItem,
  acknowledgeLicence,
  publishItem,
  unpublishItem,
  archiveItem,
  deleteItem,
  getValidationLog,
  getJob,
  triggerCrawlerSync,
  triggerCatalogue,
  triggerRecentScan,
  pauseCrawler,
  resumeCrawler,
  saveSessionCookie,
  deleteSessionCookie,
  controlRunner,
  acknowledgeUnsandboxed,
}

export default AdminController
