import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setCollectionOverrideForTests } from '../../../app/src/persistence/Collections.mjs'
import {
  withHostSlot,
  isHostIdle,
  getHostStatus,
  setHostLimitsForTests,
  resetHostLimiterForTests,
  isThrottledError,
  MAX_QUEUED_PER_HOST,
  TASK_TIMEOUT_MS,
} from '../../../app/src/transport/HostLimiter.mjs'
import AlgoliaProxyClient from '../../../app/src/services/AlgoliaProxyClient.mjs'
import { createFakeCollection, rejectionOf } from './S-P4-support.mjs'
import { OUTBOUND_BLOCKED } from '../../../app/src/transport/GuardedHttps.mjs'

function deferred() {
  let resolve
  const promise = new Promise(r => {
    resolve = r
  })
  return { promise, resolve }
}

describe('S-P4 HostLimiter: bounded queue and per-task timeout', () => {
  beforeEach(() => {
    resetHostLimiterForTests()
    setHostLimitsForTests('algolia', {
      maxInFlight: 1,
      reservedInteractive: 0,
      minIntervalMs: 0,
    })
  })

  afterEach(() => {
    resetHostLimiterForTests()
    setCollectionOverrideForTests(null)
  })

  it('refuses a background caller with host_busy once the host queue is full', async () => {
    const gate = deferred()
    const running = withHostSlot(
      'algolia',
      { priority: 'background' },
      () => gate.promise
    )
    const queued = []
    for (let i = 0; i < MAX_QUEUED_PER_HOST; i++) {
      queued.push(
        withHostSlot('algolia', { priority: 'background' }, async () => i)
      )
    }

    const refused = await rejectionOf(
      withHostSlot('algolia', { priority: 'background' }, async () => 'never')
    )
    expect(refused).toMatchObject({ code: 'host_busy', hostKey: 'algolia' })

    const status = getHostStatus().algolia
    expect(status.queued.background).toBe(MAX_QUEUED_PER_HOST)
    expect(status.totals.rejected).toBe(1)
    // A refusal is not a host failure: it must not feed the circuit breaker.
    expect(status.consecutiveFailures).toBe(0)

    gate.resolve()
    await running
    await Promise.all(queued)
    expect(isHostIdle('algolia')).toBe(true)
  })

  it('lets an interactive caller displace the newest background task when the queue is full', async () => {
    const gate = deferred()
    const order = []
    const running = withHostSlot(
      'algolia',
      { priority: 'background' },
      () => gate.promise
    )
    const background = []
    for (let i = 0; i < MAX_QUEUED_PER_HOST; i++) {
      background.push(
        withHostSlot('algolia', { priority: 'background' }, async () => {
          order.push(`bg${i}`)
        })
      )
    }
    const interactive = withHostSlot(
      'algolia',
      { priority: 'interactive' },
      async () => {
        order.push('interactive')
      }
    )

    const displaced = await rejectionOf(background[MAX_QUEUED_PER_HOST - 1])
    expect(displaced).toMatchObject({ code: 'host_busy' })

    gate.resolve()
    await running
    await interactive
    await Promise.all(background.slice(0, -1))

    // The interactive caller is served before any queued background work.
    expect(order[0]).toBe('interactive')
    expect(order).toHaveLength(MAX_QUEUED_PER_HOST)
    expect(order).not.toContain(`bg${MAX_QUEUED_PER_HOST - 1}`)
  })

  it('refuses an interactive caller with host_busy when only interactive work is queued', async () => {
    const gate = deferred()
    const running = withHostSlot(
      'algolia',
      { priority: 'interactive' },
      () => gate.promise
    )
    const queued = []
    for (let i = 0; i < MAX_QUEUED_PER_HOST; i++) {
      queued.push(
        withHostSlot('algolia', { priority: 'interactive' }, async () => i)
      )
    }

    const refused = await rejectionOf(
      withHostSlot('algolia', { priority: 'interactive' }, async () => 'never')
    )
    expect(refused).toMatchObject({ code: 'host_busy' })

    gate.resolve()
    await running
    await Promise.all(queued)
  })

  it('releases the lane when a task never settles and rejects it with host_task_timeout', async () => {
    const stuck = withHostSlot(
      'algolia',
      { priority: 'background', timeoutMs: 40 },
      () => new Promise(() => {})
    )
    const next = withHostSlot(
      'algolia',
      { priority: 'background' },
      async () => 'after'
    )

    expect(await rejectionOf(stuck)).toMatchObject({
      code: 'host_task_timeout',
    })
    expect(await next).toBe('after')

    const status = getHostStatus().algolia
    expect(status.totals.failed).toBe(1)
    expect(status.lastError).toContain('task exceeded 40ms')
    expect(isHostIdle('algolia')).toBe(true)
  })

  it('ignores a timed-out task that settles later, and does not count it as success', async () => {
    let finishStuck
    const stuck = withHostSlot(
      'algolia',
      { priority: 'background', timeoutMs: 30 },
      () =>
        new Promise(resolve => {
          finishStuck = resolve
        })
    )
    expect(await rejectionOf(stuck)).toMatchObject({
      code: 'host_task_timeout',
    })

    const next = withHostSlot(
      'algolia',
      { priority: 'background' },
      async () => 'next'
    )
    finishStuck('late')
    expect(await next).toBe('next')

    const status = getHostStatus().algolia
    expect(status.totals.ok).toBe(1)
    expect(status.totals.failed).toBe(1)
  })

  it('defaults the per-task timeout to TASK_TIMEOUT_MS', () => {
    expect(TASK_TIMEOUT_MS).toBe(5 * 60_000)
  })

  it('queryAlgolia does not walk to the next Algolia host when the limiter refuses the call', async () => {
    setCollectionOverrideForTests({
      templateGalleryConfig: createFakeCollection(),
    })

    const gate = deferred()
    const running = withHostSlot(
      'algolia',
      { priority: 'background' },
      () => gate.promise
    )
    const queued = []
    for (let i = 0; i < MAX_QUEUED_PER_HOST; i++) {
      queued.push(
        withHostSlot('algolia', { priority: 'background' }, async () => i)
      )
    }

    const before = getHostStatus().algolia.totals.rejected
    const refused = await rejectionOf(
      AlgoliaProxyClient.queryAlgolia(
        { query: '' },
        {},
        { priority: 'background' }
      )
    )
    expect(refused).toMatchObject({ code: 'host_busy' })
    // One refused slot request, not one per Algolia host.
    expect(getHostStatus().algolia.totals.rejected - before).toBe(1)

    gate.resolve()
    await running
    await Promise.all(queued)
  })

  it('does not count a request refused by the outbound allow-list as a host failure', async () => {
    setHostLimitsForTests('algolia', {
      maxInFlight: 1,
      reservedInteractive: 0,
      minIntervalMs: 0,
    })
    for (let i = 0; i < 6; i++) {
      const err = new Error(
        'Outbound target blocked: writelatex.s3.amazonaws.com'
      )
      err.code = OUTBOUND_BLOCKED
      await rejectionOf(
        withHostSlot('algolia', { priority: 'background' }, async () => {
          throw err
        })
      )
    }
    const status = getHostStatus().algolia
    expect(status.circuit).toBe('closed')
    expect(status.consecutiveFailures).toBe(0)
    expect(status.totals.failed).toBe(6)
    expect(status.lastError).toContain('Outbound target blocked')
  })
})

describe('S-P4 HostLimiter: parallel slots', () => {
  beforeEach(() => {
    resetHostLimiterForTests()
    setHostLimitsForTests('overleaf', {
      maxInFlight: 4,
      reservedInteractive: 1,
      minIntervalMs: 0,
    })
  })

  afterEach(() => {
    resetHostLimiterForTests()
  })

  it('runs background work in parallel but keeps the reserved slot for interactive callers', async () => {
    const gates = Array.from({ length: 5 }, deferred)
    const started = []
    const background = gates.map((gate, i) =>
      withHostSlot('overleaf', { priority: 'background' }, async () => {
        started.push(`bg${i}`)
        await gate.promise
      })
    )
    await new Promise(resolve => setImmediate(resolve))
    // 4 slots, 1 reserved: three background tasks run, the rest wait
    expect(started).toEqual(['bg0', 'bg1', 'bg2'])

    const interactive = withHostSlot(
      'overleaf',
      { priority: 'interactive' },
      async () => {
        started.push('user')
        return 'page'
      }
    )
    expect(await interactive).toBe('page')
    expect(started).toContain('user')
    expect(getHostStatus().overleaf.inFlight.background).toBe(3)

    for (const gate of gates) gate.resolve()
    await Promise.all(background)
    expect(started).toHaveLength(6)
    expect(isHostIdle('overleaf')).toBe(true)
  })

  it('escalates the backoff once for parallel throttled requests', async () => {
    const throttled = () =>
      Promise.reject(Object.assign(new Error('slow down'), { status: 429 }))
    await Promise.allSettled([
      withHostSlot('overleaf', {}, throttled),
      withHostSlot('overleaf', {}, throttled),
      withHostSlot('overleaf', {}, throttled),
    ])
    expect(getHostStatus().overleaf.backoffLevel).toBe(1)
  })

  it('treats an overleaf.com 403 page as throttling: backs off and slows down', async () => {
    const blocked = Object.assign(new Error('403 Forbidden'), { status: 403 })
    const err = await rejectionOf(
      withHostSlot('overleaf', {}, () => Promise.reject(blocked))
    )

    expect(isThrottledError(err)).toBe(true)
    const status = getHostStatus().overleaf
    expect(status.backoffUntil).not.toBeNull()
    expect(status.intervalMs).toBeGreaterThanOrEqual(500)
  })

  it('does not treat a 403 from another host as throttling', async () => {
    const forbidden = Object.assign(new Error('403'), { status: 403 })
    const err = await rejectionOf(
      withHostSlot('s3', {}, () => Promise.reject(forbidden))
    )

    expect(isThrottledError(err)).toBe(false)
    expect(getHostStatus().s3.backoffUntil).toBeNull()
  })
})
