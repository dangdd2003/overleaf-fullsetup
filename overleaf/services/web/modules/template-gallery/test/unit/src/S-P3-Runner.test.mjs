// @ts-check
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DEFAULTS } from '../../../app/src/TemplateGalleryDefaults.mjs'
import { mergePlain } from './support/mergePlain.mjs'
import Runner from '../../../app/src/jobs/Runner.mjs'
import Lock from '../../../app/src/jobs/Lock.mjs'
import JobStore from '../../../app/src/jobs/JobStore.mjs'
import Scheduler from '../../../app/src/jobs/Scheduler.mjs'

// The gc handler is replaced so a test decides when a job finishes.
const { gcRun } = vi.hoisted(() => ({ gcRun: vi.fn() }))
vi.mock('../../../app/src/jobs/handlers/GcJob.mjs', () => ({
  run: gcRun,
  default: { run: gcRun },
}))

/**
 * @param {any} fn
 * @returns {any}
 */
function mocked(fn) {
  return fn
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Settles the start-up tick and any pending microtasks.
 */
async function flush() {
  await sleep(10)
}

/**
 * Crawler off and polling long, so only explicit ticks run unless a test
 * shortens the heartbeat.
 *
 * @param {Record<string, any>} [overrides]
 */
function cfgWith(overrides = {}) {
  return mergePlain(DEFAULTS, {
    crawler: { enabled: false },
    runner: { pollIntervalMs: 1e9, heartbeatMs: 1e9 },
    ...overrides,
  })
}

/**
 * Starts the runner and clears the calls made by its start-up tick.
 *
 * @param {Record<string, any>} cfg
 */
async function startRunner(cfg) {
  Runner.start(cfg)
  await flush()
  vi.clearAllMocks()
}

/** @type {(value?: any) => void} */
let releaseGc = () => {}

/**
 * Makes the next gc job block until the test calls releaseGc.
 */
function blockGcJob() {
  gcRun.mockImplementation(
    () =>
      new Promise(resolve => {
        releaseGc = resolve
      })
  )
}

describe('S-P3 Runner tick, heartbeat and leadership', () => {
  beforeEach(() => {
    gcRun.mockReset()
    releaseGc = () => {}
    vi.spyOn(Lock, 'read').mockResolvedValue(null)
    vi.spyOn(Lock, 'acquire').mockResolvedValue(true)
    vi.spyOn(Lock, 'renew').mockResolvedValue(true)
    vi.spyOn(Lock, 'release').mockResolvedValue(true)
    vi.spyOn(JobStore, 'claimNext').mockResolvedValue(null)
    vi.spyOn(JobStore, 'finish').mockResolvedValue(true)
    vi.spyOn(JobStore, 'requeue').mockResolvedValue(true)
    vi.spyOn(JobStore, 'renew').mockResolvedValue(true)
    vi.spyOn(Scheduler, 'enqueueMaintenanceIfDue').mockResolvedValue([])
    vi.spyOn(Scheduler, 'lead').mockImplementation(() => {})
    vi.spyOn(Scheduler, 'yieldLeadership').mockImplementation(() => {})
    vi.spyOn(Scheduler, 'stop').mockResolvedValue(undefined)
  })

  afterEach(async () => {
    // Release a blocked job so no tick is left in flight for the next test.
    releaseGc({ ok: true })
    await Runner.stop()
    vi.restoreAllMocks()
  })

  it('never overlaps ticks: a call made while a job runs returns without claiming', async () => {
    const cfg = cfgWith()
    await startRunner(cfg)
    blockGcJob()
    mocked(JobStore.claimNext).mockResolvedValueOnce({
      _id: 'g1',
      kind: 'gc',
      attempt: 1,
      maxAttempts: 3,
    })

    const first = Runner.tick(cfg)
    await flush()
    await Runner.tick(cfg)

    expect(JobStore.claimNext).toHaveBeenCalledTimes(1)
    expect(gcRun).toHaveBeenCalledTimes(1)

    releaseGc({ ok: true })
    await first
    expect(JobStore.finish).toHaveBeenCalledWith(
      'g1',
      expect.any(String),
      1,
      'done',
      { ok: true }
    )

    await Runner.tick(cfg)
    expect(JobStore.claimNext).toHaveBeenCalledTimes(2)
  })

  it('renews the running job with the job lease length and its own attempt', async () => {
    const cfg = cfgWith({ runner: { heartbeatMs: 20, jobLeaseMs: 123_000 } })
    await startRunner(cfg)
    blockGcJob()
    mocked(JobStore.claimNext).mockResolvedValueOnce({
      _id: 'g2',
      kind: 'gc',
      attempt: 2,
      maxAttempts: 3,
    })

    const tickPromise = Runner.tick(cfg)
    await sleep(80)

    expect(JobStore.renew).toHaveBeenCalledWith(
      'g2',
      expect.any(String),
      2,
      123_000
    )
    expect(Runner.getStatus().activeJob).toMatchObject({ id: 'g2', attempt: 2 })

    releaseGc({ ok: true })
    await tickPromise
    expect(Runner.getStatus().activeJob).toBeNull()
  })

  it('stops leading when the crawler lease renewal fails', async () => {
    const cfg = cfgWith({
      crawler: { enabled: true },
      runner: { heartbeatMs: 20 },
    })
    mocked(Lock.renew).mockImplementation(
      async (/** @type {string} */ lockId) => lockId !== 'crawler'
    )
    await startRunner(cfg)

    await sleep(80)

    expect(Lock.renew).toHaveBeenCalledWith(
      'crawler',
      expect.any(String),
      expect.any(Number)
    )
    expect(Scheduler.yieldLeadership).toHaveBeenCalled()
  })

  it('extends leadership on each successful crawler renewal while a long job runs', async () => {
    const cfg = cfgWith({
      crawler: { enabled: true },
      runner: { heartbeatMs: 20 },
    })
    await startRunner(cfg)
    blockGcJob()
    mocked(JobStore.claimNext).mockResolvedValueOnce({
      _id: 'g3',
      kind: 'gc',
      attempt: 1,
      maxAttempts: 3,
    })

    const tickPromise = Runner.tick(cfg)
    await sleep(80)

    expect(mocked(Scheduler.lead).mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(Scheduler.yieldLeadership).not.toHaveBeenCalled()

    releaseGc({ ok: true })
    await tickPromise
  })

  it('treats a crawler lock error as lost leadership instead of throwing', async () => {
    const cfg = cfgWith({ crawler: { enabled: true } })
    await startRunner(cfg)
    mocked(Lock.acquire).mockRejectedValueOnce(new Error('mongo unavailable'))

    await Runner.tick(cfg)
    expect(Scheduler.yieldLeadership).toHaveBeenCalled()
    expect(Scheduler.lead).not.toHaveBeenCalled()
  })

  it('does not overwrite a job its handler already settled, and clears the active job', async () => {
    const cfg = cfgWith()
    await startRunner(cfg)
    mocked(JobStore.claimNext).mockResolvedValueOnce({
      _id: 'g4',
      kind: 'gc',
      attempt: 1,
      maxAttempts: 3,
    })
    gcRun.mockResolvedValueOnce({ ok: true })
    mocked(JobStore.finish).mockResolvedValueOnce(false)

    await Runner.tick(cfg)

    expect(JobStore.finish).toHaveBeenCalledWith(
      'g4',
      expect.any(String),
      1,
      'done',
      { ok: true }
    )
    expect(JobStore.requeue).not.toHaveBeenCalled()
    expect(Runner.getStatus().activeJob).toBeNull()
  })

  it('does not requeue a job whose successful result could not be recorded', async () => {
    const cfg = cfgWith()
    await startRunner(cfg)
    mocked(JobStore.claimNext).mockResolvedValueOnce({
      _id: 'g5',
      kind: 'gc',
      attempt: 1,
      maxAttempts: 3,
    })
    gcRun.mockResolvedValueOnce({ ok: true })
    mocked(JobStore.finish).mockRejectedValueOnce(
      new Error('mongo unavailable')
    )

    await Runner.tick(cfg)
    expect(JobStore.requeue).not.toHaveBeenCalled()
    expect(Runner.getStatus().activeJob).toBeNull()
  })

  it('requeues a failed job with backoff while attempts remain', async () => {
    const cfg = cfgWith()
    await startRunner(cfg)
    mocked(JobStore.claimNext).mockResolvedValueOnce({
      _id: 'g6',
      kind: 'gc',
      attempt: 1,
      maxAttempts: 3,
    })
    gcRun.mockRejectedValueOnce(new Error('boom'))

    await Runner.tick(cfg)

    expect(JobStore.requeue).toHaveBeenCalledWith(
      'g6',
      expect.any(String),
      1,
      expect.any(Number),
      expect.any(Error)
    )
    expect(JobStore.finish).not.toHaveBeenCalled()
  })

  it('fails a job whose last attempt throws', async () => {
    const cfg = cfgWith()
    await startRunner(cfg)
    mocked(JobStore.claimNext).mockResolvedValueOnce({
      _id: 'g7',
      kind: 'gc',
      attempt: 3,
      maxAttempts: 3,
    })
    gcRun.mockRejectedValueOnce(new Error('boom'))

    await Runner.tick(cfg)

    expect(JobStore.requeue).not.toHaveBeenCalled()
    expect(JobStore.finish).toHaveBeenCalledWith(
      'g7',
      expect.any(String),
      3,
      'failed',
      { error: 'boom' }
    )
  })

  it('fails a job of an unknown kind without running anything', async () => {
    const cfg = cfgWith()
    await startRunner(cfg)
    mocked(JobStore.claimNext).mockResolvedValueOnce({
      _id: 'x1',
      kind: 'nope',
      attempt: 1,
      maxAttempts: 3,
    })

    await Runner.tick(cfg)

    expect(gcRun).not.toHaveBeenCalled()
    expect(JobStore.finish).toHaveBeenCalledWith(
      'x1',
      expect.any(String),
      1,
      'failed',
      {
        error: 'Unknown job kind: nope',
      }
    )
  })

  it('claims nothing after stop, even when a tick is called', async () => {
    const cfg = cfgWith()
    await startRunner(cfg)
    await Runner.stop()

    await Runner.tick(cfg)

    expect(JobStore.claimNext).not.toHaveBeenCalled()
  })
})
