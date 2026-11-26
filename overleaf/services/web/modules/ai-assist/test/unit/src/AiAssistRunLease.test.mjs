import { describe, it, beforeEach, afterEach, vi } from 'vitest'
import { expect } from 'chai'
import sinon from 'sinon'
import Settings from '@overleaf/settings'
import '../../../app/src/ModuleSettings.mjs'
import {
  AiAssistRunStore,
  OWNER_LEASE_TTL_SECONDS,
  ORPHAN_GRACE_MS,
  RUN_TTL_SECONDS,
} from '../../../app/src/AiAssistRunStore.mjs'
import { AiAssistRunReaper } from '../../../app/src/AiAssistRunReaper.mjs'

// An in-memory stand-in for the Redis commands the run store uses
function fakeRedis() {
  const hashes = new Map()
  const sets = new Map()
  const strings = new Map()
  const lists = new Map()
  const expireCalls = []
  const setCalls = []
  const hash = key => {
    if (!hashes.has(key)) hashes.set(key, {})
    return hashes.get(key)
  }
  const api = {
    hashes,
    strings,
    lists,
    expireCalls,
    setCalls,
    hset: async (key, fieldOrObj, val) => {
      const entry = hash(key)
      if (typeof fieldOrObj === 'object') Object.assign(entry, fieldOrObj)
      else entry[fieldOrObj] = val
    },
    hget: async (key, field) => hash(key)[field] ?? null,
    hgetall: async key => ({ ...hash(key) }),
    hincrby: async (key, field, by) => {
      const entry = hash(key)
      entry[field] = String(Number(entry[field] || 0) + by)
      return Number(entry[field])
    },
    sadd: async (key, member) => {
      if (!sets.has(key)) sets.set(key, new Set())
      sets.get(key).add(member)
    },
    srem: async (key, member) => sets.get(key)?.delete(member),
    smembers: async key => [...(sets.get(key) ?? [])],
    expire: async (key, ttl) => {
      expireCalls.push({ key, ttl })
      return 1
    },
    set: async (key, value, ...args) => {
      setCalls.push({ key, value, args })
      strings.set(key, value)
      return 'OK'
    },
    exists: async key => (strings.has(key) ? 1 : 0),
    incr: async key => {
      const next = Number(strings.get(key) || 0) + 1
      strings.set(key, String(next))
      return next
    },
    rpush: async (key, value) => {
      if (!lists.has(key)) lists.set(key, [])
      lists.get(key).push(value)
      return lists.get(key).length
    },
    lrange: async (key, start) => (lists.get(key) ?? []).slice(start),
    publish: async () => 1,
    multi() {
      const ops = []
      const pipeline = {
        hset: (...args) => (ops.push(() => api.hset(...args)), pipeline),
        expire: (...args) => (ops.push(() => api.expire(...args)), pipeline),
        sadd: (...args) => (ops.push(() => api.sadd(...args)), pipeline),
        exec: async () => {
          const out = []
          for (const op of ops) out.push([null, await op()])
          return out
        },
      }
      return pipeline
    },
  }
  return api
}

describe('AiAssistRunStore owner lease and durable stop', function () {
  let redis
  let store

  beforeEach(function () {
    redis = fakeRedis()
    store = new AiAssistRunStore(redis)
  })

  it('records the owner, and reports its lease alive only while the lease is held', async function () {
    await store.createRun({ runId: 'r1', projectId: 'p', userId: 'u', ownerId: 'owner_a' })
    expect((await store.getRun('r1')).ownerId).to.equal('owner_a')
    expect(redis.expireCalls).to.deep.include({
      key: 'ai-assist:run:r1',
      ttl: RUN_TTL_SECONDS,
    })

    expect(await store.isOwnerAlive('owner_a')).to.be.false
    await store.renewOwnerLease('owner_a')
    expect(await store.isOwnerAlive('owner_a')).to.be.true
    expect(redis.setCalls.at(-1)).to.deep.equal({
      key: 'ai-assist:owner:owner_a',
      value: '1',
      args: ['EX', OWNER_LEASE_TTL_SECONDS],
    })
  })

  it('keeps a stop requested in the run record', async function () {
    await store.createRun({ runId: 'r2', projectId: 'p', userId: 'u' })
    expect(await store.isStopRequested('r2')).to.be.false
    await store.requestStop('r2')
    expect(await store.isStopRequested('r2')).to.be.true
  })

  it('stores the phase a run is in', async function () {
    await store.createRun({ runId: 'r3', projectId: 'p', userId: 'u' })
    await store.setPhase('r3', 'tool:read_file')
    const run = await store.getRun('r3')
    expect(run.phase).to.equal('tool:read_file')
    expect(Number(run.phaseSince)).to.be.greaterThan(0)
  })

  it('marks a run orphaned only after its owner lease has been gone past the grace', async function () {
    const now = Date.now()
    vi.useFakeTimers({ now })
    try {
      await store.createRun({ runId: 'r4', projectId: 'p', userId: 'u', ownerId: 'owner_gone' })

      // First sight of the missing lease: the clock starts, nothing is marked
      await store.reconcileStaleRuns()
      expect((await store.getRun('r4')).status).to.equal('running')

      vi.setSystemTime(now + ORPHAN_GRACE_MS - 1000)
      await store.reconcileStaleRuns()
      expect((await store.getRun('r4')).status).to.equal('running')

      vi.setSystemTime(now + ORPHAN_GRACE_MS + 1000)
      const acted = await store.reconcileStaleRuns()
      expect(acted).to.deep.equal(['r4'])
      const run = await store.getRun('r4')
      expect(run.status).to.equal('error')
      const events = await store.getEvents('r4')
      expect(events.map(e => e.event.type)).to.include('error')
      expect(events.find(e => e.event.type === 'error').event.code).to.equal('runOrphaned')
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves a run alone while its owner lease is held, however stale its watchers', async function () {
    await store.createRun({ runId: 'r5', projectId: 'p', userId: 'u', ownerId: 'owner_live' })
    await store.renewOwnerLease('owner_live')
    await store.addWatcher('r5')
    expect(await store.reconcileStaleRuns()).to.deep.equal([])
    expect((await store.getRun('r5')).status).to.equal('running')
  })
})

describe('AiAssistRunReaper hardening', function () {
  let origGrace
  let origHeartbeat

  beforeEach(function () {
    origGrace = Settings.aiAssist?.orphanGraceSeconds
    origHeartbeat = Settings.aiAssist?.heartbeatStaleSeconds
    if (Settings.aiAssist) {
      Settings.aiAssist.orphanGraceSeconds = 300
      Settings.aiAssist.heartbeatStaleSeconds = 1800
    }
  })

  afterEach(function () {
    vi.useRealTimers()
    if (Settings.aiAssist) {
      Settings.aiAssist.orphanGraceSeconds = origGrace
      Settings.aiAssist.heartbeatStaleSeconds = origHeartbeat
    }
  })

  it('does not stop a run whose owner is gone; orphan reconciliation handles it', async function () {
    const control = { publish: sinon.stub().resolves() }
    const store = {
      getActiveRuns: sinon.stub().resolves(['r-dead']),
      getRun: sinon.stub().resolves({
        runId: 'r-dead',
        status: 'running',
        watchers: 1,
        ownerId: 'owner_dead',
      }),
      isOwnerAlive: sinon.stub().resolves(false),
      setZeroSince: sinon.stub().resolves(),
      clearZeroSince: sinon.stub().resolves(),
      reconcileStaleRuns: sinon.stub().resolves([]),
    }
    const reaper = new AiAssistRunReaper({ store, control })
    await reaper.sweepOnce()
    expect(control.publish.called).to.be.false
    expect(store.reconcileStaleRuns.calledOnce).to.be.true
  })

  it('gives up a sweep that hangs after 25 seconds, and runs the next one', async function () {
    vi.useFakeTimers()
    const store = {
      getActiveRuns: sinon.stub().returns(new Promise(() => {})),
      reconcileStaleRuns: sinon.stub().resolves([]),
    }
    const reaper = new AiAssistRunReaper({ store, control: { publish: sinon.stub() } })

    // The timed-out sweep rejects; the interval logs it
    const first = reaper.sweepOnce().catch(err => err)
    await vi.advanceTimersByTimeAsync(25_000)
    expect(await first).to.be.an('error')
    expect(reaper._sweeping).to.be.false

    store.getActiveRuns = sinon.stub().resolves([])
    await reaper.sweepOnce()
    expect(store.getActiveRuns.calledOnce).to.be.true
  })
})
