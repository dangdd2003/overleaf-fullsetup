import { setTimeout as sleep } from 'node:timers/promises'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import Features from '../../infrastructure/Features.mjs'
import { db } from '../../infrastructure/mongodb.mjs'
import GoogleDriveSyncManager from './GoogleDriveSyncManager.mjs'

/**
 * Runs "scan and import selected folders from Google Drive to Overleaf" jobs in the background.
 *
 * Jobs are claimed with a lease and survive web restarts or user tab closes.
 * Folders within a job run sequentially to respect Google Drive rate limits and Overleaf project creation locks.
 */

const LEASE_MS = 3 * 60 * 1000
const HEARTBEAT_MS = 60 * 1000
const LOCK_RETRY_ATTEMPTS = 3
const LOCK_RETRY_DELAY_MS = 10 * 1000

let pollTimer = null
let runningJobs = 0

function _concurrency() {
  return Settings.googleDrive?.importConcurrency ?? 2
}

function _isLockError(err) {
  return /acquire project lock/i.test(err?.message || '')
}

async function _claimNextJob() {
  const now = new Date()
  const result = await db.googleDriveImportJobs.findOneAndUpdate(
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

async function _updateActiveJob(job, update) {
  const now = new Date()
  const { matchedCount } = await db.googleDriveImportJobs.updateOne(
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
 * Imports or synchronizes a single Google Drive folder into Overleaf.
 *
 * @param {object} job
 * @param {object} entry
 * @returns {Promise<{ projectId: any }>}
 */
async function _importOneFolder(job, entry) {
  const userId = job.userId.toString()

  // Check if this Drive folder is already linked to an Overleaf project
  const existingState = await db.googleDriveProjectStates.findOne({
    userId: job.userId,
    driveFolderId: entry.folderId,
  })

  if (existingState) {
    // Already linked: run sync with lock retry
    for (let attempt = 1; ; attempt++) {
      try {
        await GoogleDriveSyncManager.downloadDriveFolderToOverleaf(
          existingState.projectId.toString(),
          userId,
          entry.folderId
        )
        break
      } catch (err) {
        if (!_isLockError(err) || attempt >= LOCK_RETRY_ATTEMPTS) {
          throw err
        }
        await sleep(LOCK_RETRY_DELAY_MS)
      }
    }
    return { projectId: existingState.projectId }
  }

  // Not yet linked: create the new Overleaf project and import its files
  const file = { id: entry.folderId, name: entry.name }
  const newState = await GoogleDriveSyncManager._createProjectFromDriveFolder(
    userId,
    job.userId,
    file
  )

  return { projectId: newState.projectId }
}

async function processJob(job) {
  const heartbeat = setInterval(() => {
    db.googleDriveImportJobs
      .updateOne(
        { _id: job._id, active: true },
        { $set: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) } }
      )
      .catch(err => {
        logger.warn(
          { err, jobId: job._id },
          'GoogleDriveImportWorker: failed to renew job lease'
        )
      })
  }, HEARTBEAT_MS)
  heartbeat.unref()

  try {
    await _processJobFolders(job)
  } finally {
    clearInterval(heartbeat)
  }
}

async function _processJobFolders(job) {
  const folders = job.folders || []

  for (let i = 0; i < folders.length; i++) {
    const entry = folders[i]
    if (entry.status === 'synced' || entry.status === 'failed') {
      continue
    }

    const stillActive = await _updateActiveJob(job, {
      $set: { [`folders.${i}.status`]: 'importing' },
    })
    if (!stillActive) {
      logger.info(
        { jobId: job._id, userId: job.userId },
        'GoogleDriveImportWorker: job cancelled, stopping'
      )
      return
    }

    let update
    try {
      const { projectId } = await _importOneFolder(job, entry)
      update = {
        $set: {
          [`folders.${i}.status`]: 'synced',
          [`folders.${i}.projectId`]: projectId,
        },
      }
    } catch (err) {
      logger.warn(
        { err, jobId: job._id, folderId: entry.folderId },
        'GoogleDriveImportWorker: folder import failed'
      )

      const isDecryptionFailure =
        err?.code === 'token_decryption_failed' ||
        /authentication tag verification failed|Failed to decrypt token/i.test(
          err?.message || ''
        )

      if (isDecryptionFailure) {
        logger.error(
          { err, jobId: job._id, userId: job.userId },
          'GoogleDriveImportWorker: aborting import job due to token decryption failure'
        )
        const reauthMsg =
          'Google Drive authorization has expired or changed. Please re-link your account in Account Settings.'
        await db.googleDriveImportJobs.updateOne(
          { _id: job._id },
          {
            $set: {
              [`folders.${i}.status`]: 'failed',
              [`folders.${i}.error`]: reauthMsg,
              status: 'failed',
              error: reauthMsg,
              finishedAt: new Date(),
              updatedAt: new Date(),
            },
            $unset: { active: '', leaseExpiresAt: '' },
          }
        )
        return
      }

      update = {
        $set: {
          [`folders.${i}.status`]: 'failed',
          [`folders.${i}.error`]: err?.message || String(err),
        },
      }
    }

    await db.googleDriveImportJobs.updateOne({ _id: job._id }, update)
  }

  const now = new Date()
  await db.googleDriveImportJobs.updateOne(
    { _id: job._id, active: true },
    {
      $set: { status: 'completed', finishedAt: now, updatedAt: now },
      $unset: { active: '', leaseExpiresAt: '' },
    }
  )
  logger.info(
    { jobId: job._id, userId: job.userId },
    'GoogleDriveImportWorker: job completed'
  )
}

async function _fillSlots() {
  while (runningJobs < _concurrency()) {
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
        logger.error(
          { err, jobId: job._id },
          'GoogleDriveImportWorker: unexpected error processing job'
        )
      })
      .finally(() => {
        runningJobs--
        GoogleDriveImportWorker.kick()
      })
  }
}

const GoogleDriveImportWorker = {
  processJob,

  kick() {
    if (!Features.hasFeature('google-drive-sync')) {
      return
    }
    _fillSlots().catch(err => {
      logger.error({ err }, 'GoogleDriveImportWorker: error claiming job')
    })
  },

  start() {
    if (pollTimer || !Features.hasFeature('google-drive-sync')) {
      return
    }

    const pollSeconds = Settings.googleDrive?.importPollSeconds || 30
    logger.info(
      { pollSeconds },
      'GoogleDriveImportWorker: starting import worker'
    )

    GoogleDriveImportWorker.kick()
    pollTimer = setInterval(() => {
      GoogleDriveImportWorker.kick()
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

export default GoogleDriveImportWorker
export { GoogleDriveImportWorker, processJob }
