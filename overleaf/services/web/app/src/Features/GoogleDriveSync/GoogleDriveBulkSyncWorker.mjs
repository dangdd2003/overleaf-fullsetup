import { setTimeout as sleep } from 'node:timers/promises'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import Features from '../../infrastructure/Features.mjs'
import { db } from '../../infrastructure/mongodb.mjs'
import GoogleDriveSyncManager from './GoogleDriveSyncManager.mjs'

/**
 * Runs "sync selected projects to Google Drive" jobs in the background.
 *
 * Jobs are claimed with a lease rather than held in memory, so the work
 * outlives the request that queued it: if web restarts mid-job the lease
 * lapses and the next poll (on this or any other web process) resumes from
 * the first project not yet finished.
 *
 * Projects within a job run one at a time. Each is a full syncProject, which
 * lists and checksums the whole tree, and running a user's projects in
 * parallel would only trade throughput for Drive API rate limiting.
 */

// Short enough that a job orphaned by a restart resumes within minutes; the
// heartbeat keeps it held through a single slow project.
const LEASE_MS = 3 * 60 * 1000
const HEARTBEAT_MS = 60 * 1000
const LOCK_RETRY_ATTEMPTS = 3
const LOCK_RETRY_DELAY_MS = 10 * 1000

let pollTimer = null
let runningJobs = 0

function _concurrency() {
  return Settings.googleDrive?.bulkSyncConcurrency ?? 2
}

function _isLockError(err) {
  return /acquire project lock/i.test(err?.message || '')
}

/**
 * Atomically takes ownership of the oldest unfinished job whose lease has
 * lapsed (or was never taken).
 *
 * @returns {Promise<object|null>}
 */
async function _claimNextJob() {
  const now = new Date()
  const result = await db.googleDriveBulkSyncJobs.findOneAndUpdate(
    {
      active: true,
      $or: [
        { leaseExpiresAt: { $exists: false } },
        { leaseExpiresAt: null },
        { leaseExpiresAt: { $lt: now } },
      ],
    },
    {
      $set: {
        status: 'running',
        leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
        updatedAt: now,
      },
    },
    { sort: { createdAt: 1 }, returnDocument: 'after' }
  )
  return result?.value !== undefined ? result.value : result
}

/**
 * Updates a job only while it is still ours to work on. Returns false once
 * the job has been cancelled, which is the worker's signal to stop.
 *
 * @param {object} job
 * @param {object} update
 * @returns {Promise<boolean>}
 */
async function _updateActiveJob(job, update) {
  const now = new Date()
  const { matchedCount } = await db.googleDriveBulkSyncJobs.updateOne(
    { _id: job._id, active: true },
    {
      ...update,
      $set: {
        ...(update.$set || {}),
        leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
        updatedAt: now,
      },
    }
  )
  return matchedCount > 0
}

/**
 * One full reconcile of a project, retrying briefly when the outbound worker
 * or an inbound apply is already holding the project lock.
 *
 * @param {object} job
 * @param {object} entry
 * @returns {Promise<void>}
 */
async function _syncOneProject(job, entry) {
  for (let attempt = 1; ; attempt++) {
    try {
      await GoogleDriveSyncManager.syncProject(
        entry.projectId.toString(),
        job.userId.toString()
      )
      break
    } catch (err) {
      if (!_isLockError(err) || attempt >= LOCK_RETRY_ATTEMPTS) {
        throw err
      }
      await sleep(LOCK_RETRY_DELAY_MS)
    }
  }

  // Same as a manual "Sync now": a full reconcile subsumes every queued path.
  await db.googleDriveProjectStates.updateOne(
    { projectId: entry.projectId },
    { $set: { pendingChanges: {} }, $unset: { outboundDirtyAt: '' } }
  )
}

/**
 * Works through a claimed job's remaining projects.
 *
 * @param {object} job
 * @returns {Promise<void>}
 */
async function processJob(job) {
  const heartbeat = setInterval(() => {
    db.googleDriveBulkSyncJobs
      .updateOne(
        { _id: job._id, active: true },
        { $set: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) } }
      )
      .catch(err => {
        logger.warn(
          { err, jobId: job._id },
          'GoogleDriveBulkSyncWorker: failed to renew job lease'
        )
      })
  }, HEARTBEAT_MS)
  heartbeat.unref()

  try {
    await _processJobProjects(job)
  } finally {
    clearInterval(heartbeat)
  }
}

/**
 * @param {object} job
 * @returns {Promise<void>}
 */
async function _processJobProjects(job) {
  const projects = job.projects || []

  for (let i = 0; i < projects.length; i++) {
    const entry = projects[i]
    if (entry.status === 'synced' || entry.status === 'failed') {
      continue
    }

    const stillActive = await _updateActiveJob(job, {
      $set: { [`projects.${i}.status`]: 'syncing' },
    })
    if (!stillActive) {
      logger.info(
        { jobId: job._id, userId: job.userId },
        'GoogleDriveBulkSyncWorker: job cancelled, stopping'
      )
      return
    }

    let update
    try {
      await _syncOneProject(job, entry)
      update = { $set: { [`projects.${i}.status`]: 'synced' } }
    } catch (err) {
      logger.warn(
        { err, jobId: job._id, projectId: entry.projectId },
        'GoogleDriveBulkSyncWorker: project sync failed'
      )
      update = {
        $set: {
          [`projects.${i}.status`]: 'failed',
          [`projects.${i}.error`]: err?.message || String(err),
        },
      }
    }

    // Record the outcome even if the job was cancelled meanwhile, so the
    // finished project isn't shown as still syncing.
    await db.googleDriveBulkSyncJobs.updateOne({ _id: job._id }, update)
  }

  const now = new Date()
  await db.googleDriveBulkSyncJobs.updateOne(
    { _id: job._id, active: true },
    {
      $set: { status: 'completed', finishedAt: now, updatedAt: now },
      $unset: { active: '', leaseExpiresAt: '' },
    }
  )
  logger.info(
    { jobId: job._id, userId: job.userId },
    'GoogleDriveBulkSyncWorker: job completed'
  )
}

/**
 * @returns {Promise<void>}
 */
async function _fillSlots() {
  while (runningJobs < _concurrency()) {
    // Reserve the slot before the await, so overlapping kicks can't both
    // squeeze past the limit.
    runningJobs++
    let job
    try {
      job = await _claimNextJob()
    } catch (err) {
      runningJobs--
      throw err
    }
    if (!job) {
      runningJobs--
      return
    }

    processJob(job)
      .catch(err => {
        // Leave the job active: its lease lapses and a later poll resumes it.
        logger.error(
          { err, jobId: job._id },
          'GoogleDriveBulkSyncWorker: unexpected error processing job'
        )
      })
      .finally(() => {
        runningJobs--
        GoogleDriveBulkSyncWorker.kick()
      })
  }
}

const GoogleDriveBulkSyncWorker = {
  processJob,

  /**
   * Claims and starts jobs until this process is at its concurrency limit.
   * Safe to call at any time; it returns without waiting for jobs to finish.
   */
  kick() {
    if (!Features.hasFeature('google-drive-sync')) {
      return
    }
    _fillSlots().catch(err => {
      logger.error({ err }, 'GoogleDriveBulkSyncWorker: error claiming job')
    })
  },

  /**
   * Starts polling for queued jobs and jobs orphaned by a restart.
   */
  start() {
    if (pollTimer || !Features.hasFeature('google-drive-sync')) {
      return
    }

    const pollSeconds = Settings.googleDrive?.bulkSyncPollSeconds || 30
    logger.info(
      { pollSeconds },
      'GoogleDriveBulkSyncWorker: starting bulk sync worker'
    )

    GoogleDriveBulkSyncWorker.kick()
    pollTimer = setInterval(() => {
      GoogleDriveBulkSyncWorker.kick()
    }, pollSeconds * 1000)
    pollTimer.unref()
  },

  stop() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  },
}

export default GoogleDriveBulkSyncWorker
export { GoogleDriveBulkSyncWorker, processJob }
