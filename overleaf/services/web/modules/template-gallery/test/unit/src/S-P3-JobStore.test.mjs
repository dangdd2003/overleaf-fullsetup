// @ts-check
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setCollectionOverrideForTests } from '../../../app/src/persistence/Collections.mjs'
import JobStore from '../../../app/src/jobs/JobStore.mjs'

const NOW = 1_700_000_000_000
const LEASE_MS = 600_000

/** @typedef {Record<string, any>} Doc */

/**
 * Evaluates the aggregation expressions JobStore puts in $expr.
 *
 * @param {any} expr
 * @param {Doc} doc
 * @returns {any}
 */
function evalExpr(expr, doc) {
  if (typeof expr === 'string' && expr.startsWith('$'))
    return doc[expr.slice(1)]
  if (Array.isArray(expr)) return expr.map(item => evalExpr(item, doc))
  if (expr && typeof expr === 'object') {
    const op = Object.keys(expr)[0]
    const args = evalExpr(expr[op], doc)
    if (op === '$ifNull') return args[0] ?? args[1]
    if (op === '$lt') return args[0] < args[1]
    if (op === '$gte') return args[0] >= args[1]
    throw new Error(`unsupported expression operator ${op}`)
  }
  return expr
}

/**
 * Matches the query subset used by JobStore: equality, $lt, $lte, $in, $or and $expr.
 *
 * @param {Doc} doc
 * @param {Doc} filter
 * @returns {boolean}
 */
function matches(doc, filter) {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$or')
      return cond.some((/** @type {Doc} */ f) => matches(doc, f))
    if (key === '$expr') return Boolean(evalExpr(cond, doc))
    const value = doc[key]
    if (
      cond &&
      typeof cond === 'object' &&
      Object.keys(cond).some(k => k.startsWith('$'))
    ) {
      return Object.entries(cond).every(([op, arg]) => {
        if (op === '$lt') return value !== undefined && value < arg
        if (op === '$lte') return value !== undefined && value <= arg
        if (op === '$in') return arg.includes(value)
        throw new Error(`unsupported query operator ${op}`)
      })
    }
    return value === cond
  })
}

/**
 * @param {Doc} doc
 * @param {Doc} update
 */
function applyUpdate(doc, update) {
  for (const [key, by] of Object.entries(update.$inc || {})) {
    doc[key] = (doc[key] || 0) + Number(by)
  }
  for (const [key, value] of Object.entries(update.$set || {})) {
    doc[key] = value
  }
  for (const key of Object.keys(update.$unset || {})) {
    delete doc[key]
  }
}

/**
 * In-memory templateGalleryJobs collection covering the calls JobStore makes.
 *
 * @param {Doc[]} initial
 */
function fakeJobsCollection(initial) {
  /** @type {Doc[]} */
  const docs = initial.map(doc => ({ ...doc }))
  return {
    docs,
    findOne: vi.fn(async (/** @type {Doc} */ filter) => {
      const doc = docs.find(d => matches(d, filter))
      return doc ? { ...doc } : null
    }),
    updateOne: vi.fn(
      async (/** @type {Doc} */ filter, /** @type {Doc} */ update) => {
        const doc = docs.find(d => matches(d, filter))
        if (!doc) return { matchedCount: 0, modifiedCount: 0 }
        applyUpdate(doc, update)
        return { matchedCount: 1, modifiedCount: 1 }
      }
    ),
    updateMany: vi.fn(
      async (/** @type {Doc} */ filter, /** @type {Doc} */ update) => {
        const hit = docs.filter(d => matches(d, filter))
        for (const doc of hit) applyUpdate(doc, update)
        return { matchedCount: hit.length, modifiedCount: hit.length }
      }
    ),
    findOneAndUpdate: vi.fn(
      async (
        /** @type {Doc} */ filter,
        /** @type {Doc} */ update,
        /** @type {Doc} */ options
      ) => {
        const sortKeys = Object.entries(options?.sort || {})
        const candidates = docs
          .filter(d => matches(d, filter))
          .sort((a, b) => {
            for (const [key, dir] of sortKeys) {
              if (a[key] < b[key]) return -Number(dir)
              if (a[key] > b[key]) return Number(dir)
            }
            return 0
          })
        const doc = candidates[0]
        if (!doc) return null
        applyUpdate(doc, update)
        return { value: { ...doc } }
      }
    ),
  }
}

/**
 * @param {Partial<Doc>} fields
 * @returns {Doc}
 */
function job(fields) {
  return {
    _id: 'job-1',
    kind: 'validate',
    state: 'queued',
    attempt: 0,
    maxAttempts: 3,
    runAfter: NOW - 1,
    createdAt: new Date(NOW - 1000),
    ...fields,
  }
}

describe('S-P3 JobStore.claimNext lease recovery', () => {
  afterEach(() => {
    setCollectionOverrideForTests(null)
    vi.restoreAllMocks()
  })

  it('claims a queued job whose runAfter has passed', async () => {
    const col = fakeJobsCollection([job({ _id: 'q1' })])
    setCollectionOverrideForTests({ templateGalleryJobs: col })

    const claimed = await JobStore.claimNext('runner-a', NOW, LEASE_MS)

    expect(claimed).toMatchObject({
      _id: 'q1',
      state: 'running',
      attempt: 1,
      leaseOwner: 'runner-a',
      leaseExpiresAt: NOW + LEASE_MS,
    })
  })

  it('reclaims an expired running job while attempts remain', async () => {
    const col = fakeJobsCollection([
      job({
        _id: 'r1',
        state: 'running',
        attempt: 1,
        leaseOwner: 'runner-dead',
        leaseExpiresAt: NOW - 1,
      }),
    ])
    setCollectionOverrideForTests({ templateGalleryJobs: col })

    const claimed = await JobStore.claimNext('runner-a', NOW, LEASE_MS)

    expect(claimed).toMatchObject({
      _id: 'r1',
      attempt: 2,
      leaseOwner: 'runner-a',
    })
  })

  it('never reclaims an expired job that used its last attempt, and fails it as lease_expired', async () => {
    const col = fakeJobsCollection([
      job({
        _id: 'r2',
        state: 'running',
        attempt: 3,
        maxAttempts: 3,
        leaseOwner: 'runner-dead',
        leaseExpiresAt: NOW - 1,
        dedupeKey: 'validate:item-2',
      }),
    ])
    setCollectionOverrideForTests({ templateGalleryJobs: col })

    const claimed = await JobStore.claimNext('runner-a', NOW, LEASE_MS)

    expect(claimed).toBeNull()
    expect(col.docs[0]).toMatchObject({
      _id: 'r2',
      state: 'failed',
      attempt: 3,
      lastError: 'lease_expired',
      result: { error: 'lease_expired' },
      leaseOwner: null,
    })
    expect(col.docs[0]).not.toHaveProperty('dedupeKey')
  })

  it('applies the default of 3 attempts to a job written without maxAttempts', async () => {
    const col = fakeJobsCollection([
      job({
        _id: 'legacy-2',
        state: 'running',
        attempt: 2,
        maxAttempts: undefined,
        leaseExpiresAt: NOW - 1,
      }),
      job({
        _id: 'legacy-3',
        state: 'running',
        attempt: 3,
        maxAttempts: undefined,
        leaseExpiresAt: NOW - 1,
      }),
    ])
    setCollectionOverrideForTests({ templateGalleryJobs: col })

    const claimed = await JobStore.claimNext('runner-a', NOW, LEASE_MS)

    expect(claimed).toMatchObject({ _id: 'legacy-2', attempt: 3 })
    expect(col.docs.find(d => d._id === 'legacy-3')).toMatchObject({
      state: 'failed',
      lastError: 'lease_expired',
    })
  })

  it('leaves a running job with a live lease alone', async () => {
    const col = fakeJobsCollection([
      job({
        _id: 'live',
        state: 'running',
        attempt: 1,
        leaseOwner: 'runner-b',
        leaseExpiresAt: NOW + 1000,
      }),
    ])
    setCollectionOverrideForTests({ templateGalleryJobs: col })

    expect(await JobStore.claimNext('runner-a', NOW, LEASE_MS)).toBeNull()
    expect(col.docs[0]).toMatchObject({
      state: 'running',
      leaseOwner: 'runner-b',
      attempt: 1,
    })
  })
})

describe('S-P3 JobStore finish and requeue apply only to a running job', () => {
  afterEach(() => {
    setCollectionOverrideForTests(null)
    vi.restoreAllMocks()
  })

  it('does not overwrite a job its handler already finished as failed', async () => {
    const col = fakeJobsCollection([
      job({
        _id: 'f1',
        state: 'failed',
        leaseOwner: 'runner-a',
        attempt: 1,
        result: { reason: 'sandbox-not-enforced' },
      }),
    ])
    setCollectionOverrideForTests({ templateGalleryJobs: col })

    const finished = await JobStore.finish('f1', 'runner-a', 1, 'done', {})

    expect(finished).toBe(false)
    expect(col.docs[0]).toMatchObject({
      state: 'failed',
      result: { reason: 'sandbox-not-enforced' },
    })
  })

  it('finishes a running job once and clears its dedupeKey', async () => {
    const col = fakeJobsCollection([
      job({
        _id: 'f2',
        state: 'running',
        leaseOwner: 'runner-a',
        attempt: 1,
        dedupeKey: 'validate:x',
      }),
    ])
    setCollectionOverrideForTests({ templateGalleryJobs: col })

    expect(
      await JobStore.finish('f2', 'runner-a', 1, 'done', { ok: true })
    ).toBe(true)
    expect(col.docs[0]).toMatchObject({ state: 'done', result: { ok: true } })
    expect(col.docs[0]).not.toHaveProperty('dedupeKey')
    expect(await JobStore.finish('f2', 'runner-a', 1, 'failed', {})).toBe(false)
    expect(col.docs[0].state).toBe('done')
  })

  it('finish is fenced on the lease owner and the attempt', async () => {
    const col = fakeJobsCollection([
      job({ _id: 'f3', state: 'running', leaseOwner: 'runner-a', attempt: 2 }),
    ])
    setCollectionOverrideForTests({ templateGalleryJobs: col })

    expect(await JobStore.finish('f3', 'runner-b', 2, 'done', {})).toBe(false)
    expect(await JobStore.finish('f3', 'runner-a', 1, 'done', {})).toBe(false)
    expect(col.docs[0].state).toBe('running')
  })

  it('requeue applies only to a running job', async () => {
    const col = fakeJobsCollection([
      job({ _id: 'rq1', state: 'done', leaseOwner: 'runner-a', attempt: 1 }),
      job({
        _id: 'rq2',
        state: 'running',
        leaseOwner: 'runner-a',
        attempt: 1,
        leaseExpiresAt: NOW + 1,
      }),
    ])
    setCollectionOverrideForTests({ templateGalleryJobs: col })

    expect(
      await JobStore.requeue('rq1', 'runner-a', 1, 1000, new Error('boom'))
    ).toBe(false)
    expect(col.docs[0].state).toBe('done')

    expect(
      await JobStore.requeue('rq2', 'runner-a', 1, 1000, new Error('boom'))
    ).toBe(true)
    expect(col.docs[1]).toMatchObject({
      state: 'queued',
      leaseOwner: null,
      lastError: 'boom',
    })
  })

  it('renew extends only the running attempt that owns the lease', async () => {
    const col = fakeJobsCollection([
      job({
        _id: 'rn1',
        state: 'running',
        leaseOwner: 'runner-a',
        attempt: 2,
        leaseExpiresAt: NOW + 1,
      }),
    ])
    setCollectionOverrideForTests({ templateGalleryJobs: col })

    expect(await JobStore.renew('rn1', 'runner-a', 1, LEASE_MS, NOW)).toBe(
      false
    )
    expect(await JobStore.renew('rn1', 'runner-a', 2, LEASE_MS, NOW)).toBe(true)
    expect(col.docs[0].leaseExpiresAt).toBe(NOW + LEASE_MS)
  })
})
