import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DEFAULTS } from '../../../app/src/TemplateGalleryDefaults.mjs'

const calls = vi.hoisted(() => [])

vi.mock('../../../app/src/storage/StorageHealth.mjs', () => ({
  probe: vi.fn(async () => {
    calls.push('probe')
    return { ok: true, code: 'healthy' }
  }),
}))

vi.mock('../../../app/src/storage/CatalogSnapshot.mjs', () => ({
  ensureStoreIdentity: vi.fn(async () => {
    calls.push('ensureStoreIdentity')
    return { storeId: 'store-1', createdAt: new Date(0).toISOString() }
  }),
}))

vi.mock('../../../app/src/storage/CatalogSync.mjs', () => ({
  restoreIfNeeded: vi.fn(async () => {
    calls.push('restoreIfNeeded')
    return { action: 'none' }
  }),
  start: vi.fn(() => {
    calls.push('CatalogSync.start')
  }),
  stop: vi.fn(async () => {
    calls.push('CatalogSync.stop')
  }),
}))

vi.mock('../../../app/src/persistence/Indexes.mjs', () => ({
  ensureAll: vi.fn(async () => {
    calls.push('ensureAll')
    return { essentialOk: true, migration: {} }
  }),
}))

vi.mock('../../../app/src/jobs/Runner.mjs', () => ({
  default: {
    start: vi.fn(() => {
      calls.push('Runner.start')
    }),
    stop: vi.fn(async () => {
      calls.push('Runner.stop')
    }),
  },
}))

const Lifecycle = (await import('../../../app/src/Lifecycle.mjs')).default
const StorageHealth = await import('../../../app/src/storage/StorageHealth.mjs')
const CatalogSnapshot =
  await import('../../../app/src/storage/CatalogSnapshot.mjs')
const CatalogSync = await import('../../../app/src/storage/CatalogSync.mjs')

const cfg = { ...DEFAULTS, storageDir: '/nonexistent/tg-lifecycle' }

describe('Lifecycle boot order and shutdown (S-P1)', () => {
  beforeEach(async () => {
    calls.length = 0
    vi.mocked(StorageHealth.probe).mockClear()
    vi.mocked(CatalogSync.restoreIfNeeded).mockReset()
    vi.mocked(CatalogSync.restoreIfNeeded).mockImplementation(async () => {
      calls.push('restoreIfNeeded')
      return { action: 'none' }
    })
    await Lifecycle.stop()
    calls.length = 0
  })

  it('boots in order: storage probe, store identity, restore, indexes, runner, snapshot sync', async () => {
    const state = await Lifecycle.start(cfg)

    expect(calls).toEqual([
      'probe',
      'ensureStoreIdentity',
      'restoreIfNeeded',
      'ensureAll',
      'Runner.start',
      'CatalogSync.start',
    ])
    expect(CatalogSnapshot.ensureStoreIdentity).toHaveBeenCalledWith(
      cfg.storageDir
    )
    expect(CatalogSync.restoreIfNeeded).toHaveBeenCalledWith(cfg)
    expect(CatalogSync.start).toHaveBeenCalledWith(cfg)
    expect(state.ready).toBe(true)
    await Lifecycle.stop()
  })

  it('exposes the restore result in readinessState.snapshot', async () => {
    vi.mocked(CatalogSync.restoreIfNeeded).mockImplementationOnce(async () => {
      calls.push('restoreIfNeeded')
      return {
        action: 'restored',
        generation: 'gen-1',
        counts: { templateGalleryItems: 2 },
      }
    })

    const state = await Lifecycle.start(cfg)

    expect(state.snapshot).toEqual({
      action: 'restored',
      generation: 'gen-1',
      counts: { templateGalleryItems: 2 },
    })
    expect(Lifecycle.getReadinessState().snapshot).toEqual(state.snapshot)
    await Lifecycle.stop()
  })

  it('fails closed when the restore fails: not ready, no runner, no snapshot sync', async () => {
    vi.mocked(CatalogSync.restoreIfNeeded).mockImplementationOnce(async () => {
      calls.push('restoreIfNeeded')
      throw new Error('connection reset')
    })

    const state = await Lifecycle.start(cfg)

    expect(state.ready).toBe(false)
    expect(state.error).toBe('snapshot_restore_failed')
    expect(state.snapshot).toEqual({
      action: 'error',
      error: 'connection reset',
    })
    expect(calls).not.toContain('Runner.start')
    expect(calls).not.toContain('CatalogSync.start')
    expect(calls).not.toContain('ensureAll')
  })

  it('skips the store identity and restore when storage is unusable', async () => {
    vi.mocked(StorageHealth.probe).mockResolvedValueOnce({
      ok: false,
      code: 'not-a-mountpoint',
    })

    const state = await Lifecycle.start(cfg)

    expect(calls).not.toContain('ensureStoreIdentity')
    expect(calls).not.toContain('restoreIfNeeded')
    expect(calls).not.toContain('CatalogSync.start')
    expect(state.ready).toBe(false)
    expect(state.error).toBe('not-a-mountpoint')
    expect(state.snapshot).toBeNull()
  })

  it('stop() releases the runner lease before the final snapshot export', async () => {
    await Lifecycle.start(cfg)
    calls.length = 0

    await Lifecycle.stop()

    expect(calls).toEqual(['Runner.stop', 'CatalogSync.stop'])
    expect(Lifecycle.isReady()).toBe(false)
  })

  it('stop() still stops the runner when the snapshot sync stop fails', async () => {
    await Lifecycle.start(cfg)
    calls.length = 0
    vi.mocked(CatalogSync.stop).mockRejectedValueOnce(
      new Error('export exploded')
    )

    const outcome = await Lifecycle.stop().then(
      () => 'resolved',
      () => 'rejected'
    )
    expect(outcome).toBe('resolved')
    expect(calls).toEqual(['Runner.stop'])
  })
})
