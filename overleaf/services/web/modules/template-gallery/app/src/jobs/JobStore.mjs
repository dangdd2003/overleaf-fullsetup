import crypto from 'node:crypto'
import { jobsCol } from '../persistence/Collections.mjs'

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

/**
 * Enqueues a job into templateGalleryJobs.
 * Respects dedupeKey (returns active job if already queued/running),
 * enforces queueCap (throws Error with code 'queue_full' if exceeded).
 *
 * @param {{
 *   kind: string,
 *   itemId?: string | null,
 *   zipSha256Expected?: string | null,
 *   compileHash?: string | null,
 *   dedupeKey?: string | null,
 *   requestedBy?: string | null,
 *   maxAttempts?: number,
 *   runAfter?: number,
 *   payload?: Record<string, any>
 * }} jobSpec
 * @param {{ queueCap?: number }} [cfg={}]
 * @returns {Promise<any>} The created or existing job document
 */
export async function enqueue(
  {
    kind,
    itemId = null,
    zipSha256Expected = null,
    compileHash = null,
    dedupeKey = null,
    requestedBy = null,
    maxAttempts = 3,
    runAfter = Date.now(),
    payload = {},
  },
  cfg = {}
) {
  const col = await jobsCol()

  // 1. If dedupeKey provided, check if an active job already exists
  if (dedupeKey) {
    const existing = await col.findOne({
      dedupeKey,
      state: { $in: ['queued', 'running'] },
    })
    if (existing) {
      return existing
    }
  }

  // 2. Check queue capacity if specified
  const queueCap = cfg?.queueCap
  if (typeof queueCap === 'number' && queueCap > 0) {
    const queuedCount = await col.countDocuments({ state: 'queued' })
    if (queuedCount >= queueCap) {
      const err = new Error(`Job queue capacity of ${queueCap} reached`)
      err.code = 'queue_full'
      throw err
    }
  }

  // 3. Insert new queued job
  const jobId = crypto.randomUUID()
  const now = new Date()
  const doc = {
    _id: jobId,
    kind: String(kind),
    itemId: itemId ? String(itemId) : null,
    zipSha256Expected: zipSha256Expected ? String(zipSha256Expected) : null,
    compileHash: compileHash ? String(compileHash) : null,
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
    return doc
  } catch (err) {
    // If concurrent insert collided on unique dedupeKey partial index
    if (dedupeKey && err && (err.code === 11000 || err.codeName === 'DuplicateKey')) {
      const active = await col.findOne({
        dedupeKey,
        state: { $in: ['queued', 'running'] },
      })
      if (active) return active
    }
    throw err
  }
}

/**
 * Atomically claims the next eligible job for worker execution.
 * Finds either:
 *  - state: "queued" and runAfter <= nowMs
 *  - state: "running" and leaseExpiresAt < nowMs (stale lease recovery)
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

  const filter = {
    $or: [
      { state: 'queued', runAfter: { $lte: nowMs } },
      { state: 'running', leaseExpiresAt: { $lt: nowMs } },
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
export async function renew(jobId, owner, attempt, leaseMs = 600_000, nowMs = Date.now()) {
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
 * Fenced on leaseOwner and attempt.
 * Retains dedupeKey so duplicates remain blocked while waiting to re-run.
 *
 * @param {string} jobId
 * @param {string} owner
 * @param {number} attempt
 * @param {number} delayMs
 * @param {any} [lastError=null]
 * @returns {Promise<boolean>}
 */
export async function requeue(jobId, owner, attempt, delayMs, lastError = null) {
  const col = await jobsCol()
  const filter = {
    _id: jobId,
    leaseOwner: owner,
    attempt: Number(attempt),
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
  enqueue,
  claimNext,
  renew,
  fencedUpdate,
  requeue,
  finish,
  backoffMs,
}
