import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Settings from '@overleaf/settings'
import { DEFAULTS } from '../../../app/src/TemplateGalleryDefaults.mjs'
import { mergePlain } from './support/mergePlain.mjs'
import { setCollectionOverrideForTests } from '../../../app/src/persistence/Collections.mjs'
import Scheduler from '../../../app/src/jobs/Scheduler.mjs'

// Resolves to the error thrown by promise, or null if it resolved.
// chai-as-promised is the active expect here, so rejections are read directly.
async function rejectionOf(promise) {
  return promise.then(
    () => null,
    error => error
  )
}

describe('Scheduler.requestRun domain errors', () => {
  let state
  let savedSettings

  beforeEach(() => {
    state = {
      updateOne: vi.fn(async () => ({ matchedCount: 1, upsertedCount: 0 })),
    }
    setCollectionOverrideForTests({ templateGalleryCrawlerState: state })
    savedSettings = Settings.templateGallery
  })

  afterEach(() => {
    Settings.templateGallery = savedSettings
    setCollectionOverrideForTests(null)
    vi.restoreAllMocks()
  })

  it('refuses an unknown action with invalid_action and writes nothing', async () => {
    const err = await rejectionOf(
      Scheduler.requestRun('drop-tables', 'admin-1', mergePlain(DEFAULTS, {}))
    )
    expect(err.code).toBe('invalid_action')
    expect(state.updateOne).not.toHaveBeenCalled()
  })

  it('reports invalid_action before crawler_disabled when both apply', async () => {
    const err = await rejectionOf(
      Scheduler.requestRun('nope', null, { crawler: { enabled: false } })
    )
    expect(err.code).toBe('invalid_action')
  })

  it('starts a run for "sync" and refuses a second one while it runs', async () => {
    const runs = {
      current: vi.fn(async () => null),
      start: vi.fn(async () => ({ id: 'run-1' })),
    }
    const mirror = { retryFailedNow: vi.fn(async () => {}) }
    Scheduler.setDependenciesForTests({
      runs,
      mirror,
      settings: { refetchIntervalMs: async () => 7 * 86_400_000 },
    })

    const res = await Scheduler.requestRun('sync', 'admin-1', { rescan: true })
    expect(res).toEqual({ queued: true, action: 'sync', runId: 'run-1' })
    expect(runs.start).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: 'manual',
        requestedBy: 'admin-1',
        rescan: true,
      })
    )
    expect(mirror.retryFailedNow).toHaveBeenCalledTimes(1)

    runs.current.mockResolvedValue({ id: 'run-1' })
    const err = await rejectionOf(Scheduler.requestRun('sync', 'admin-1'))
    expect(err.code).toBe('run_active')
    Scheduler.setDependenciesForTests(null)
  })
})
