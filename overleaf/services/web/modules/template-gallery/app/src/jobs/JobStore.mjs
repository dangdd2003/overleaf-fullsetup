import crypto from 'node:crypto'
import { jobsCol } from '../persistence/Collections.mjs'

export const JOB_STATES = Object.freeze([
  'queued',
  'running',
  'done',
  'failed',
  'cancelled',
])
const LIST_LIMIT_MAX = 100
const LIST_LIMIT_DEFAULT = 20
const DEFAULT_MAX_ATTEMPTS = 3
const KIND_PATTERN = /^[a-z][a-z-]{0,39}$/

/**
 * Calculates exponential backoff in milliseconds given attempt number.
 *
 * @param {number} attempt - 1-based attempt index
 * @param {number} [baseMs=60_000]
 * @returns {number}
 */
export function backoffMs(attempt, baseMs = 60_000) {
  return baseMs * Math.pow(2, Math.max(0, attempt - 1))
}

function unwrap(res) {
  return res && res.value !== undefined ? res.value : res
}

/**
 * Job as the admin API may show it. Payload, lease owner and dedupe key stay
 * server-side.
 *
 * @param {object | null} job
 * @returns {object | null}
 */
export function sanitizeJob(job) {
  if (!job) return null
  const {
    payload,
    leaseOwner,
    leaseExpiresAt,
    dedupeKey,
    requestedBy,
    ...rest
  } = job
  return rest
}

/**
 * Enqueues a job into templateGalleryJobs.
 * Respects dedupeKey (returns the active job if one is queued or running).
 *
 * @param {{
 *   kind: string,
 *   itemId?: string | null,
 *   dedupeKey?: string | null,
 *   requestedBy?: string | null,
 *   maxAttempts?: number,
 *   runAfter?: number,
 *   payload?: Record<string, any>
 * }} jobSpec
 * @returns {Promise<{ job: object, deduped: boolean }>}
 */
export async function enqueue({
  kind,
  itemId = null,
  dedupeKey = null,
  requestedBy = null,
  maxAttempts = 3,
  runAfter = Date.now(),
  payload = {},
}) {
  const col = await jobsCol()

  // 1. If dedupeKey provided, check if an active job already exists
  if (dedupeKey) {
    const existing = await col.findOne({
      dedupeKey,
      state: { $in: ['queued', 'running'] },
    })
    if (existing) {
      return { job: existing, deduped: true }
    }
  }

  // 2. Insert new queued job
  const jobId = crypto.randomUUID()
  const now = new Date()
  const doc = {
    _id: jobId,
    kind: String(kind),
    itemId: itemId ? String(itemId) : null,
    dedupeKey: dedupeKey ? String(dedupeKey) : null,
    requestedBy: requestedBy ? String(requestedBy) : null,
    maxAttempts: Number(maxAttempts) || 3,
    attempt: 0,
    state: 'queued',
    runAfter: Number(runAfter) || Date.now(),
    payload: payload || {},
    createdAt: now,
    updatedAt: now,
  }

  try {
    await col.insertOne(doc)
    return { job: doc, deduped: false }
  } catch (err) {
    // If concurrent insert collided on unique dedupeKey partial index
    if (
      dedupeKey &&
      err &&
      (err.code === 11000 || err.codeName === 'DuplicateKey')
    ) {
      const active = await col.findOne({
        dedupeKey,
        state: { $in: ['queued', 'running'] },
      })
      if (active) return { job: active, deduped: true }
    }
    throw err
  }
}

/**
 * Lists jobs, newest first, sanitized. itemId, state and kind are optional
 * filters. The limit is clamped to 1..100.
 *
 * @param {{ itemId?: string, state?: string, kind?: string }} [filter]
 * @param {number} [limit=20]
 * @returns {Promise<object[]>}
 */
export async function listJobs(
  { itemId, state, kind } = {},
  limit = LIST_LIMIT_DEFAULT
) {
  const query = {}
  if (itemId) query.itemId = String(itemId)
  if (state !== undefined && state !== null && state !== '') {
    if (typeof state !== 'string' || !JOB_STATES.includes(state)) {
      const err = new Error('Unknown job state')
      err.code = 'invalid_state'
      throw err
    }
    query.state = state
  }
  if (kind !== undefined && kind !== null && kind !== '') {
    if (typeof kind !== 'string' || !KIND_PATTERN.test(kind)) {
      const err = new Error('Unknown job kind')
      err.code = 'invalid_field'
      throw err
    }
    query.kind = kind
  }
  const max = Math.min(
    Math.max(Math.trunc(Number(limit)) || LIST_LIMIT_DEFAULT, 1),
    LIST_LIMIT_MAX
  )

  const col = await jobsCol()
  const docs = await col
    .find(query)
    .sort({ createdAt: -1, _id: -1 })
    .limit(max)
    .toArray()
  return docs.map(sanitizeJob)
}

/**
 * Reads one job, sanitized.
 *
 * @param {string} jobId
 * @returns {Promise<object | null>}
 */
export async function getJob(jobId) {
  const col = await jobsCol()
  return sanitizeJob(await col.findOne({ _id: String(jobId) }))
}

/**
 * Cancels a job that has not started. Running and finished jobs cannot be
 * cancelled.
 *
 * @param {string} jobId
 * @returns {Promise<object>} the cancelled job, sanitized
 */
export async function cancelQueued(jobId) {
  const col = await jobsCol()
  const now = new Date()
  const res = await col.findOneAndUpdate(
    { _id: String(jobId), state: 'queued' },
    {
      $set: {
        state: 'cancelled',
        result: { cancelled: true },
        finishedAt: now,
        updatedAt: now,
      },
      $unset: { dedupeKey: '' },
    },
    { returnDocument: 'after' }
  )
  const job = unwrap(res)
  if (job) return sanitizeJob(job)

  const current = await col.findOne(
    { _id: String(jobId) },
    { projection: { state: 1 } }
  )
  if (!current) {
    const err = new Error(`Job not found: ${jobId}`)
    err.code = 'job_not_found'
    throw err
  }
  const err = new Error(
    `Only queued jobs can be cancelled (current: ${current.state})`
  )
  err.code = 'invalid_transition'
  err.details = { from: current.state, to: 'cancelled' }
  throw err
}

/**
 * Marks running jobs whose lease expired after their last attempt as failed,
 * so claimNext never runs them again.
 *
 * @param {any} col - templateGalleryJobs collection
 * @param {number} nowMs
 */
async function failExhaustedLeases(col, nowMs) {
  const now = new Date(nowMs)
  await col.updateMany(
    {
      state: 'running',
      leaseExpiresAt: { $lt: nowMs },
      $expr: {
        $gte: ['$attempt', { $ifNull: ['$maxAttempts', DEFAULT_MAX_ATTEMPTS] }],
      },
    },
    {
      $set: {
        state: 'failed',
        leaseOwner: null,
        lastError: 'lease_expired',
        result: { error: 'lease_expired' },
        finishedAt: now,
        updatedAt: now,
      },
      $unset: { dedupeKey: '' },
    }
  )
}

/**
 * Atomically claims the next eligible job for worker execution.
 * Finds either:
 *  - state: "queued" and runAfter <= nowMs
 *  - state: "running" with an expired lease (stale lease recovery) and
 *    attempt < maxAttempts
 *
 * Running jobs whose lease expired after their last attempt are marked failed
 * with 'lease_expired' instead of being reclaimed.
 *
 * Increments attempt, assigns leaseOwner and leaseExpiresAt, sets state to "running".
 *
 * @param {string} owner
 * @param {number} [nowMs=Date.now()]
 * @param {number} [leaseMs=600_000]
 * @returns {Promise<any | null>} Claimed job or null
 */
export async function claimNext(owner, nowMs = Date.now(), leaseMs = 600_000) {
  const col = await jobsCol()
  await failExhaustedLeases(col, nowMs)

  const filter = {
    $or: [
      { state: 'queued', runAfter: { $lte: nowMs } },
      {
        state: 'running',
        leaseExpiresAt: { $lt: nowMs },
        $expr: {
          $lt: [
            '$attempt',
            { $ifNull: ['$maxAttempts', DEFAULT_MAX_ATTEMPTS] },
          ],
        },
      },
    ],
  }

  const update = {
    $inc: { attempt: 1 },
    $set: {
      state: 'running',
      leaseOwner: owner,
      leaseExpiresAt: nowMs + leaseMs,
      startedAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    },
  }

  const options = {
    sort: { runAfter: 1, createdAt: 1 },
    returnDocument: 'after',
  }

  const rawRes = await col.findOneAndUpdate(filter, update, options)
  // Handle both Node MongoDB driver v3/v4/v5/v6 return shapes
  const job = rawRes?.value !== undefined ? rawRes.value : rawRes
  return job || null
}

/**
 * Renews an active lease on a running job, strictly fenced by leaseOwner and attempt.
 *
 * @param {string} jobId
 * @param {string} owner
 * @param {number} attempt
 * @param {number} [leaseMs=600_000]
 * @param {number} [nowMs=Date.now()]
 * @returns {Promise<boolean>}
 */
export async function renew(
  jobId,
  owner,
  attempt,
  leaseMs = 600_000,
  nowMs = Date.now()
) {
  const col = await jobsCol()
  const filter = {
    _id: jobId,
    leaseOwner: owner,
    attempt: Number(attempt),
    state: 'running',
  }
  const update = {
    $set: {
      leaseExpiresAt: nowMs + leaseMs,
      updatedAt: new Date(nowMs),
    },
  }
  const res = await col.updateOne(filter, update)
  return (res?.matchedCount ?? 0) > 0
}

/**
 * Performs a fenced partial update on a running job.
 *
 * @param {string} jobId
 * @param {string} owner
 * @param {number} attempt
 * @param {Record<string, any>} setFields
 * @returns {Promise<boolean>}
 */
export async function fencedUpdate(jobId, owner, attempt, setFields) {
  const col = await jobsCol()
  const filter = {
    _id: jobId,
    leaseOwner: owner,
    attempt: Number(attempt),
  }
  const update = {
    $set: {
      ...setFields,
      updatedAt: new Date(),
    },
  }
  const res = await col.updateOne(filter, update)
  return (res?.matchedCount ?? 0) > 0
}

/**
 * Re-queues a failed or retryable job with an exponential/specified delay.
 * Fenced on leaseOwner and attempt, and only applies to a running job.
 * Retains dedupeKey so duplicates remain blocked while waiting to re-run.
 *
 * @param {string} jobId
 * @param {string} owner
 * @param {number} attempt
 * @param {number} delayMs
 * @param {any} [lastError=null]
 * @returns {Promise<boolean>}
 */
export async function requeue(
  jobId,
  owner,
  attempt,
  delayMs,
  lastError = null
) {
  const col = await jobsCol()
  const filter = {
    _id: jobId,
    leaseOwner: owner,
    attempt: Number(attempt),
    state: 'running',
  }
  const update = {
    $set: {
      state: 'queued',
      leaseOwner: null,
      leaseExpiresAt: 0,
      runAfter: Date.now() + Math.max(0, Number(delayMs) || 0),
      lastError: lastError ? String(lastError?.message || lastError) : null,
      updatedAt: new Date(),
    },
  }
  const res = await col.updateOne(filter, update)
  return (res?.matchedCount ?? 0) > 0
}

/**
 * Marks a job as completed in a terminal state ('done', 'failed', 'cancelled').
 * Unsets dedupeKey to allow future enqueues for the same key.
 * Only a running job can be finished: a job its handler already finished keeps
 * that outcome, and the runner's own 'done' is ignored (returns false).
 *
 * @param {string} jobId
 * @param {string} owner
 * @param {number} attempt
 * @param {'done' | 'failed' | 'cancelled'} finalState
 * @param {Record<string, any>} [result={}]
 * @returns {Promise<boolean>}
 */
export async function finish(jobId, owner, attempt, finalState, result = {}) {
  const col = await jobsCol()
  const filter = {
    _id: jobId,
    leaseOwner: owner,
    attempt: Number(attempt),
    state: 'running',
  }
  const update = {
    $set: {
      state: finalState,
      result: result || {},
      finishedAt: new Date(),
      updatedAt: new Date(),
    },
    $unset: {
      dedupeKey: '',
    },
  }
  const res = await col.updateOne(filter, update)
  return (res?.matchedCount ?? 0) > 0
}

export default {
  JOB_STATES,
  enqueue,
  listJobs,
  getJob,
  cancelQueued,
  sanitizeJob,
  claimNext,
  renew,
  fencedUpdate,
  requeue,
  finish,
  backoffMs,
}
