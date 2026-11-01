import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import mongodb from 'mongodb'
import { DEFAULTS } from '../../../app/src/TemplateGalleryDefaults.mjs'
import { mergePlain } from './support/mergePlain.mjs'
import { setCollectionOverrideForTests } from '../../../app/src/persistence/Collections.mjs'
import Runner from '../../../app/src/jobs/Runner.mjs'
import Lock from '../../../app/src/jobs/Lock.mjs'
import JobStore from '../../../app/src/jobs/JobStore.mjs'
import Scheduler from '../../../app/src/jobs/Scheduler.mjs'

const { ObjectId } = mongodb

// Resolves to the error thrown by promise, or null if it resolved.
async function rejectionOf(promise) {
  return promise.then(
    () => null,
    error => error
  )
}

// Crawler off and polling intervals long, so only explicit ticks run.
const RUNNER_CFG = mergePlain(DEFAULTS, {
  crawler: { enabled: false },
  runner: { pollIntervalMs: 1e9, heartbeatMs: 1e9 },
})

describe('JobStore queue cap, dedupe and admin queries', () => {
  let jobs
  let col

  function makeJobsCollection(initial = []) {
    jobs = [...initial]
    const cursor = {
      sort: vi.fn(() => cursor),
      limit: vi.fn(() => cursor),
      toArray: vi.fn(async () => results),
    }
    let results = []
    return {
      jobs,
      cursor,
      setResults(list) {
        results = list
      },
      findOne: vi.fn(async filter => {
        if (filter?.dedupeKey) {
          return (
            jobs.find(
              job =>
                job.dedupeKey === filter.dedupeKey &&
                ['queued', 'running'].includes(job.state)
            ) || null
          )
        }
        if (filter?._id !== undefined) {
          return (
            jobs.find(job => String(job._id) === String(filter._id)) || null
          )
        }
        return null
      }),
      countDocuments: vi.fn(
        async filter => jobs.filter(job => job.state === filter.state).length
      ),
      insertOne: vi.fn(async doc => {
        jobs.push(doc)
        return { insertedId: doc._id }
      }),
      find: vi.fn(() => cursor),
      findOneAndUpdate: vi.fn(async () => null),
    }
  }

  function queuedJobs(count, extra = {}) {
    return Array.from({ length: count }, (_, i) => ({
      _id: `queued-${i}`,
      kind: 'validate',
      state: 'queued',
      ...extra,
    }))
  }

  beforeEach(() => {
    col = makeJobsCollection()
    setCollectionOverrideForTests({ templateGalleryJobs: col })
  })

  afterEach(() => {
    setCollectionOverrideForTests(null)
    vi.restoreAllMocks()
  })

  const spec = (overrides = {}) => ({
    kind: 'validate',
    itemId: 'item-1',
    dedupeKey: null,
    ...overrides,
  })

  it('accepts work below the cap and reports deduped false', async () => {
    col = makeJobsCollection(queuedJobs(1))
    setCollectionOverrideForTests({ templateGalleryJobs: col })

    const res = await JobStore.enqueue(spec(), { validation: { queueCap: 2 } })
    expect(res.deduped).toBe(false)
    expect(res.job).toMatchObject({
      kind: 'validate',
      state: 'queued',
      itemId: 'item-1',
    })
    expect(col.insertOne).toHaveBeenCalledTimes(1)
  })

  it('returns the active job for the same dedupeKey before the cap is checked', async () => {
    col = makeJobsCollection([
      ...queuedJobs(3),
      {
        _id: 'job-active',
        kind: 'validate',
        state: 'running',
        dedupeKey: 'validate:item-1',
      },
    ])
    setCollectionOverrideForTests({ templateGalleryJobs: col })

    const res = await JobStore.enqueue(spec({ dedupeKey: 'validate:item-1' }), {
      validation: { queueCap: 1 },
    })
    expect(res).toMatchObject({ deduped: true })
    expect(res.job._id).toBe('job-active')
    expect(col.insertOne).not.toHaveBeenCalled()
  })

  it('returns the racing job when the unique dedupe index rejects the insert', async () => {
    col = makeJobsCollection()
    setCollectionOverrideForTests({ templateGalleryJobs: col })
    const racing = {
      _id: 'job-raced',
      kind: 'validate',
      state: 'queued',
      dedupeKey: 'validate:x',
    }
    col.insertOne.mockImplementationOnce(async () => {
      col.jobs.push(racing)
      throw Object.assign(new Error('E11000'), { code: 11000 })
    })

    const res = await JobStore.enqueue(spec({ dedupeKey: 'validate:x' }), {})
    expect(res).toMatchObject({ deduped: true })
    expect(res.job._id).toBe('job-raced')
  })

  it('lists jobs with filters, clamps the limit to 100 and strips server-only fields', async () => {
    col.setResults([
      {
        _id: 'job-1',
        kind: 'validate',
        state: 'queued',
        itemId: 'item-1',
        payload: { secret: true },
        leaseOwner: 'runner-1',
        leaseExpiresAt: 1,
        dedupeKey: 'validate:item-1',
        requestedBy: 'admin-1',
      },
    ])

    const jobs = await JobStore.listJobs(
      { itemId: 'item-1', state: 'queued' },
      500
    )
    expect(col.find).toHaveBeenCalledWith({ itemId: 'item-1', state: 'queued' })
    expect(col.cursor.limit).toHaveBeenCalledWith(100)
    expect(jobs).toEqual([
      { _id: 'job-1', kind: 'validate', state: 'queued', itemId: 'item-1' },
    ])
  })

  it('defaults the list limit to 20 and never below 1', async () => {
    await JobStore.listJobs({}, undefined)
    expect(col.cursor.limit).toHaveBeenLastCalledWith(20)
    await JobStore.listJobs({}, -5)
    expect(col.cursor.limit).toHaveBeenLastCalledWith(1)
  })

  it('rejects an unknown state and a non-string kind', async () => {
    expect(
      (await rejectionOf(JobStore.listJobs({ state: 'exploded' }))).code
    ).toBe('invalid_state')
    expect(
      (await rejectionOf(JobStore.listJobs({ state: { $ne: 'done' } }))).code
    ).toBe('invalid_state')
    expect(
      (await rejectionOf(JobStore.listJobs({ kind: { $gt: '' } }))).code
    ).toBe('invalid_field')
    expect(col.find).not.toHaveBeenCalled()
  })

  it('cancels a queued job and clears its dedupe key', async () => {
    col.findOneAndUpdate.mockResolvedValueOnce({
      _id: 'job-q',
      kind: 'validate',
      state: 'cancelled',
      payload: {},
    })

    const job = await JobStore.cancelQueued('job-q')
    expect(job).toMatchObject({ _id: 'job-q', state: 'cancelled' })
    expect(job).not.toHaveProperty('payload')
    expect(col.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'job-q', state: 'queued' },
      expect.objectContaining({ $unset: { dedupeKey: '' } }),
      expect.anything()
    )
  })

  it('refuses to cancel a running job with invalid_transition', async () => {
    col = makeJobsCollection([
      { _id: 'job-r', kind: 'validate', state: 'running' },
    ])
    setCollectionOverrideForTests({ templateGalleryJobs: col })

    const err = await rejectionOf(JobStore.cancelQueued('job-r'))
    expect(err.code).toBe('invalid_transition')
    expect(err.details).toEqual({ from: 'running', to: 'cancelled' })
  })

  it('reports job_not_found for an unknown job', async () => {
    const err = await rejectionOf(JobStore.cancelQueued('missing'))
    expect(err.code).toBe('job_not_found')
  })
})
