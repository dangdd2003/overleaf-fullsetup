import crypto from 'node:crypto'
import { DEFAULTS } from '../TemplateGalleryDefaults.mjs'
import Lock from './Lock.mjs'
import JobStore from './JobStore.mjs'
import * as IntegrityJob from './handlers/IntegrityJob.mjs'
import * as GcJob from './handlers/GcJob.mjs'
import * as DedupJob from './handlers/DedupJob.mjs'
import Scheduler from './Scheduler.mjs'
import { logError, logInfo, logWarn } from '../observability/Log.mjs'

const STOP_WAIT_MS = 5_000

// One lease, one leader. The process holding the 'crawler' lease drives the
// overleaf.com mirror (Scheduler) and runs the maintenance jobs (gc, integrity).
const RUNNER_ID = `runner-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
const DEFAULT_LEASE_MS = 600_000
const DEFAULT_MAX_ATTEMPTS = 3

let running = false
let pollTimer = null
let heartbeatTimer = null
let lastTickAt = null
let activeJob = null
let tickInFlight = false
let holdsCrawler = false

const HANDLERS = {
  integrity: IntegrityJob,
  gc: GcJob,
  dedup: DedupJob,
}

/**
 * Returns current status of the job runner.
 */
export function getStatus() {
  return {
    running,
    runnerId: RUNNER_ID,
    lastTickAt,
    activeJob: activeJob
      ? { id: activeJob._id, kind: activeJob.kind, attempt: activeJob.attempt }
      : null,
  }
}

function leaseMsOf(cfg, field) {
  return cfg?.runner?.[field] || DEFAULT_LEASE_MS
}

/**
 * Takes a lease. A failure to talk to Mongo counts as not holding it.
 */
async function tryAcquire(lockId, lockLeaseMs) {
  try {
    return await Lock.acquire(lockId, RUNNER_ID, Date.now(), lockLeaseMs)
  } catch (err) {
    logError('lock_acquire_failed', err, { lockId })
    return false
  }
}

/**
 * Renews a lease. A failure to talk to Mongo counts as a lost lease.
 */
async function renewLock(lockId, lockLeaseMs) {
  try {
    return await Lock.renew(lockId, RUNNER_ID, lockLeaseMs)
  } catch (err) {
    logError('lock_renew_failed', err, { lockId })
    return false
  }
}

/**
 * Executes a single tick of the runner loop.
 * Takes or renews the 'crawler' lease, then, while holding it, queues due
 * maintenance and runs one queued job.
 * A tick is never overlapped: while one is still running (for example while a
 * long job runs) a new call returns at once without doing any work.
 */
export async function tick(cfg = DEFAULTS) {
  if (tickInFlight) return
  tickInFlight = true
  try {
    await runTick(cfg)
  } finally {
    tickInFlight = false
  }
}

async function runTick(cfg) {
  lastTickAt = new Date()
  if (!running) return

  const lockLeaseMs = leaseMsOf(cfg, 'lockLeaseMs')
  const jobLeaseMs = leaseMsOf(cfg, 'jobLeaseMs')

  // Exactly one process holds the lease. Leadership is refreshed before any
  // job runs, so a long job does not stall it.
  holdsCrawler = await tryAcquire('crawler', lockLeaseMs)
  if (!holdsCrawler) {
    Scheduler.yieldLeadership()
    return
  }
  Scheduler.lead(cfg, lockLeaseMs)
  await runJobsTick(cfg, jobLeaseMs)
}

async function runJobsTick(cfg, jobLeaseMs) {
  try {
    await Scheduler.enqueueMaintenanceIfDue(cfg)
    // Nothing new is claimed once stopping.
    if (!running) return
    const job = await JobStore.claimNext(RUNNER_ID, Date.now(), jobLeaseMs)
    if (job) await runJob(job, cfg)
  } catch (err) {
    logError('job_tick_error', err)
  }
}

async function runJob(job, cfg) {
  activeJob = job
  try {
    const handler = HANDLERS[job.kind]
    if (!handler) {
      await finishJob(job, 'failed', { error: `Unknown job kind: ${job.kind}` })
      return
    }

    let res
    try {
      const ctx = { cfg, runnerId: RUNNER_ID }
      res = await handler.run(job, ctx)
    } catch (jobErr) {
      logError('job_execution_failed', jobErr, {
        jobId: job._id,
        kind: job.kind,
      })
      if (job.attempt < (job.maxAttempts || DEFAULT_MAX_ATTEMPTS)) {
        const backoff = JobStore.backoffMs(job.attempt)
        await JobStore.requeue(job._id, RUNNER_ID, job.attempt, backoff, jobErr)
      } else {
        await finishJob(job, 'failed', { error: jobErr.message })
      }
      return
    }
    await finishJob(job, 'done', res || {})
  } finally {
    activeJob = null
  }
}

async function finishJob(job, state, result) {
  const finished = await JobStore.finish(
    job._id,
    RUNNER_ID,
    job.attempt,
    state,
    result
  )
  if (!finished) {
    // The handler already settled the job (or the lease was lost); keep that outcome.
    logInfo('job_finish_skipped', {
      jobId: job._id,
      kind: job.kind,
      attempt: job.attempt,
      state,
    })
  }
}

/**
 * Renews the leases this process holds: the job it is running (with the job
 * lease length, fenced on its attempt) and the crawler lease. A failed crawler
 * renewal stops leadership at once.
 */
async function heartbeat(cfg) {
  const job = activeJob
  if (job) {
    const renewed = await JobStore.renew(
      job._id,
      RUNNER_ID,
      job.attempt,
      leaseMsOf(cfg, 'jobLeaseMs')
    ).catch(err => {
      logError('job_lease_renew_failed', err, { jobId: job._id })
      return null
    })
    if (renewed === false) {
      logWarn('job_lease_lost', {
        jobId: job._id,
        kind: job.kind,
        attempt: job.attempt,
      })
    }
  }

  if (holdsCrawler) {
    const held = await renewLock('crawler', leaseMsOf(cfg, 'lockLeaseMs'))
    if (!running) return
    if (held) {
      Scheduler.lead(cfg, leaseMsOf(cfg, 'lockLeaseMs'))
    } else {
      holdsCrawler = false
      logWarn('crawler_lease_lost', {})
      Scheduler.yieldLeadership()
    }
  }
}

/**
 * Starts periodic execution and heartbeat.
 */
export function start(cfg = DEFAULTS) {
  if (running) return
  running = true
  const pollIntervalMs = cfg?.runner?.pollIntervalMs || 15_000
  const heartbeatMs = cfg?.runner?.heartbeatMs || 60_000

  // Start polling loop
  pollTimer = setInterval(() => {
    tick(cfg).catch(err => logError('runner_tick_interval_error', err))
  }, pollIntervalMs)

  // Start heartbeat renewal for the lease and the active job
  heartbeatTimer = setInterval(() => {
    heartbeat(cfg).catch(err => logError('runner_heartbeat_error', err))
  }, heartbeatMs)

  // Trigger initial tick asynchronously
  setImmediate(() => {
    tick(cfg).catch(err => logError('initial_tick_error', err))
  })
}

/**
 * Stops the runner and cleans up timers.
 */
export async function stop() {
  running = false
  // A sync slice can run for minutes; the lease is released after a short
  // wait so the next process can lead at once. Workers stop taking items as
  // soon as leadership is dropped.
  let timer = null
  await Promise.race([
    Scheduler.stop(),
    new Promise(resolve => {
      timer = setTimeout(resolve, STOP_WAIT_MS)
      timer.unref?.()
    }),
  ])
  clearTimeout(timer)
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  await Lock.release('crawler', RUNNER_ID).catch(() => {})
  holdsCrawler = false
}

export default {
  start,
  stop,
  tick,
  getStatus,
}
