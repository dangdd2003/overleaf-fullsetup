import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rejectionOf } from './S-P4-support.mjs'
import { setCollectionOverrideForTests } from '../../../app/src/persistence/Collections.mjs'
import { createFakeCollection } from './S-P4-support.mjs'
import * as EgressSettings from '../../../app/src/egress/EgressSettings.mjs'
import {
  withHostSlot,
  getHostStatus,
  capacity,
  earliestReadyAt,
  setHostLimitsForTests,
  resetHostLimiterForTests,
} from '../../../app/src/transport/HostLimiter.mjs'

// Two enabled proxies plus the direct lane. Interval 0 so tests do not wait.
const PROXY_A = 'px_aaaaaaaaaaaa'
const PROXY_B = 'px_bbbbbbbbbbbb'

function throttle(status = 403) {
  const err = new Error(`HTTP ${status}`)
  err.status = status
  return err
}

function gate() {
  let open
  const promise = new Promise(resolve => {
    open = resolve
  })
  return { promise, open }
}

async function loadLanes(col) {
  setCollectionOverrideForTests({ templateGalleryConfig: col })
  EgressSettings.resetEgressSettingsForTests()
  await EgressSettings.refresh()
}

describe('HostLimiter lanes', () => {
  beforeEach(async () => {
    resetHostLimiterForTests()
    setHostLimitsForTests('overleaf', {
      maxInFlight: 4,
      reservedInteractive: 1,
      minIntervalMs: 0,
      maxIntervalMs: 0,
    })
    await loadLanes(
      createFakeCollection([
        {
          _id: 'egressProxies',
          useDirect: true,
          version: 1,
          proxies: [
            { id: PROXY_A, label: 'a', scheme: 'http', host: '127.0.0.1', port: 1, enabled: true, allowPrivate: true, authEnc: null },
            { id: PROXY_B, label: 'b', scheme: 'http', host: '127.0.0.1', port: 2, enabled: true, allowPrivate: true, authEnc: null },
          ],
        },
      ])
    )
  })

  afterEach(() => {
    resetHostLimiterForTests()
    setCollectionOverrideForTests(null)
    EgressSettings.resetEgressSettingsForTests()
  })

  it('a 403 on lane A backs off only lane A', async () => {
    const err = await rejectionOf(
      withHostSlot('overleaf', { priority: 'background', egress: PROXY_A }, () => {
        throw throttle(403)
      })
    )
    expect(err.status).toBe(403)

    const lanes = Object.fromEntries(getHostStatus().overleaf.lanes.map(l => [l.id, l]))
    expect(lanes[PROXY_A].backoffUntil).not.toBeNull()
    expect(lanes[PROXY_B].backoffUntil).toBeNull()
    expect(lanes.direct.backoffUntil).toBeNull()

    const { egress } = await withHostSlot('overleaf', { priority: 'background', egress: PROXY_B }, async opts => opts)
    expect(egress.id).toBe(PROXY_B)
  })

  it('capacity sums the ready lanes and drops a backed-off lane', async () => {
    // 3 lanes x (4 - 1)
    expect(capacity('overleaf')).toBe(9)
    await rejectionOf(
      withHostSlot('overleaf', { priority: 'background', egress: PROXY_A }, () => {
        throw throttle(429)
      })
    )
    expect(capacity('overleaf')).toBe(6)
    expect(earliestReadyAt('overleaf')).toBeInstanceOf(Date)
    expect(earliestReadyAt('s3')).toBeNull()
  })

  it('an interactive task starts on an idle lane, not the busy one', async () => {
    const hold = gate()
    const busy = withHostSlot('overleaf', { priority: 'background', egress: PROXY_A }, () => hold.promise)
    const { egress } = await withHostSlot('overleaf', { priority: 'interactive' }, async opts => opts)
    expect(egress?.id).not.toBe(PROXY_A)
    hold.open()
    await busy
  })

  it('a pinned task runs only on its lane, and direct passes null', async () => {
    const pinned = await withHostSlot('overleaf', { egress: 'direct' }, async opts => opts)
    expect(pinned).toEqual({ egress: null })
    const onB = await withHostSlot('overleaf', { egress: PROXY_B }, async ({ egress }) => egress.id)
    expect(onB).toBe(PROXY_B)
  })

  it('rejects with circuit_open when every lane has an open circuit', async () => {
    const lanes = ['direct', PROXY_A, PROXY_B]
    for (const id of lanes) {
      for (let i = 0; i < 10; i++) {
        await withHostSlot('overleaf', { egress: id }, () => {
          const err = new Error('boom')
          err.status = 500
          throw err
        }).catch(() => {})
      }
    }
    const err = await withHostSlot('overleaf', { priority: 'interactive' }, async () => 'ok').catch(e => e)
    expect(err.code).toBe('circuit_open')
  })

  it('a pinned task on an open lane is refused while the other lanes still serve', async () => {
    for (let i = 0; i < 10; i++) {
      await withHostSlot('overleaf', { egress: PROXY_A }, () => {
        const err = new Error('boom')
        err.status = 500
        throw err
      }).catch(() => {})
    }
    const err = await withHostSlot('overleaf', { egress: PROXY_A }, async () => 'x').catch(e => e)
    expect(err.code).toBe('circuit_open')
    expect(await withHostSlot('overleaf', { egress: PROXY_B }, async () => 'b')).toBe('b')
  })

  describe('retry on another lane', () => {
    // Records the lane of each attempt and fails the first `failures` attempts
    function attempts(failures, error) {
      const seen = []
      const fn = async ({ egress }) => {
        seen.push(egress?.id ?? 'direct')
        if (seen.length <= failures) throw error(seen.length)
        return `ok on ${seen.at(-1)}`
      }
      return { seen, fn }
    }

    it('a throttle on one lane succeeds on another untried lane', async () => {
      const { seen, fn } = attempts(1, () => throttle(403))
      const result = await withHostSlot('overleaf', { priority: 'background' }, fn)
      expect(seen).toHaveLength(2)
      expect(seen[1]).not.toBe(seen[0])
      expect(result).toBe(`ok on ${seen[1]}`)
      expect(getHostStatus().overleaf.totals.retries).toBe(1)
    })

    it('a proxy error on one lane succeeds on another lane', async () => {
      const { seen, fn } = attempts(1, () => {
        const err = new Error('proxy unreachable')
        err.code = 'EPROXY_UNREACHABLE'
        return err
      })
      await withHostSlot('overleaf', { priority: 'background' }, fn)
      expect(seen).toHaveLength(2)
      expect(seen[1]).not.toBe(seen[0])
    })

    it('a connection reset on one lane succeeds on another lane', async () => {
      const { seen, fn } = attempts(1, () => {
        const err = new Error('socket hang up')
        err.code = 'ECONNRESET'
        return err
      })
      await withHostSlot('overleaf', { priority: 'background' }, fn)
      expect(seen).toHaveLength(2)
    })

    it('a per-task timeout on one lane is retried, with its own timeout', async () => {
      const seen = []
      const never = gate()
      const result = await withHostSlot(
        'overleaf',
        { priority: 'background', timeoutMs: 20 },
        ({ egress }) => {
          seen.push(egress?.id ?? 'direct')
          if (seen.length === 1) return never.promise
          return 'done'
        }
      )
      expect(result).toBe('done')
      expect(seen).toHaveLength(2)
      expect(seen[1]).not.toBe(seen[0])
    })

    it('an interactive task keeps its priority across the retry', async () => {
      const { seen, fn } = attempts(1, () => throttle(429))
      const result = await withHostSlot('overleaf', { priority: 'interactive' }, fn)
      expect(seen).toHaveLength(2)
      expect(result).toBe(`ok on ${seen[1]}`)
    })

    it('a 404 on one lane is not retried', async () => {
      const { seen, fn } = attempts(1, () => throttle(404))
      const err = await rejectionOf(withHostSlot('overleaf', { priority: 'background' }, fn))
      expect(err.status).toBe(404)
      expect(err.hostThrottled).toBeUndefined()
      expect(seen).toHaveLength(1)
      expect(getHostStatus().overleaf.totals.retries).toBe(0)
    })

    it('a parse error on one lane is not retried', async () => {
      const seen = []
      const err = await rejectionOf(
        withHostSlot('overleaf', { priority: 'background' }, async ({ egress }) => {
          seen.push(egress?.id ?? 'direct')
          throw new SyntaxError('Unexpected token <')
        })
      )
      expect(err).toBeInstanceOf(SyntaxError)
      expect(seen).toHaveLength(1)
    })

    it('a pinned task that is throttled is never moved', async () => {
      const seen = []
      const err = await rejectionOf(
        withHostSlot('overleaf', { priority: 'background', egress: PROXY_A }, async ({ egress }) => {
          seen.push(egress.id)
          throw throttle(403)
        })
      )
      expect(err.hostThrottled).toBe(true)
      expect(seen).toEqual([PROXY_A])
      expect(getHostStatus().overleaf.totals.retries).toBe(0)
    })

    it('when every lane fails, rejects with the last error and keeps hostThrottled', async () => {
      const { seen, fn } = attempts(Infinity, () => throttle(429))
      const err = await rejectionOf(withHostSlot('overleaf', { priority: 'background' }, fn))
      expect(err.hostThrottled).toBe(true)
      expect(err.status).toBe(429)
      expect(seen).toHaveLength(3)
    })

    it('tries each lane at most once per task', async () => {
      const { seen, fn } = attempts(Infinity, () => {
        const err = new Error('proxy refused')
        err.code = 'EPROXY_CONNECT'
        return err
      })
      const err = await rejectionOf(withHostSlot('overleaf', { priority: 'background' }, fn))
      expect(err.code).toBe('EPROXY_CONNECT')
      expect(seen).toHaveLength(3)
      expect(new Set(seen).size).toBe(3)
      expect(new Set(seen)).toEqual(new Set(['direct', PROXY_A, PROXY_B]))
    })
  })
})
