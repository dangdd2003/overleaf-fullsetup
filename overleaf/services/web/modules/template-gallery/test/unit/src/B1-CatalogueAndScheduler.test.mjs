import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Settings from '@overleaf/settings'
import { DEFAULTS } from '../../../app/src/TemplateGalleryDefaults.mjs'
import { mergePlain } from './support/mergePlain.mjs'
import { setCollectionOverrideForTests } from '../../../app/src/persistence/Collections.mjs'
import HostLimiter, {
  withHostSlot,
  isHostIdle,
  getHostStatus,
  parseRetryAfterMs,
  setHostLimitsForTests,
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
import BlobRefs, {
  blobRefsOf,
  BLOB_REF_FIELDS,
} from '../../../app/src/storage/BlobRefs.mjs'
import StorageHealth from '../../../app/src/storage/StorageHealth.mjs'
import Indexes from '../../../app/src/persistence/Indexes.mjs'
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
      const matches = (d, f) => {
        for (const [k, v] of Object.entries(f)) {
          if (k === '$or' && !v.some(sub => matches(d, sub))) return false
          if (k === '_id' && String(d._id) !== String(v)) return false
          if (k === 'token' && d.token !== v) return false
          if (k === 'slug' && d.slug !== v) return false
          if (k === 'objectID' && d.objectID !== v) return false
        }
        return true
      }
      return docs.find(d => matches(d, filter)) || null
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
        if (
          filter._id &&
          (d._id === filter._id || String(d._id) === String(filter._id))
        )
          return true
        if (filter.token && d.token === filter.token) return true
        if (filter.slug && d.slug === filter.slug) return true
        if (filter.$or) {
          return filter.$or.some(sub => {
            if (
              sub._id &&
              (d._id === sub._id || String(d._id) === String(sub._id))
            )
              return true
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
          const idx = docs.findIndex(
            d => filter.token && d.token === filter.token
          )
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
      return {
        upsertedCount: inserted,
        matchedCount: matched,
        modifiedCount: matched,
      }
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
      setHostLimitsForTests('s3', {
      maxInFlight: 1,
      reservedInteractive: 0,
      minIntervalMs: 0,
    })
      const res = await withHostSlot(
        's3',
        { priority: 'background' },
        async () => 'ok-s3'
      )
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
      setHostLimitsForTests('algolia', {
      maxInFlight: 1,
      reservedInteractive: 0,
      minIntervalMs: 0,
    })
      const order = []
      const p1 = withHostSlot(
        'algolia',
        { priority: 'background' },
        async () => {
          order.push('bg1')
        }
      )
      const p2 = withHostSlot(
        'algolia',
        { priority: 'background' },
        async () => {
          order.push('bg2')
        }
      )
      const p3 = withHostSlot(
        'algolia',
        { priority: 'interactive' },
        async () => {
          order.push('interactive')
        }
      )

      await Promise.all([p1, p2, p3])
      // Because p1 starts immediately, p3 jumps ahead of p2
      expect(order).toEqual(['bg1', 'interactive', 'bg2'])
    })

    it('backs off on 429 and applies circuit breaker on repeated failures', async () => {
      setHostLimitsForTests('overleaf', {
      maxInFlight: 1,
      reservedInteractive: 0,
      minIntervalMs: 0,
    })

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
      setHostLimitsForTests('overleaf', {
      maxInFlight: 1,
      reservedInteractive: 0,
      minIntervalMs: 0,
    })
      const serverErr = new Error('500 Server Error')
      serverErr.status = 500

      for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
        let errCaught = null
        try {
          await withHostSlot(
            'overleaf',
            { priority: 'background' },
            async () => {
              throw serverErr
            }
          )
        } catch (e) {
          errCaught = e
        }
        expect(errCaught).toBe(serverErr)
      }

      const status = getHostStatus()
      expect(status.overleaf.circuit).toBe('open')
      expect(status.overleaf.consecutiveFailures).toBe(
        CIRCUIT_FAILURE_THRESHOLD
      )

      // Subsequent request should fail immediately with circuit_open
      let circuitErr = null
      try {
        await withHostSlot(
          'overleaf',
          { priority: 'background' },
          async () => 'fail'
        )
      } catch (e) {
        circuitErr = e
      }
      expect(circuitErr?.code).toBe('circuit_open')
    })

    it('resets consecutive failure counter on non-host errors such as 404', async () => {
      setHostLimitsForTests('s3', {
      maxInFlight: 1,
      reservedInteractive: 0,
      minIntervalMs: 0,
    })
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
      expect(
        transformHit({
          url: 'https://www.overleaf.com/latex/templates/cv/abcdefghijkl',
        })
      ).toBeNull()
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

    it('buildItemUpsert constructs the mirror upsert (insert by token, update by _id)', () => {
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
      expect(newOp.updateOne.update.$setOnInsert.source).toBeUndefined()
      expect(newOp.updateOne.update.$set.title).toBe('Crawler Title')

      // Existing item: the upstream mirror always refreshes its own fields
      const existing = {
        _id: 'existing_id',
        token: 'abcdefghijkl',
      }
      const updateOp = buildItemUpsert(doc, existing, now)
      expect(updateOp.updateOne.filter).toEqual({ _id: 'existing_id' })
      expect(updateOp.updateOne.update.$set.title).toBe('Crawler Title')
      expect(updateOp.updateOne.update.$set.author).toBe('Crawler Author')
      expect(updateOp.updateOne.update.$unset).toBeUndefined()
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
      expect(refs.find(r => r.path === 'sourceBlobStoreKey').kind).toBe(
        'source'
      )
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
      const configMock = makeMockCollection()
      const tagsMock = makeMockCollection()
      const listingsMock = makeMockCollection()

      setCollectionOverrideForTests({
        templateGalleryItems: itemsMock,
        templateGalleryJobs: jobsMock,
        templateGalleryAudit: auditMock,
        templateGalleryCrawlerState: crawlerMock,
        templateGalleryLocks: locksMock,
        templateGalleryConfig: configMock,
        templateGalleryTags: tagsMock,
        templateGalleryListings: listingsMock,
      })

      const testCfg = mergePlain(DEFAULTS, {
        storageDir: path.join(os.tmpdir(), `tg-lifecycle-test-${Date.now()}`),
        })

      const state = await Lifecycle.start(testCfg)
      expect(state.ready).toBe(true)
      expect(Lifecycle.isReady()).toBe(true)

      await Lifecycle.stop()
      expect(Lifecycle.isReady()).toBe(false)
    })

    it('CatalogueService has removed unused exports listPublished and listTags', () => {
      expect(CatalogueService.listPublished).toBeUndefined()
      expect(CatalogueService.listTags).toBeUndefined()
      expect(typeof CatalogueService.listAdmin).toBe('function')
    })

  })
})
