import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setCollectionOverrideForTests } from '../../../app/src/persistence/Collections.mjs'
import * as Scheduler from '../../../app/src/jobs/Scheduler.mjs'
import SyncRun from '../../../app/src/jobs/SyncRun.mjs'
import { createFakeCollection, rejectionOf } from './S-P4-support.mjs'

const DAY = 24 * 60 * 60 * 1000
const cfg = { crawler: { enabled: true } }

function fakeDeps({ queue = [], settings = {}, capacity = 6 } = {}) {
  const pending = [...queue]
  const crawler = {
    getCatalogueState: vi.fn(async () => ({ lastSuccessAt: new Date() })),
    runCatalogue: vi.fn(async () => ({ total: 12 })),
  }
  const mirror = {
    scanFeatured: vi.fn(async () => ({ templates: 0, gallery: 0 })),
    scanGalleryRecent: vi.fn(async () => ({ pages: 1, items: 2, done: true })),
    runTagBatch: vi.fn(async () => ({ processed: 0, failed: 0 })),
    countSyncable: vi.fn(async () => pending.length),
    nextSyncBatch: vi.fn(async ({ limit, exclude }) =>
      pending.filter(token => !exclude.includes(token)).slice(0, limit)
    ),
    syncItem: vi.fn(async token => {
      pending.splice(pending.indexOf(token), 1)
    }),
    retryFailedNow: vi.fn(async () => {}),
    isHostRejection: err => err?.code === 'host_backoff',
  }
  const limiter = {
    capacity: vi.fn(() => capacity),
    earliestReadyAt: vi.fn(() => new Date(Date.now() + 60_000)),
  }
  const syncSettings = {
    get: vi.fn(async () => ({ autoSync: false, refetchDays: 7, ...settings })),
    refetchIntervalMs: vi.fn(async () => (settings.refetchDays ?? 7) * DAY),
  }
  Scheduler.setDependenciesForTests({
    crawler,
    mirror,
    jobs: {},
    settings: syncSettings,
    limiter,
  })
  return { crawler, mirror, limiter }
}

// Runs steps until the run is no longer running (or the step budget ends)
async function runToEnd(maxSteps = 20) {
  const steps = []
  for (let i = 0; i < maxSteps; i++) {
    const res = await Scheduler.runStep({ cfg })
    steps.push(res.step)
    if (!(await SyncRun.current())) break
  }
  return steps
}

describe('S-P4 scheduler: sync runs', () => {
  let listings

  beforeEach(() => {
    listings = createFakeCollection()
    setCollectionOverrideForTests({
      templateGalleryCrawlerState: createFakeCollection(),
      templateGalleryListings: listings,
      templateGalleryItems: createFakeCollection(),
      templateGalleryConfig: createFakeCollection(),
    })
  })

  afterEach(() => {
    setCollectionOverrideForTests(null)
    Scheduler.setDependenciesForTests(null)
  })

  it('does nothing upstream while automatic sync is off and no sync was started', async () => {
    const { crawler, mirror } = fakeDeps({ queue: ['a'] })

    const res = await Scheduler.runStep({ cfg })

    expect(res.step).toBe('idle')
    expect(crawler.runCatalogue).not.toHaveBeenCalled()
    expect(mirror.scanFeatured).not.toHaveBeenCalled()
    expect(mirror.syncItem).not.toHaveBeenCalled()
  })

  it('starts a run automatically when automatic sync is on and none ran yet', async () => {
    fakeDeps({ settings: { autoSync: true } })

    await Scheduler.runStep({ cfg })

    const run = await SyncRun.read()
    expect(run.trigger).toBe('auto')
  })

  it('does not start an automatic run before refetchDays have passed', async () => {
    const { crawler } = fakeDeps({ settings: { autoSync: true } })
    await Scheduler.requestRun('sync', 'admin-1')
    await runToEnd()
    crawler.runCatalogue.mockClear()

    const res = await Scheduler.runStep({ cfg })

    expect(res.step).toBe('idle')
    expect(crawler.runCatalogue).not.toHaveBeenCalled()
  })

  it('runs every phase of "Sync now" in order and syncs every queued item', async () => {
    const queue = Array.from({ length: 20 }, (_, i) => `t${i}`)
    const { crawler, mirror } = fakeDeps({ queue })

    await Scheduler.requestRun('sync', 'admin-1')
    expect(mirror.retryFailedNow).toHaveBeenCalledTimes(1)
    const steps = await runToEnd()

    expect(steps).toEqual(['catalogue', 'new', 'details', 'tags', 'done'])
    expect(crawler.runCatalogue).toHaveBeenCalledTimes(1)
    expect(mirror.syncItem).toHaveBeenCalledTimes(20)
    const run = await SyncRun.read()
    expect(run.state).toBe('done')
    const details = run.phases.find(phase => phase.name === 'details')
    expect(details).toMatchObject({ state: 'done', done: 20, total: 20 })
    expect(run.phases.find(phase => phase.name === 'rescan').state).toBe(
      'skipped'
    )
  })

  it('uses one worker per free limiter slot', async () => {
    const queue = Array.from({ length: 30 }, (_, i) => `t${i}`)
    const { mirror } = fakeDeps({ queue, capacity: 5 })
    let running = 0
    let peak = 0
    const sync = mirror.syncItem.getMockImplementation()
    mirror.syncItem.mockImplementation(async token => {
      running++
      peak = Math.max(peak, running)
      await new Promise(resolve => setTimeout(resolve, 5))
      running--
      return sync(token)
    })

    await Scheduler.requestRun('sync', 'admin-1')
    await runToEnd()

    expect(peak).toBe(5)
  })

  it('refuses a second "Sync now" while a run is active', async () => {
    fakeDeps()
    await Scheduler.requestRun('sync', 'admin-1')

    expect(
      await rejectionOf(Scheduler.requestRun('sync', 'admin-1'))
    ).toMatchObject({ code: 'run_active' })
  })

  it('stops a run on request without starting the next phase', async () => {
    const { crawler } = fakeDeps()
    await Scheduler.requestRun('sync', 'admin-1')
    await Scheduler.requestStop()

    const res = await Scheduler.runStep({ cfg })

    expect(res.step).toBe('cancelled')
    expect(crawler.runCatalogue).not.toHaveBeenCalled()
    expect((await SyncRun.read()).state).toBe('cancelled')
  })

  it('waits for the limiter instead of failing items when the host refuses every lane', async () => {
    const { mirror } = fakeDeps({ queue: ['a', 'b', 'c'] })
    mirror.syncItem.mockRejectedValue(
      Object.assign(new Error('backing off'), { code: 'host_backoff' })
    )
    await Scheduler.requestRun('sync', 'admin-1')
    await Scheduler.runStep({ cfg })
    await Scheduler.runStep({ cfg })

    const res = await Scheduler.runStep({ cfg })

    expect(res.step).toBe('details')
    expect(res.sleepMs).toBeGreaterThan(0)
    const run = await SyncRun.read()
    expect(run.state).toBe('running')
    expect(run.waitingUntil).not.toBeNull()
    expect(SyncRun.view(run).waitReason).toBe('throttled')
    const details = run.phases.find(phase => phase.name === 'details')
    expect(details).toMatchObject({ state: 'running', failed: 0 })
  })

  it('says the route is failing, not throttled, when no lane is blocked', async () => {
    const { mirror, limiter } = fakeDeps({ queue: ['a'] })
    limiter.isThrottling = vi.fn(() => false)
    mirror.syncItem.mockRejectedValue(
      Object.assign(new Error('proxy down'), { code: 'EPROXY_UNREACHABLE' })
    )
    await Scheduler.requestRun('sync', 'admin-1')
    await Scheduler.runStep({ cfg })
    await Scheduler.runStep({ cfg })

    await Scheduler.runStep({ cfg })

    const run = await SyncRun.read()
    expect(run.waitingUntil).not.toBeNull()
    expect(SyncRun.view(run).waitReason).toBe('unavailable')
  })

  it('resumes a stored run in its current phase after a restart', async () => {
    const queue = ['a', 'b']
    fakeDeps({ queue })
    await Scheduler.requestRun('sync', 'admin-1')
    await Scheduler.runStep({ cfg })
    // A new process: fresh collaborators, same stored run
    const { crawler, mirror } = fakeDeps({ queue })

    const steps = await runToEnd()

    expect(steps[0]).toBe('new')
    expect(crawler.runCatalogue).not.toHaveBeenCalled()
    expect(mirror.syncItem).toHaveBeenCalledTimes(2)
  })

  it('takes no item once the lease is lost', async () => {
    const { mirror } = fakeDeps({ queue: ['a', 'b', 'c'] })
    await Scheduler.requestRun('sync', 'admin-1')
    await Scheduler.runStep({ cfg })
    await Scheduler.runStep({ cfg })
    // Checks: start of step, before the phase, then every worker
    const shouldStop = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)

    expect(
      await rejectionOf(Scheduler.runStep({ cfg, shouldStop }))
    ).toMatchObject({ code: 'scheduler_stopped' })
    expect(mirror.syncItem).not.toHaveBeenCalled()
  })

  it('walks the full listing in chunks when a rescan is asked for', async () => {
    const { mirror } = fakeDeps()
    mirror.scanGalleryRecent
      .mockResolvedValueOnce({ pages: 3, items: 2, done: true })
      .mockResolvedValueOnce({ pages: 10, items: 90, done: false })
      .mockResolvedValueOnce({ pages: 4, items: 30, done: true })

    await Scheduler.requestRun('sync', 'admin-1', { rescan: true })
    const steps = await runToEnd()

    expect(steps.filter(step => step === 'rescan')).toHaveLength(2)
    const scan = await listings.findOne({ _id: 'scan:gallery-recent' })
    expect(scan.nextPage).toBe(1)
    expect(scan.finishedAt).toBeInstanceOf(Date)
  })

  it('marks a phase failed on a real error and goes on with the next', async () => {
    const { crawler, mirror } = fakeDeps({ queue: ['a'] })
    crawler.runCatalogue.mockRejectedValue(new Error('algolia exploded'))

    await Scheduler.requestRun('sync', 'admin-1')
    await runToEnd()

    const run = await SyncRun.read()
    expect(run.phases[0]).toMatchObject({
      name: 'catalogue',
      state: 'failed',
      error: 'algolia exploded',
    })
    expect(mirror.syncItem).toHaveBeenCalledTimes(1)
    expect(run.state).toBe('done')
  })

  it('waits without taking items while every lane is backing off', async () => {
    const { mirror } = fakeDeps({ queue: ['a', 'b'], capacity: 0 })
    await Scheduler.requestRun('sync', 'admin-1')
    await Scheduler.runStep({ cfg })
    await Scheduler.runStep({ cfg })

    const res = await Scheduler.runStep({ cfg })

    expect(res.step).toBe('details')
    expect(res.sleepMs).toBeGreaterThan(0)
    expect(mirror.syncItem).not.toHaveBeenCalled()
  })

  it('ends the details step soon after a stop, without waiting for slow requests', async () => {
    const { mirror } = fakeDeps({ queue: ['a', 'b', 'c'] })
    mirror.syncItem.mockImplementation(() => new Promise(() => {}))
    await Scheduler.requestRun('sync', 'admin-1')
    await Scheduler.runStep({ cfg })
    await Scheduler.runStep({ cfg })

    const step = Scheduler.runStep({ cfg })
    await new Promise(resolve => setTimeout(resolve, 50))
    await Scheduler.requestStop()
    const started = Date.now()
    await step
    expect(Date.now() - started).toBeLessThan(5_000)

    const res = await Scheduler.runStep({ cfg })
    expect(res.step).toBe('cancelled')
  })
})
