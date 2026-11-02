import os from 'node:os'
import fsp from 'node:fs/promises'
import Path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../../../../../app/src/infrastructure/RedisWrapper.mjs', () => ({
  default: {
    client: () => ({
      on: () => {},
      once: () => {},
      disconnect: async () => {},
      quit: async () => {},
      defineCommand: () => {},
    }),
    cleanupTestRedis: async () => {},
  },
}))

// Tier 1 talks to a fake overleaf.com through requestRaw.
vi.mock(
  '../../../app/src/transport/GuardedHttps.mjs',
  async importOriginal => ({
    ...(await importOriginal()),
    requestRaw: vi.fn(),
  })
)

import { DEFAULTS } from '../../../app/src/TemplateGalleryDefaults.mjs'
import { mergePlain } from './support/mergePlain.mjs'
import { setCollectionOverrideForTests } from '../../../app/src/persistence/Collections.mjs'
import { requestRaw } from '../../../app/src/transport/GuardedHttps.mjs'
import { resetRateGateForTests } from '../../../app/src/transport/RateGate.mjs'
import { encryptCookie } from '../../../app/src/crypto/SessionCredentialStore.mjs'
import TemplateSourceAcquisitionService from '../../../app/src/services/TemplateSourceAcquisitionService.mjs'
import ZipInspector from '../../../app/src/zip/ZipInspector.mjs'
import BlobStore from '../../../app/src/storage/BlobStore.mjs'

const T0 = new Date('2026-01-01T00:00:00.000Z')
const MIN = 60_000
const PROJECT_ID = '0123456789abcdef01234567'
const LOADER_HTML =
  '<meta name="ol-csrfToken" content="csrf-1">' +
  '<form action="/project/new/template/123" data-ol-auto-submit>' +
  '<input name="_csrf" value="csrf-1"><input name="id" value="456"></form>'
const MAIN_TEX = '\\documentclass{article}\\begin{document}Hello\\end{document}'
const CACHED_SHA = 'c'.repeat(64)

function reply(status, headers = {}, body = Buffer.alloc(0)) {
  return { status, statusCode: status, headers, body, truncated: false }
}

// Tier 1 against a fake overleaf.com: loader, project create, zip download,
// project delete. `zipStatus` controls whether the download succeeds.
function fakeUpstream({ zipStatus = 500, zipBody = Buffer.alloc(0) } = {}) {
  requestRaw.mockImplementation(async (url, options = {}) => {
    const method = options.method || 'GET'
    if (method === 'POST')
      return reply(302, { location: `/project/${PROJECT_ID}` })
    if (method === 'DELETE') return reply(204)
    if (String(url).endsWith('/download/zip'))
      return reply(zipStatus, {}, zipBody)
    return reply(200, {}, Buffer.from(LOADER_HTML))
  })
}

const countCalls = method =>
  requestRaw.mock.calls.filter(
    ([, options]) => (options?.method || 'GET') === method
  ).length

// No token: the item is used as it is, without a detail fetch from the mirror.
function makeItem(overrides = {}) {
  return {
    _id: 'item-backoff-1',
    state: 'published',
    title: 'Backoff Template',
    publishedId: 123,
    objectID: 456,
    mainFile: 'main.tex',
    mainText: '',
    ...overrides,
  }
}

describe('S-P5 source acquisition backoff', () => {
  let tmpDir
  let itemsCol
  let configState
  let cfg

  function installCollections(
    credentialUpdatedAt = new Date(T0.getTime() - 24 * 60 * MIN)
  ) {
    configState = {
      doc: {
        _id: 'credentials',
        encryptedCookie: encryptCookie('overleaf_session2=sess-1'),
        status: 'VALID',
        updatedAt: credentialUpdatedAt,
      },
    }
    itemsCol = {
      updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    }
    const configCol = {
      findOne: vi.fn(async () => configState.doc),
      updateOne: vi.fn(async () => ({ matchedCount: 1 })),
    }
    setCollectionOverrideForTests({
      templateGalleryItems: itemsCol,
      templateGalleryConfig: configCol,
    })
  }

  // The backoff the service wrote last, as a later read of the item would see it.
  function recordedBackoff() {
    const call = itemsCol.updateOne.mock.calls
      .filter(([, update]) => update?.$set?.acquisitionBackoff)
      .at(-1)
    return call?.[1].$set.acquisitionBackoff
  }

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(Path.join(os.tmpdir(), 'tg-p5-backoff-'))
    cfg = mergePlain(DEFAULTS, { storageDir: tmpDir })
    resetRateGateForTests()
    requestRaw.mockReset()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    installCollections()
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    setCollectionOverrideForTests(null)
    resetRateGateForTests()
    await fsp.rm(tmpDir, { recursive: true, force: true })
  })

  describe('uncached items', () => {
    it('does not repeat the Tier 1 project create/delete inside the backoff window', async () => {
      fakeUpstream()
      const first = await TemplateSourceAcquisitionService.acquire(makeItem(), {
        cfg,
      })
      expect(first).toMatchObject({
        acquired: false,
        reason: 'all_tiers_failed',
      })
      expect(first.reasons).toEqual([
        'tier1:zip_download_failed',
        'tier3:missing_main_text',
      ])
      expect(countCalls('POST')).toBe(1)
      expect(countCalls('DELETE')).toBe(1)

      const backoff = recordedBackoff()
      expect(backoff).toMatchObject({ failures: 1, reasons: first.reasons })
      expect(backoff.retryAt.getTime() - T0.getTime()).toBe(5 * MIN)

      vi.setSystemTime(new Date(T0.getTime() + MIN))
      const second = await TemplateSourceAcquisitionService.acquire(
        makeItem({ acquisitionBackoff: backoff }),
        { cfg }
      )
      expect(second).toMatchObject({
        acquired: false,
        reason: 'all_tiers_failed',
        reasons: first.reasons,
      })
      expect(requestRaw).toHaveBeenCalledTimes(4)
    })

    it('retries after the window and doubles the wait for each consecutive failure', async () => {
      fakeUpstream()
      await TemplateSourceAcquisitionService.acquire(makeItem(), { cfg })
      const first = recordedBackoff()

      vi.setSystemTime(new Date(first.retryAt.getTime() + 1000))
      await TemplateSourceAcquisitionService.acquire(
        makeItem({ acquisitionBackoff: first }),
        { cfg }
      )
      expect(countCalls('POST')).toBe(2)

      const second = recordedBackoff()
      expect(second.failures).toBe(2)
      expect(second.retryAt.getTime() - second.attemptedAt.getTime()).toBe(
        10 * MIN
      )
    })

    it('starts the wait again at the base delay after a long quiet period', async () => {
      fakeUpstream()
      await TemplateSourceAcquisitionService.acquire(makeItem(), { cfg })
      const first = recordedBackoff()

      vi.setSystemTime(new Date(T0.getTime() + 7 * 60 * MIN))
      await TemplateSourceAcquisitionService.acquire(
        makeItem({ acquisitionBackoff: first }),
        { cfg }
      )
      const later = recordedBackoff()
      expect(later.failures).toBe(1)
      expect(later.retryAt.getTime() - later.attemptedAt.getTime()).toBe(
        5 * MIN
      )
    })

    it('lifts the backoff as soon as a session cookie is stored after the failure', async () => {
      fakeUpstream()
      await TemplateSourceAcquisitionService.acquire(makeItem(), { cfg })
      const backoff = recordedBackoff()

      vi.setSystemTime(new Date(T0.getTime() + MIN))
      configState.doc = {
        ...configState.doc,
        updatedAt: new Date(T0.getTime() + 30_000),
      }
      await TemplateSourceAcquisitionService.acquire(
        makeItem({ acquisitionBackoff: backoff }),
        { cfg }
      )
      expect(countCalls('POST')).toBe(2)
    })

    it('bypasses the backoff when forced', async () => {
      fakeUpstream()
      await TemplateSourceAcquisitionService.acquire(makeItem(), { cfg })
      const backoff = recordedBackoff()

      await TemplateSourceAcquisitionService.acquire(
        makeItem({ acquisitionBackoff: backoff }),
        {
          cfg,
          force: true,
        }
      )
      expect(countCalls('POST')).toBe(2)
    })

    it('an admin refetch keeps the backoff when respectBackoff is set', async () => {
      fakeUpstream()
      await TemplateSourceAcquisitionService.acquire(makeItem(), { cfg })
      const backoff = recordedBackoff()

      const result = await TemplateSourceAcquisitionService.acquire(
        makeItem({ acquisitionBackoff: backoff }),
        { cfg, force: true, respectBackoff: true }
      )
      expect(result).toMatchObject({ acquired: false, backoff: true })
      expect(countCalls('POST')).toBe(1)
    })

    it('a failed forced refetch serves the cached zip but flags refetchFailed', async () => {
      vi.spyOn(BlobStore, 'exists').mockResolvedValue(true)
      fakeUpstream()
      const result = await TemplateSourceAcquisitionService.acquire(
        makeItem({
          sourceBlobStoreKey: CACHED_SHA,
          acquisitionTier: 1,
          sourceAcquired: true,
        }),
        { cfg, force: true }
      )
      expect(result).toMatchObject({
        acquired: true,
        cached: true,
        refetchFailed: true,
      })
    })

    it('clears the backoff when an acquisition succeeds', async () => {
      fakeUpstream()
      await TemplateSourceAcquisitionService.acquire(makeItem(), { cfg })
      const backoff = recordedBackoff()

      const zipBody = await ZipInspector.createZipBufferFromEntries([
        { name: 'main.tex', content: MAIN_TEX },
      ])
      // the blob store is not written here; the commit itself is covered by its own tests
      vi.spyOn(BlobStore, 'commitFile').mockResolvedValue({
        sha256: 'b'.repeat(64),
        sizeBytes: zipBody.length,
      })
      vi.setSystemTime(new Date(backoff.retryAt.getTime() + 1000))
      fakeUpstream({ zipStatus: 200, zipBody })
      const result = await TemplateSourceAcquisitionService.acquire(
        makeItem({ acquisitionBackoff: backoff }),
        { cfg }
      )
      expect(result).toMatchObject({ acquired: true, tier: 1 })

      const persisted = itemsCol.updateOne.mock.calls.at(-1)[1]
      expect(persisted.$set.sourceAcquired).toBe(true)
      expect(persisted.$unset).toEqual({ acquisitionBackoff: '' })
    })
  })

  describe('cached zip whose upgrade failed', () => {
  })

  it.each([
    'https://github.com/author/template',
    'https://gitlab.com/author/template',
  ])('uses public main source without fetching a linked repository: %s', async url => {
    configState.doc = null

    const result = await TemplateSourceAcquisitionService.acquire(
      makeItem({ description: `Source: ${url}`, mainText: MAIN_TEX }),
      { cfg }
    )

    expect(result).toMatchObject({ acquired: true, tier: 3 })
    expect(requestRaw).not.toHaveBeenCalled()
  })
})
