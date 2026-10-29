import crypto from 'node:crypto'
import Settings from '@overleaf/settings'
import { DEFAULTS } from '../TemplateGalleryDefaults.mjs'
import Lock from './Lock.mjs'
import JobStore from './JobStore.mjs'
import * as CrawlerJob from './handlers/CrawlerJob.mjs'
import * as HydrationJob from './handlers/HydrationJob.mjs'
import * as ValidationJob from './handlers/ValidationJob.mjs'
import * as IntegrityJob from './handlers/IntegrityJob.mjs'
import * as GcJob from './handlers/GcJob.mjs'
import Scheduler from './Scheduler.mjs'
import { logError } from '../observability/Log.mjs'

const RUNNER_ID = `runner-${process.pid}-${crypto.randomBytes(4).toString('hex')}`

let running = false
let pollTimer = null
let heartbeatTimer = null
let lastTickAt = null
let activeJob = null

const HANDLERS = {
  crawler: CrawlerJob,
  hydration: HydrationJob,
  validate: ValidationJob,
  validation: ValidationJob,
  integrity: IntegrityJob,
  gc: GcJob,
}

/**
 * Returns current status of the job runner.
 */
export function getStatus() {
  return {
    running,
    runnerId: RUNNER_ID,
    lastTickAt,
    activeJob: activeJob ? { id: activeJob._id, kind: activeJob.kind, attempt: activeJob.attempt } : null,
  }
}

/**
 * Executes a single tick of the runner loop.
 * Attempts to claim queued jobs, maintain distributed locks, and run job handlers.
 */
export async function tick(cfg = Settings.templateGallery || DEFAULTS) {
  lastTickAt = new Date()
  if (!running) return

  const lockLeaseMs = cfg?.runner?.lockLeaseMs || 600_000
  const jobLeaseMs = cfg?.runner?.jobLeaseMs || 600_000

  // 1. Try to acquire or renew validator lock & process queued jobs
  const validatorLock = await Lock.acquire('validator', RUNNER_ID, Date.now(), lockLeaseMs)
  if (validatorLock) {
    try {
      await Scheduler.enqueueMaintenanceIfDue(cfg)
      // Claim next job
      const job = await JobStore.claimNext(RUNNER_ID, Date.now(), jobLeaseMs)
      if (job) {
        activeJob = job
        const handler = HANDLERS[job.kind]
        if (!handler) {
          await JobStore.finish(job._id, RUNNER_ID, job.attempt, 'failed', {
            error: `Unknown job kind: ${job.kind}`,
          })
        } else {
          try {
            const ctx = {
              cfg,
              runnerId: RUNNER_ID,
              runtime: {
                sandboxEnforced: cfg?.validation?.sandboxEnforced,
                allowedImages: Settings.allowedImageNames,
              },
            }
            const res = await handler.run(job, ctx)
            await JobStore.finish(job._id, RUNNER_ID, job.attempt, 'done', res || {})
          } catch (jobErr) {
            logError('job_execution_failed', jobErr, { jobId: job._id, kind: job.kind })
            if (job.attempt < (job.maxAttempts || 3)) {
              const backoff = JobStore.backoffMs(job.attempt, cfg?.validation?.backoffBaseMs || 60_000)
              await JobStore.requeue(job._id, RUNNER_ID, job.attempt, backoff, jobErr)
            } else {
              await JobStore.finish(job._id, RUNNER_ID, job.attempt, 'failed', {
                error: jobErr.message,
              })
            }
          }
        }
        activeJob = null
      }
    } catch (err) {
      logError('validator_tick_error', err)
    }
  }

  // 2. Exactly one process (the 'crawler' lease holder) drives the mirror
  const crawlerLeader =
    cfg?.crawler?.enabled &&
    (await Lock.acquire('crawler', RUNNER_ID, Date.now(), lockLeaseMs))
  if (crawlerLeader) {
    Scheduler.lead(cfg, lockLeaseMs)
  } else {
    Scheduler.yieldLeadership()
  }
}

/**
 * Starts periodic execution and heartbeat.
 */
export function start(cfg = Settings.templateGallery || DEFAULTS) {
  if (running) return
  running = true
  const pollIntervalMs = cfg?.runner?.pollIntervalMs || 15_000
  const heartbeatMs = cfg?.runner?.heartbeatMs || 60_000

  // Start polling loop
  pollTimer = setInterval(async () => {
    try {
      await tick(cfg)
    } catch (err) {
      logError('runner_tick_interval_error', err)
    }
  }, pollIntervalMs)

  // Start heartbeat renewal for active locks and active jobs
  heartbeatTimer = setInterval(async () => {
    try {
      const lockLeaseMs = cfg?.runner?.lockLeaseMs || 600_000
      await Lock.renew('validator', RUNNER_ID, lockLeaseMs).catch(() => {})
      await Lock.renew('crawler', RUNNER_ID, lockLeaseMs).catch(() => {})
      if (activeJob) {
        await JobStore.renew(activeJob._id, RUNNER_ID, activeJob.attempt, lockLeaseMs).catch(() => {})
      }
    } catch (_e) {}
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
  await Scheduler.stop()
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  await Lock.release('validator', RUNNER_ID).catch(() => {})
  await Lock.release('crawler', RUNNER_ID).catch(() => {})
}

export default {
  start,
  stop,
  tick,
  getStatus,
}
