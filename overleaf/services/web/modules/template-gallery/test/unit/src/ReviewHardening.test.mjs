import os from 'node:os'
import fsp from 'node:fs/promises'
import Path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import { DEFAULTS } from '../../../app/src/TemplateGalleryDefaults.mjs'
import { mergePlain } from './support/mergePlain.mjs'
import { setCollectionOverrideForTests } from '../../../app/src/persistence/Collections.mjs'
import { createFakeCollection } from './S-P4-support.mjs'

function mockRes() {
  const res = {
    statusCode: 200,
    jsonBody: null,
    status(code) {
      res.statusCode = code
      return res
    },
    json(body) {
      res.jsonBody = body
      return res
    },
  }
  return res
}

describe('Review hardening fixes (H-8, L-2, M-7, M-9)', () => {
  const SETTINGS_KEYS = ['security', 'sessionSecret', 'enableTemplateGallery']
  let prevSettings

  beforeEach(() => {
    prevSettings = Object.fromEntries(
      SETTINGS_KEYS.map(key => [key, Settings[key]])
    )
    delete Settings.security
    delete Settings.sessionSecret
    Settings.enableTemplateGallery = false
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    setCollectionOverrideForTests(null)
    for (const key of SETTINGS_KEYS) {
      if (prevSettings[key] !== undefined) Settings[key] = prevSettings[key]
      else delete Settings[key]
    }
  })

  it('[L-2] importing SessionCredentialStore does not warn until Lifecycle.start() runs', async () => {
    vi.resetModules()
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    await import('../../../app/src/crypto/SessionCredentialStore.mjs')
    expect(warnSpy).not.toHaveBeenCalled()

    const tmpDir = await fsp.mkdtemp(Path.join(os.tmpdir(), 'tg-h8-life-'))
    try {
      const emptyCol = createFakeCollection()
      setCollectionOverrideForTests({
        templateGalleryItems: createFakeCollection(),
        templateGalleryJobs: createFakeCollection(),
        templateGalleryConfig: emptyCol,
        templateGalleryLocks: createFakeCollection(),
        templateGalleryListings: createFakeCollection(),
        templateGalleryTags: createFakeCollection(),
        templateGalleryCrawlerState: createFakeCollection(),
        templateGalleryAudit: createFakeCollection(),
      })
      const Lifecycle = (await import('../../../app/src/Lifecycle.mjs')).default
      await Lifecycle.start(mergePlain(DEFAULTS, { storageDir: tmpDir }))
      await Lifecycle.stop()

      expect(
        warnSpy.mock.calls.some(([, msg]) =>
          String(msg).includes('template_gallery_fallback_secret_in_use')
        )
      ).toBe(true)
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('[H-8] saveSessionCredential rejects unset secret and AdminController maps it to HTTP 400', async () => {
    const col = createFakeCollection()
    setCollectionOverrideForTests({ templateGalleryConfig: col })

    const { saveSessionCredential } = await import(
      '../../../app/src/crypto/SessionCredentialStore.mjs'
    )
    const AdminController = (
      await import('../../../app/src/controllers/AdminController.mjs')
    ).default

    let storeErr
    try {
      await saveSessionCredential(col, 'overleaf_session2=test-cookie')
    } catch (err) {
      storeErr = err
    }
    expect(storeErr).toBeDefined()
    expect(storeErr.code).toBe('secret_not_configured')

    const res400 = mockRes()
    await AdminController.saveSessionCookie(
      { body: { cookie: 'overleaf_session2=test-cookie' } },
      res400
    )
    expect(res400.statusCode).toBe(400)
    expect(res400.jsonBody).toEqual({
      ok: false,
      error: 'secret_not_configured',
      message: 'Cannot save session credential: sessionSecret is not configured',
    })

    Settings.security = { sessionSecret: 'configured-test-secret' }
    const res200 = mockRes()
    await AdminController.saveSessionCookie(
      { body: { cookie: 'overleaf_session2=test-cookie' } },
      res200
    )
    expect(res200.statusCode).toBe(200)
    expect(res200.jsonBody.configured).toBe(true)
  })

  it('[L-2] OpenController and TemplateGalleryRouter do not construct RateLimiter at module import time', async () => {
    vi.resetModules()
    const rateLimiterCtor = vi.fn()
    const consumeMock = vi.fn(async () => ({}))
    vi.doMock('../../../../../app/src/infrastructure/RateLimiter.mjs', () => ({
      RateLimiter: class MockRateLimiter {
        constructor(...args) {
          rateLimiterCtor(...args)
        }
        consume(...args) {
          return consumeMock(...args)
        }
      },
    }))
    vi.doMock(
      '../../../../../app/src/Features/Security/RateLimiterMiddleware.mjs',
      () => ({
        default: { rateLimit: () => (req, res, next) => next() },
      })
    )
    vi.doMock(
      '../../../../../app/src/Features/Authentication/AuthenticationController.mjs',
      () => ({
        default: { requireLogin: () => (req, res, next) => next() },
      })
    )

    // A failed assertion must not leave the mocks registered for later tests
    try {
      const { openRateLimiter } = await import(
        '../../../app/src/controllers/OpenController.mjs'
      )
      const TemplateGalleryRouter = await import(
        '../../../app/src/TemplateGalleryRouter.mjs'
      )

      const templateGalleryCallsAtImport = rateLimiterCtor.mock.calls.filter(
        ([name]) => String(name).startsWith('template-gallery-')
      )
      expect(templateGalleryCallsAtImport).toEqual([])

      await openRateLimiter.consume('user-1', 1, { method: 'userId' })
      expect(
        rateLimiterCtor.mock.calls.filter(
          ([name]) => name === 'template-gallery-open'
        )
      ).toHaveLength(1)
      expect(consumeMock).toHaveBeenCalledWith('user-1', 1, {
        method: 'userId',
      })

      const fakeRouter = {
        use: vi.fn(),
        get: vi.fn(),
        post: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
        put: vi.fn(),
      }
      TemplateGalleryRouter.apply(fakeRouter)
      expect(
        rateLimiterCtor.mock.calls.map(([name]) => name)
      ).toEqual(
        expect.arrayContaining([
          'template-gallery-admin-write',
          'template-gallery-admin-heavy',
        ])
      )
    } finally {
      vi.doUnmock('../../../../../app/src/infrastructure/RateLimiter.mjs')
      vi.doUnmock(
        '../../../../../app/src/Features/Security/RateLimiterMiddleware.mjs'
      )
      vi.doUnmock(
        '../../../../../app/src/Features/Authentication/AuthenticationController.mjs'
      )
    }
  }, 15000)

  it('[M-7] Scheduler.runDetailsPhase adds token to taken inside nextToken before refill', async () => {
    const Scheduler = (await import('../../../app/src/jobs/Scheduler.mjs')).default
    const SyncRun = (await import('../../../app/src/jobs/SyncRun.mjs')).default

    const listings = createFakeCollection()
    setCollectionOverrideForTests({
      templateGalleryCrawlerState: createFakeCollection(),
      templateGalleryListings: listings,
      templateGalleryItems: createFakeCollection(),
      templateGalleryConfig: createFakeCollection(),
    })

    const pending = ['t1']
    const synced = []
    const excludeSnapshots = []
    const mirror = {
      scanFeatured: vi.fn(async () => ({ templates: 0, gallery: 0 })),
      scanGalleryRecent: vi.fn(async () => ({ pages: 1, items: 0, done: true })),
      runTagBatch: vi.fn(async () => ({ processed: 0, failed: 0 })),
      countSyncable: vi.fn(async () => pending.length),
      nextSyncBatch: vi.fn(async ({ limit, exclude }) => {
        excludeSnapshots.push([...exclude])
        // Return t1 unless exclude already contains it; await yields to concurrent workers
        await Promise.resolve()
        return pending.filter(t => !exclude.includes(t)).slice(0, limit)
      }),
      syncItem: vi.fn(async token => {
        synced.push(token)
        await new Promise(r => setTimeout(r, 15))
        const idx = pending.indexOf(token)
        if (idx !== -1) pending.splice(idx, 1)
      }),
      retryFailedNow: vi.fn(async () => {}),
      isHostRejection: () => false,
    }
    const crawler = {
      runCatalogue: vi.fn(async () => ({ total: 1 })),
    }
    const limiter = {
      routeCount: vi.fn(() => 2),
      freeRoutes: vi.fn(() => 2),
      earliestReadyAt: vi.fn(() => new Date(Date.now() + 60_000)),
    }
    const settings = {
      get: vi.fn(async () => ({ autoSync: false, refetchDays: 7 })),
      refetchIntervalMs: vi.fn(async () => 7 * 24 * 60 * 60 * 1000),
    }

    Scheduler.setDependenciesForTests({
      crawler,
      mirror,
      jobs: {},
      settings,
      limiter,
    })

    try {
      await Scheduler.requestRun('sync', 'admin-1')
      for (let i = 0; i < 10 && (await SyncRun.current()); i++) {
        await Scheduler.runStep({ cfg: { crawler: { enabled: true } } })
      }
      expect(synced).toEqual(['t1'])
      // Every refill after t1 was issued must have t1 in exclude
      expect(excludeSnapshots.length).toBeGreaterThanOrEqual(2)
      for (const exc of excludeSnapshots.slice(1)) {
        expect(exc).toContain('t1')
      }
    } finally {
      Scheduler.setDependenciesForTests(null)
    }
  })

  it('[M-9] EgressController.testProxy returns HTTP 400 invalid_credentials after secret rotation', async () => {
    const col = createFakeCollection()
    setCollectionOverrideForTests({ templateGalleryConfig: col })
    Settings.security = { sessionSecret: 'initial-secret' }

    const EgressSettings = await import(
      '../../../app/src/egress/EgressSettings.mjs'
    )
    const EgressController = (
      await import('../../../app/src/controllers/EgressController.mjs')
    ).default
    EgressSettings.resetEgressSettingsForTests()

    const { proxy } = await EgressSettings.createProxy({
      label: 'rotated',
      scheme: 'socks5',
      host: 'proxy.example.net',
      port: 1080,
      username: 'alice',
      password: 'secret',
    })

    Settings.security = { sessionSecret: 'rotated-secret' }
    const res = mockRes()
    await EgressController.testProxy({ params: { id: proxy.id } }, res)

    expect(res.statusCode).toBe(400)
    expect(res.jsonBody).toEqual({ error: 'invalid_credentials' })
  })
})
