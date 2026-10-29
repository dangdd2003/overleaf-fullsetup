import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Settings from '@overleaf/settings'
import { DEFAULTS, mergePlain } from '../../../app/src/TemplateGalleryDefaults.mjs'
import { setCollectionOverrideForTests } from '../../../app/src/persistence/Collections.mjs'
import HostLimiter, {
  withHostSlot,
  isHostIdle,
  getHostStatus,
  parseRetryAfterMs,
  setHostRateForTests,
  resetHostLimiterForTests,
  BACKOFF_STEPS_MS,
  CIRCUIT_FAILURE_THRESHOLD,
  CIRCUIT_OPEN_MS,
} from '../../../app/src/transport/HostLimiter.mjs'
import TemplateCrawlerService, {
  normalizeDataUri,
  normalizeTags,
  transformHit,
  chooseSplit,
  buildPartitionTree,
  buildItemUpsert,
  createTagStats,
} from '../../../app/src/services/TemplateCrawlerService.mjs'
import BlobRefs, { blobRefsOf, BLOB_REF_FIELDS } from '../../../app/src/storage/BlobRefs.mjs'
import StorageHealth from '../../../app/src/storage/StorageHealth.mjs'
import Indexes from '../../../app/src/persistence/Indexes.mjs'
import Migrations from '../../../app/src/persistence/Migrations.mjs'
import Scheduler from '../../../app/src/jobs/Scheduler.mjs'
import Lifecycle from '../../../app/src/Lifecycle.mjs'
import AdminController from '../../../app/src/controllers/AdminController.mjs'
import CatalogueService from '../../../app/src/services/CatalogueService.mjs'

function makeMockCollection(initialDocs = []) {
  const docs = [...initialDocs]
  return {
    docs,
    findOne: vi.fn(async filter => {
      if (!filter || Object.keys(filter).length === 0) return docs[0] || null
      return (
        docs.find(d => {
          for (const [k, v] of Object.entries(filter)) {
            if (k === '_id' && d._id !== v) return false
            if (k === 'token' && d.token !== v) return false
            if (k === 'objectID' && d.objectID !== v) return false
          }
          return true
        }) || null
      )
    }),
    find: vi.fn((filter = {}, opts = {}) => {
      let filtered = [...docs]
      if (filter.state && filter.state.$ne) {
        filtered = filtered.filter(d => d.state !== filter.state.$ne)
      }
      return {
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        toArray: vi.fn(async () => filtered),
        [Symbol.asyncIterator]: async function* () {
          for (const doc of filtered) {
            yield doc
          }
        },
      }
    }),
    countDocuments: vi.fn(async () => docs.length),
    estimatedDocumentCount: vi.fn(async () => docs.length),
    updateOne: vi.fn(async (filter, update, opts = {}) => {
      const matchDoc = d => {
        if (filter._id && (d._id === filter._id || String(d._id) === String(filter._id))) return true
        if (filter.token && d.token === filter.token) return true
        if (filter.slug && d.slug === filter.slug) return true
        if (filter.$or) {
          return filter.$or.some(sub => {
            if (sub._id && (d._id === sub._id || String(d._id) === String(sub._id))) return true
            if (sub.token && d.token === sub.token) return true
            if (sub.slug && d.slug === sub.slug) return true
            return false
          })
        }
        return false
      }
      const idx = docs.findIndex(matchDoc)
      if (idx !== -1) {
        if (update.$set) docs[idx] = { ...docs[idx], ...update.$set }
        if (update.$max) {
          for (const [k, v] of Object.entries(update.$max)) {
            if (docs[idx][k] === undefined || v > docs[idx][k]) docs[idx][k] = v
          }
        }
        if (update.$unset) {
          for (const k of Object.keys(update.$unset)) delete docs[idx][k]
        }
        return { matchedCount: 1, modifiedCount: 1 }
      }
      if (opts.upsert) {
        const newDoc = {
          _id: filter._id || filter.token || 'mock_id',
          ...(update.$set || {}),
          ...(update.$setOnInsert || {}),
        }
        if (update.$max) {
          for (const [k, v] of Object.entries(update.$max)) {
            newDoc[k] = v
          }
        }
        docs.push(newDoc)
        return { matchedCount: 0, upsertedCount: 1 }
      }
      return { matchedCount: 0, modifiedCount: 0 }
    }),
    updateMany: vi.fn(async (filter, update) => {
      let count = 0
      for (let i = 0; i < docs.length; i++) {
        if (update.$set) docs[i] = { ...docs[i], ...update.$set }
        count++
      }
      return { matchedCount: count, modifiedCount: count }
    }),
    deleteOne: vi.fn(async filter => {
      const idx = docs.findIndex(d => filter._id && d._id === filter._id)
      if (idx !== -1) docs.splice(idx, 1)
      return { deletedCount: idx !== -1 ? 1 : 0 }
    }),
    bulkWrite: vi.fn(async ops => {
      let inserted = 0
      let matched = 0
      for (const op of ops) {
        if (op.updateOne) {
          const filter = op.updateOne.filter
          const update = op.updateOne.update
          const idx = docs.findIndex(d => filter.token && d.token === filter.token)
          if (idx !== -1) {
            matched++
            if (update.$set) docs[idx] = { ...docs[idx], ...update.$set }
          } else if (op.updateOne.upsert) {
            inserted++
            docs.push({
              _id: filter.token || 'bulk_' + inserted,
              ...(update.$set || {}),
              ...(update.$setOnInsert || {}),
            })
          }
        }
      }
      return { upsertedCount: inserted, matchedCount: matched, modifiedCount: matched }
    }),
    createIndex: vi.fn(async () => {}),
    dropIndex: vi.fn(async () => {}),
    aggregate: vi.fn(() => ({
      toArray: vi.fn(async () => []),
    })),
  }
}

describe('Work Package B1: Catalogue, Scheduler, HostLimiter, Persistence & Lifecycle', () => {
  beforeEach(() => {
    Settings.enableTemplateGallery = true
    Settings.templateGallery = mergePlain(DEFAULTS, {
      storageDir: path.join(os.tmpdir(), `tg-test-${Date.now()}`),
      storage: { requireDedicatedMount: false },
    })
    resetHostLimiterForTests()
  })

  afterEach(async () => {
    resetHostLimiterForTests()
    setCollectionOverrideForTests(null)
    Scheduler.setDependenciesForTests(null)
    await Scheduler.stop()
    vi.restoreAllMocks()
  })

  // =========================================================================
  // 1. HostLimiter tests
  // =========================================================================
  describe('HostLimiter transport politeness & circuit breaker', () => {
    it('executes requests through withHostSlot and updates host status', async () => {
      setHostRateForTests('s3', { intervalMs: 0, jitterMs: 0 })
      const res = await withHostSlot('s3', { priority: 'background' }, async () => 'ok-s3')
      expect(res).toBe('ok-s3')

      const status = getHostStatus()
      expect(status.s3).toBeDefined()
      expect(status.s3.circuit).toBe('closed')
      expect(status.s3.totals.ok).toBe(1)
      expect(isHostIdle('s3')).toBe(true)
    })

    it('parses Retry-After headers from numeric seconds and HTTP dates', () => {
      expect(parseRetryAfterMs('120')).toBe(120_000)
      expect(parseRetryAfterMs('0')).toBe(0)
      expect(parseRetryAfterMs(null)).toBeNull()
      expect(parseRetryAfterMs('')).toBeNull()

      const futureDate = new Date(Date.now() + 60_000).toUTCString()
      const parsedMs = parseRetryAfterMs(futureDate)
      expect(parsedMs).toBeGreaterThan(50_000)
      expect(parsedMs).toBeLessThanOrEqual(60_000)
    })

    it('prioritizes interactive queue ahead of background queue', async () => {
      setHostRateForTests('algolia', { intervalMs: 10, jitterMs: 0 })
      const order = []
      const p1 = withHostSlot('algolia', { priority: 'background' }, async () => {
        order.push('bg1')
      })
      const p2 = withHostSlot('algolia', { priority: 'background' }, async () => {
        order.push('bg2')
      })
      const p3 = withHostSlot('algolia', { priority: 'interactive' }, async () => {
        order.push('interactive')
      })

      await Promise.all([p1, p2, p3])
      // Because p1 starts immediately, p3 jumps ahead of p2
      expect(order).toEqual(['bg1', 'interactive', 'bg2'])
    })

    it('backs off on 429 and applies circuit breaker on repeated failures', async () => {
      setHostRateForTests('overleaf', { intervalMs: 0, jitterMs: 0 })

      // 1. Test 429 backoff recording
      const throttleErr = new Error('Too Many Requests')
      throttleErr.status = 429
      throttleErr.retryAfterMs = 50

      let caught = null
      try {
        await withHostSlot('overleaf', { priority: 'background' }, async () => {
          throw throttleErr
        })
      } catch (err) {
        caught = err
      }
      expect(caught).toBe(throttleErr)

      const statusAfterThrottle = getHostStatus()
      expect(statusAfterThrottle.overleaf.backoffLevel).toBe(1)
      expect(statusAfterThrottle.overleaf.consecutiveFailures).toBe(1)

      // 2. Test circuit breaker trigger with 5 consecutive failures
      resetHostLimiterForTests()
      setHostRateForTests('overleaf', { intervalMs: 0, jitterMs: 0 })
      const serverErr = new Error('500 Server Error')
      serverErr.status = 500

      for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
        let errCaught = null
        try {
          await withHostSlot('overleaf', { priority: 'background' }, async () => {
            throw serverErr
          })
        } catch (e) {
          errCaught = e
        }
        expect(errCaught).toBe(serverErr)
      }

      const status = getHostStatus()
      expect(status.overleaf.circuit).toBe('open')
      expect(status.overleaf.consecutiveFailures).toBe(CIRCUIT_FAILURE_THRESHOLD)

      // Subsequent request should fail immediately with circuit_open
      let circuitErr = null
      try {
        await withHostSlot('overleaf', { priority: 'background' }, async () => 'fail')
      } catch (e) {
        circuitErr = e
      }
      expect(circuitErr?.code).toBe('circuit_open')
    })

    it('resets consecutive failure counter on non-host errors such as 404', async () => {
      setHostRateForTests('s3', { intervalMs: 0, jitterMs: 0 })
      const hostErr = new Error('500 Internal')
      hostErr.status = 500

      // 3 consecutive failures
      for (let i = 0; i < 3; i++) {
        try {
          await withHostSlot('s3', { priority: 'background' }, async () => {
            throw hostErr
          })
        } catch (_e) {}
      }
      expect(getHostStatus().s3.consecutiveFailures).toBe(3)

      // 404 error is a resource error, not a host failure
      const notFoundErr = new Error('Not Found')
      notFoundErr.status = 404
      try {
        await withHostSlot('s3', { priority: 'background' }, async () => {
          throw notFoundErr
        })
      } catch (_e) {}

      expect(getHostStatus().s3.consecutiveFailures).toBe(0)
    })
  })

  // =========================================================================
  // 2. TemplateCrawlerService tests
  // =========================================================================
  describe('TemplateCrawlerService facet partition & upsert builder', () => {
    it('normalizes data URIs and tag arrays properly', () => {
      const valid = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='
      expect(normalizeDataUri(valid)).toBe(valid)
      expect(normalizeDataUri('invalid')).toBeNull()
      expect(normalizeDataUri(null)).toBeNull()

      const tags = [
        { name: 'cv', title: 'Curriculum Vitae' },
        { name: 'cv', title: 'Duplicate' },
        { name: '  ', title: 'Empty' },
        { name: 'thesis', title: '' },
      ]
      expect(normalizeTags(tags)).toEqual([
        { name: 'cv', title: 'Curriculum Vitae' },
        { name: 'thesis', title: 'thesis' },
      ])
    })

    it('transforms Algolia hit to internal item schema', () => {
      const hit = {
        objectID: '12345',
        title: 'Modern CV',
        author: 'Overleaf Team',
        description: 'Clean resume template',
        url: 'https://www.overleaf.com/latex/templates/modern-cv/abcdefghijkl',
        type: 'template',
        official: 'true',
        featured: true,
        imageUrl: 'data:image/jpeg;base64,/9j/4AAQ\nSkZJRg==\n',
        tags: [{ name: 'cv', title: 'CV' }],
      }

      const item = transformHit(hit)
      expect(item).not.toBeNull()
      expect(item.token).toBe('abcdefghijkl')
      expect(item.objectID).toBe('12345')
      expect(item.objectIDNum).toBe(12345)
      expect(item.family).toBe('template')
      expect(item.slug).toBe('modern-cv')
      expect(item.official).toBe(true)
      expect(item.featured).toBe(true)
      expect(item.thumbDataUri).toBe('data:image/jpeg;base64,/9j/4AAQSkZJRg==')
    })

    it('rejects hits missing token or valid url', () => {
      expect(transformHit(null)).toBeNull()
      expect(transformHit({ objectID: '123', url: '/invalid/url' })).toBeNull()
      expect(transformHit({ url: 'https://www.overleaf.com/latex/templates/cv/abcdefghijkl' })).toBeNull()
    })

    it('chooses the most balanced facet split for partitioning', () => {
      const facets = {
        'tags.title': {
          'Curriculum Vitae': 600,
          Presentation: 200,
        },
        official: {
          true: 700,
          false: 600,
        },
      }
      const split = chooseSplit(facets, 1500)
      expect(split).not.toBeNull()
      // official:true has (700, 800) max 800, which is smaller/better than tags.title (600, 900) max 900
      expect(split.positive).toBe('official:true')
      expect(split.negative).toBe('NOT official:true')
    })

    it('builds a partition tree splitting nodes when nbHits > MAX_LEAF_HITS', async () => {
      const mockQuery = vi.fn(async params => {
        if (!params.filters) {
          // Root query: 1200 hits
          return {
            nbHits: 1200,
            exhaustiveNbHits: true,
            facets: {
              official: { true: 700, false: 500 },
            },
          }
        }
        // Sub-branches: NOT clause gets 500, positive clause gets 700
        const isNegative = params.filters.includes('NOT ')
        const nbHits = isNegative ? 500 : 700
        return { nbHits, exhaustiveNbHits: true, facets: {} }
      })

      const tree = await buildPartitionTree(mockQuery)
      expect(tree.rootNbHits).toBe(1200)
      expect(tree.leaves).toHaveLength(2)
      expect(tree.leaves.reduce((sum, l) => sum + l.nbHits, 0)).toBe(1200)
    })

    it('buildItemUpsert constructs correct $setOnInsert and preserves adminOverrides', () => {
      const now = new Date()
      const doc = {
        token: 'abcdefghijkl',
        objectID: '12345',
        objectIDNum: 12345,
        title: 'Crawler Title',
        author: 'Crawler Author',
        description: 'Crawler Description',
        family: 'template',
        slug: 'test-slug',
        tags: [{ name: 'cv', title: 'CV' }],
      }

      // New item insertion
      const newOp = buildItemUpsert(doc, null, now)
      expect(newOp.updateOne.filter).toEqual({ token: 'abcdefghijkl' })
      expect(newOp.updateOne.upsert).toBe(true)
      expect(newOp.updateOne.update.$setOnInsert.state).toBe('published')
      expect(newOp.updateOne.update.$setOnInsert.source).toBe('crawler')
      expect(newOp.updateOne.update.$set.title).toBe('Crawler Title')

      // Existing item with admin overrides
      const existing = {
        _id: 'existing_id',
        token: 'abcdefghijkl',
        adminOverrides: { title: true }, // admin customized the title
      }
      const updateOp = buildItemUpsert(doc, existing, now)
      expect(updateOp.updateOne.filter).toEqual({ _id: 'existing_id' })
      expect(updateOp.updateOne.update.$set.title).toBeUndefined() // preserved!
      expect(updateOp.updateOne.update.$set.author).toBe('Crawler Author')
      expect(updateOp.updateOne.update.$unset.type).toBe('')
    })

    it('createTagStats accumulates per-family counts and sorts title variants', () => {
      const stats = createTagStats()
      stats.add({
        family: 'template',
        tags: [
          { name: 'cv', title: 'Curriculum Vitae' },
          { name: 'academic', title: 'Academic' },
        ],
      })
      stats.add({
        family: 'template',
        tags: [{ name: 'cv', title: 'Resume' }],
      })
      stats.add({
        family: 'example',
        tags: [{ name: 'cv', title: 'Resume' }],
      })

      const entries = stats.entries()
      const cvEntry = entries.find(e => e.name === 'cv')
      expect(cvEntry).toBeDefined()
      expect(cvEntry.counts.template).toBe(2)
      expect(cvEntry.counts.example).toBe(1)
      expect(cvEntry.titles[0]).toBe('Resume') // 2 uses vs 1
    })
  })

  // =========================================================================
  // 3. Indexes & BlobRefs tests
  // =========================================================================
  describe('Indexes & BlobRefs', () => {
    it('blobRefsOf extracts sha256 references and ignores invalid strings', () => {
      const validSha1 = 'a'.repeat(64)
      const validSha2 = 'b'.repeat(64)
      const validSha3 = 'c'.repeat(64)

      const doc = {
        media: {
          thumbSha: validSha1,
          pdfSha: validSha2,
        },
        sourceBlobStoreKey: validSha3,
        thumbnail: {
          sha256: 'short-not-sha',
        },
        pdfBlobStoreKey: null,
      }

      const refs = blobRefsOf(doc)
      expect(refs).toHaveLength(3)
      expect(refs.map(r => r.sha)).toEqual([validSha1, validSha2, validSha3])
      expect(refs.find(r => r.path === 'media.thumbSha').kind).toBe('media')
      expect(refs.find(r => r.path === 'sourceBlobStoreKey').kind).toBe('source')
    })

    it('Indexes.ensureAll creates essential indexes and runs legacy migration', async () => {
      const itemsMock = makeMockCollection()
      const jobsMock = makeMockCollection()
      const auditMock = makeMockCollection()
      const crawlerMock = makeMockCollection()

      setCollectionOverrideForTests({
        templateGalleryItems: itemsMock,
        templateGalleryJobs: jobsMock,
        templateGalleryAudit: auditMock,
        templateGalleryCrawlerState: crawlerMock,
      })

      const report = await Indexes.ensureAll()
      expect(report.essentialOk).toBe(true)
      expect(itemsMock.createIndex).toHaveBeenCalled()
      expect(jobsMock.createIndex).toHaveBeenCalled()
      expect(auditMock.createIndex).toHaveBeenCalled()
    })
  })

  // =========================================================================
  // 4. Scheduler & Lifecycle tests
  // =========================================================================
  describe('Scheduler & Lifecycle execution', () => {
    it('installNavigation updates templateLinks to point to /latex/templates idempotently', () => {
      Settings.templateLinks = [
        { name: 'existing', url: '/other' },
        { name: 'view_all', url: '/templates', trackingKey: 'old' },
      ]

      Lifecycle.installNavigation()

      expect(Settings.templateLinks).toHaveLength(2)
      const viewAll = Settings.templateLinks.find(l => l.name === 'view_all')
      expect(viewAll.url).toBe('/latex/templates')

      // Second run is idempotent
      Lifecycle.installNavigation()
      expect(Settings.templateLinks).toHaveLength(2)
    })

    it('Lifecycle start/stop changes readiness state cleanly', async () => {
      const itemsMock = makeMockCollection()
      const jobsMock = makeMockCollection()
      const auditMock = makeMockCollection()
      const crawlerMock = makeMockCollection()
      const locksMock = makeMockCollection()

      setCollectionOverrideForTests({
        templateGalleryItems: itemsMock,
        templateGalleryJobs: jobsMock,
        templateGalleryAudit: auditMock,
        templateGalleryCrawlerState: crawlerMock,
        templateGalleryLocks: locksMock,
      })

      const testCfg = mergePlain(DEFAULTS, {
        storageDir: path.join(os.tmpdir(), `tg-lifecycle-test-${Date.now()}`),
        storage: { requireDedicatedMount: false },
      })

      const state = await Lifecycle.start(testCfg)
      expect(state.ready).toBe(true)
      expect(Lifecycle.isReady()).toBe(true)

      await Lifecycle.stop()
      expect(Lifecycle.isReady()).toBe(false)
    })

    it('Scheduler queues run requests and handles step execution', async () => {
      const stateMock = makeMockCollection()
      const itemsMock = makeMockCollection()
      const listingsMock = makeMockCollection()

      setCollectionOverrideForTests({
        templateGalleryCrawlerState: stateMock,
        templateGalleryItems: itemsMock,
        templateGalleryListings: listingsMock,
      })

      const reqRes = await Scheduler.requestRun('catalogue', 'admin-user')
      expect(reqRes.queued).toBe(true)

      const mockCrawler = {
        isPaused: vi.fn(async () => false),
        getCatalogueState: vi.fn(async () => ({ lastSuccessAt: new Date() })),
        runCatalogue: vi.fn(async () => ({ total: 10, inserted: 10 })),
      }
      const mockMirror = {
        scanFeatured: vi.fn(async () => ({ templates: 1, gallery: 1 })),
        scanGalleryRecent: vi.fn(async () => ({ pages: 1, items: 9, done: true })),
        runDetailBatch: vi.fn(async () => ({ processed: 5 })),
      }

      Scheduler.setDependenciesForTests({
        crawler: mockCrawler,
        mirror: mockMirror,
        jobs: {},
        isHostIdle: () => true,
      })

      const stepRes = await Scheduler.runStep({
        cfg: { crawler: { enabled: true } },
      })
      expect(stepRes.step).toBe('catalogue')
      expect(mockCrawler.runCatalogue).toHaveBeenCalled()
    })

    it('Scheduler runStep throws on recent-full scan error so driveLoop can back off', async () => {
      const now = Date.now()
      const stateMock = makeMockCollection([
        {
          _id: 'scheduler',
          catalogueAttemptAt: new Date(now),
          recentHeadAt: new Date(now),
          requests: { 'recent-full': { at: new Date(now) } },
        },
      ])
      const itemsMock = makeMockCollection([{ _id: 'item1', token: 'token1' }])
      const listingsMock = makeMockCollection([
        {
          _id: 'scan:gallery-recent',
          nextPage: 10,
          startedAt: new Date(now - 1000),
          finishedAt: null,
        },
      ])

      setCollectionOverrideForTests({
        templateGalleryCrawlerState: stateMock,
        templateGalleryItems: itemsMock,
        templateGalleryListings: listingsMock,
      })

      const mockCrawler = {
        isPaused: vi.fn(async () => false),
        getCatalogueState: vi.fn(async () => ({ lastSuccessAt: new Date(now) })),
      }
      const mockMirror = {
        scanGalleryRecent: vi.fn(async () => ({
          pages: 0,
          items: 0,
          done: false,
          error: 'circuit_open',
        })),
      }

      Scheduler.setDependenciesForTests({
        crawler: mockCrawler,
        mirror: mockMirror,
        jobs: {},
        isHostIdle: () => true,
      })

      let caught = null
      try {
        await Scheduler.runStep({
          cfg: { crawler: { enabled: true } },
        })
      } catch (err) {
        caught = err
      }
      expect(caught).toBeTruthy()
      expect(caught.message).toContain('recent full scan failed at page 10: circuit_open')
    })

    it('Scheduler runStep sets nextPage to 1 on recent-full scan completion without out-of-range $max overwrite', async () => {
      const now = Date.now()
      const stateMock = makeMockCollection([
        {
          _id: 'scheduler',
          catalogueAttemptAt: new Date(now),
          recentHeadAt: new Date(now),
          requests: { 'recent-full': { at: new Date(now) } },
        },
      ])
      const itemsMock = makeMockCollection([{ _id: 'item1', token: 'token1' }])
      const listingsMock = makeMockCollection([
        {
          _id: 'scan:gallery-recent',
          nextPage: 1160,
          startedAt: new Date(now - 1000),
          finishedAt: null,
        },
      ])

      setCollectionOverrideForTests({
        templateGalleryCrawlerState: stateMock,
        templateGalleryItems: itemsMock,
        templateGalleryListings: listingsMock,
      })

      const mockCrawler = {
        isPaused: vi.fn(async () => false),
        getCatalogueState: vi.fn(async () => ({ lastSuccessAt: new Date(now) })),
      }
      const mockMirror = {
        scanGalleryRecent: vi.fn(async () => ({
          pages: 8,
          items: 72,
          done: true,
        })),
      }

      Scheduler.setDependenciesForTests({
        crawler: mockCrawler,
        mirror: mockMirror,
        jobs: {},
        isHostIdle: () => true,
      })

      const res = await Scheduler.runStep({
        cfg: { crawler: { enabled: true } },
      })
      expect(res.step).toBe('recent-full')
      expect(res.result.done).toBe(true)

      const checkpoint = await listingsMock.findOne({ _id: 'scan:gallery-recent' })
      expect(checkpoint.nextPage).toBe(1)
      expect(checkpoint.finishedAt).toBeTruthy()
    })

    it('AdminController.getStatus returns mirror progress and counts', async () => {
      const validSha = 'd'.repeat(64)
      const itemsMock = makeMockCollection([
        {
          _id: 'item-1',
          token: 'abcdefghijkl',
          state: 'published',
          mirror: { detailAt: new Date() },
          media: { thumbSha: validSha },
        },
        {
          _id: 'item-2',
          token: 'mnopqrstuvwx',
          state: 'published',
          media: { pdfSha: validSha },
        },
      ])
      const tagsMock = makeMockCollection([
        { _id: 'cv', byScope: { templates: {} } },
        { _id: 'thesis', catalogAt: new Date() },
      ])
      const stateMock = makeMockCollection()
      const jobsMock = makeMockCollection()
      const listingsMock = makeMockCollection()
      const configMock = makeMockCollection()
      const locksMock = makeMockCollection()

      setCollectionOverrideForTests({
        templateGalleryItems: itemsMock,
        templateGalleryTags: tagsMock,
        templateGalleryCrawlerState: stateMock,
        templateGalleryJobs: jobsMock,
        templateGalleryListings: listingsMock,
        templateGalleryConfig: configMock,
        templateGalleryLocks: locksMock,
      })

      const req = {}
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(data => data),
      }

      await AdminController.getStatus(req, res)
      expect(res.status).toHaveBeenCalledWith(200)
      const data = res.json.mock.results[0].value
      expect(data.mirror).toBeDefined()
      expect(data.mirror.counts.total).toBe(2)
      expect(data.mirror.counts.withDetail).toBe(1)
      expect(data.mirror.counts.withPdf).toBe(1)
      expect(data.mirror.counts.withThumb).toBe(1)
      expect(data.mirror.counts.tagsScraped).toBe(2)
      expect(data.mirror.hostLimiter).toBeDefined()
      // Finding 3: Heavy fields abstractHtml and thumbDataUri must not be in getStatus projection
      const findProjection = itemsMock.find.mock.calls[0]?.[1]?.projection || {}
      expect(findProjection.abstractHtml).toBeUndefined()
      expect(findProjection.thumbDataUri).toBeUndefined()
    })

    it('AdminController trigger endpoints queue actions and pause/resume works', async () => {
      const stateMock = makeMockCollection()
      const locksMock = makeMockCollection()
      setCollectionOverrideForTests({
        templateGalleryCrawlerState: stateMock,
        templateGalleryLocks: locksMock,
      })

      const req = {
        session: { user: { _id: 'admin123' } },
        body: { action: 'recent' },
      }
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(data => data),
      }

      await AdminController.triggerCrawlerSync(req, res)
      expect(res.status).toHaveBeenCalledWith(202)
      expect(res.json.mock.results[0].value.queued).toBe(true)

      // Test pause and resume
      const pauseRes = { status: vi.fn().mockReturnThis(), json: vi.fn(data => data) }
      await AdminController.pauseCrawler(req, pauseRes)
      expect(pauseRes.status).toHaveBeenCalledWith(200)
      expect(pauseRes.json.mock.results[0].value.paused).toBe(true)

      const resumeRes = { status: vi.fn().mockReturnThis(), json: vi.fn(data => data) }
      await AdminController.resumeCrawler(req, resumeRes)
      expect(resumeRes.status).toHaveBeenCalledWith(200)
      expect(resumeRes.json.mock.results[0].value.paused).toBe(false)
    })

    it('AdminController endpoints return HTTP 404 for non-existent items', async () => {
      const itemsMock = makeMockCollection([])
      const configMock = makeMockCollection()
      setCollectionOverrideForTests({
        templateGalleryItems: itemsMock,
        templateGalleryConfig: configMock,
      })

      const makeRes = () => ({
        status: vi.fn().mockReturnThis(),
        json: vi.fn(data => data),
      })

      // patchItem
      const res1 = makeRes()
      await AdminController.patchItem({ params: { id: 'missing' }, body: {} }, res1)
      expect(res1.status).toHaveBeenCalledWith(404)

      // acknowledgeLicence
      const res2 = makeRes()
      await AdminController.acknowledgeLicence(
        {
          params: { id: 'missing' },
          body: { note: 'A valid acknowledgement note that is long enough' },
          session: { user: { _id: 'admin1' } },
        },
        res2
      )
      expect(res2.status).toHaveBeenCalledWith(404)

      // publishItem
      const res3 = makeRes()
      await AdminController.publishItem(
        { params: { id: 'missing' }, session: { user: { _id: 'admin1' } } },
        res3
      )
      expect(res3.status).toHaveBeenCalledWith(404)

      // unpublishItem
      const res4 = makeRes()
      await AdminController.unpublishItem(
        { params: { id: 'missing' }, session: { user: { _id: 'admin1' } } },
        res4
      )
      expect(res4.status).toHaveBeenCalledWith(404)

      // archiveItem
      const res5 = makeRes()
      await AdminController.archiveItem(
        { params: { id: 'missing' }, session: { user: { _id: 'admin1' } } },
        res5
      )
      expect(res5.status).toHaveBeenCalledWith(404)

      // deleteItem
      const res6 = makeRes()
      await AdminController.deleteItem(
        { params: { id: 'missing' }, body: { confirmSlug: 'missing' }, session: { user: { _id: 'admin1' } } },
        res6
      )
      expect(res6.status).toHaveBeenCalledWith(404)
    })

    it('CatalogueService has removed unused exports listPublished and listTags', () => {
      expect(CatalogueService.listPublished).toBeUndefined()
      expect(CatalogueService.listTags).toBeUndefined()
      expect(typeof CatalogueService.listAdmin).toBe('function')
    })

    it('AdminController.uploadThumbnail updates media.thumbSha and returns 404 for unknown items', async () => {
      const hexId = '654321654321654321654321'
      const itemsMock = makeMockCollection([
        {
          _id: hexId,
          slug: 'my-template',
          state: 'published',
        },
      ])
      setCollectionOverrideForTests({
        templateGalleryItems: itemsMock,
      })

      // 1. Missing file returns 400
      const missingRes = {
        statusCode: 200,
        status: vi.fn(function (code) { this.statusCode = code; return this }),
        json: vi.fn(data => data),
      }
      await new Promise(resolve => {
        missingRes.json.mockImplementation(data => { resolve(data); return data })
        AdminController.uploadThumbnail({ headers: {}, params: { id: hexId } }, missingRes)
      })
      expect(missingRes.status).toHaveBeenCalledWith(400)
      expect(missingRes.json).toHaveBeenCalledWith({ error: 'missing_thumbnail' })

      // 2. Upload valid PNG to existing item
      const validPng = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      ])
      const boundary = '----WebKitFormBoundaryUploadTest'
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="thumbnail"; filename="thumb.png"\r\nContent-Type: image/png\r\n\r\n`),
        validPng,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ])
      const req = Readable.from(body)
      req.headers = {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(body.length),
      }
      req.params = { id: hexId }
      const successRes = {
        statusCode: 200,
        status: vi.fn(function (code) { this.statusCode = code; return this }),
        json: vi.fn(data => data),
      }
      await new Promise(resolve => {
        successRes.json.mockImplementation(data => { resolve(data); return data })
        AdminController.uploadThumbnail(req, successRes)
      })
      expect(successRes.status).toHaveBeenCalledWith(200)
      const resData = successRes.json.mock.results[0]?.value
      expect(resData?.thumbnail?.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(resData?.thumbnail?.mime).toBe('image/png')

      // Verify item document was updated with media.thumbSha and mirror.thumbAt
      const updatedItem = itemsMock.docs[0]
      expect(updatedItem['media.thumbSha']).toBe(resData.thumbnail.sha256)
      expect(updatedItem['media.thumbMime']).toBe('image/png')
      expect(updatedItem['mirror.thumbAt']).toBeInstanceOf(Date)

      // 3. Upload valid PNG to non-existent item returns 404
      const req404 = Readable.from(body)
      req404.headers = {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(body.length),
      }
      req404.params = { id: '111111111111111111111111' }
      const notFoundRes = {
        statusCode: 200,
        status: vi.fn(function (code) { this.statusCode = code; return this }),
        json: vi.fn(data => data),
      }
      await new Promise(resolve => {
        notFoundRes.json.mockImplementation(data => { resolve(data); return data })
        AdminController.uploadThumbnail(req404, notFoundRes)
      })
      expect(notFoundRes.status).toHaveBeenCalledWith(404)
      expect(notFoundRes.json).toHaveBeenCalledWith({ error: 'item_not_found' })
    })
  })
})
