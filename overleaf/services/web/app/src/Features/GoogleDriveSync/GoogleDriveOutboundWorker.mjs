import crypto from 'node:crypto'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import Features from '../../infrastructure/Features.mjs'
import { db } from '../../infrastructure/mongodb.mjs'
import GoogleDriveSyncManager from './GoogleDriveSyncManager.mjs'
import GoogleDriveClient from './GoogleDriveClient.mjs'
import DocstoreManager from '../Docstore/DocstoreManager.mjs'

/**
 * Batched outbound synchronization: Overleaf -> Google Drive.
 *
 * GoogleDriveHookHandler records which paths changed; this worker pushes only
 * those paths on a relaxed timer. It deliberately never calls syncProject:
 * that re-lists and re-checksums the entire project, which is affordable as a
 * user-triggered action but not on a timer.
 */

const OUTBOUND_MAX_ATTEMPTS = 5

let flushTimer = null
let isFlushing = false

/**
 * True when the doc's current content already matches what we last uploaded
 * to Drive, making a push pointless.
 *
 * This is the loop guard for the docModified hook, which carries no `source`:
 * an inbound Drive apply writes through document-updater, which flushes and
 * fires docModified, queueing a push of the exact bytes Drive already holds.
 * The hash must be computed identically to handleOutboundDocUpdate's upload
 * buffer (`lines.join('\n')` as utf8) or nothing will ever match.
 *
 * @param {string} projectId
 * @param {string} filePath
 * @param {object} entry
 * @param {object} state
 * @returns {Promise<boolean>}
 */
async function _docIsUnchanged(projectId, filePath, entry, state) {
  const mapped = state.fileMap?.[filePath]
  if (!mapped?.md5Checksum) {
    return false
  }

  const { lines } = await DocstoreManager.promises.getDoc(
    projectId,
    entry.entityId
  )
  const content = Array.isArray(lines) ? lines.join('\n') : lines || ''
  const hash = crypto
    .createHash('md5')
    .update(Buffer.from(content, 'utf8'))
    .digest('hex')

  return hash === mapped.md5Checksum
}

/**
 * Pushes one queued change. Returns nothing; throws on failure so the caller
 * can decide whether to retain or drop the entry.
 *
 * @param {string} projectId
 * @param {string} filePath
 * @param {object} entry
 * @param {object} state
 * @returns {Promise<{ diverged?: boolean } | void>}
 */
async function _applyChange(projectId, filePath, entry, state) {
  if (entry.op === 'delete') {
    await GoogleDriveSyncManager.handleOutboundDelete(projectId, filePath)
    return
  }

  // For updates to existing files, verify remote has not diverged
  const mapped = state.fileMap?.[filePath]
  if (mapped?.driveFileId && (entry.op === 'upsert' || !entry.op)) {
    try {
      const meta = await GoogleDriveClient.getFileMetadata(
        state.userId,
        mapped.driveFileId,
        'id,name,md5Checksum,trashed'
      )
      if (
        meta &&
        meta.md5Checksum &&
        mapped.md5Checksum &&
        meta.md5Checksum !== mapped.md5Checksum
      ) {
        logger.warn(
          { projectId, filePath },
          'GoogleDriveOutboundWorker: remote file diverged on Drive, deferring to inbound conflict sync'
        )
        return { diverged: true }
      }
    } catch (err) {
      if (
        err?.info?.status !== 404 &&
        err?.status !== 404 &&
        err?.statusCode !== 404 &&
        err?.response?.status !== 404
      ) {
        throw err
      }
    }
  }

  if (entry.entityType === 'doc') {
    if (await _docIsUnchanged(projectId, filePath, entry, state)) {
      logger.debug(
        { projectId, filePath },
        'GoogleDriveOutboundWorker: doc unchanged since last push, skipping'
      )
      return
    }
    await GoogleDriveSyncManager.handleOutboundDocUpdate(
      projectId,
      entry.entityId,
      filePath,
      entry.rev
    )
    return
  }

  await GoogleDriveSyncManager.handleOutboundFileUpdate(
    projectId,
    entry.entityId,
    filePath,
    entry.hash
  )
}

const GoogleDriveOutboundWorker = {
  /**
   * Flushes one project's pending changes.
   *
   * @param {object} state a googleDriveProjectStates document
   * @returns {Promise<void>}
   */
  async flushProject(state) {
    const projectId = state.projectId
    const pending = state.pendingChanges || {}
    const keys = Object.keys(pending)
    if (keys.length === 0) {
      return
    }

    const lockAcquired =
      await GoogleDriveSyncManager.acquireProjectLock(projectId)
    if (!lockAcquired) {
      // A manual sync or inbound apply is already working on this project.
      logger.debug(
        { projectId },
        'GoogleDriveOutboundWorker: project locked, skipping this cycle'
      )
      return
    }

    let allSucceeded = true

    try {
      // Oldest first, so a delete queued before a re-add is applied in order.
      const ordered = keys.sort((a, b) => {
        const at = new Date(pending[a]?.queuedAt || 0).getTime()
        const bt = new Date(pending[b]?.queuedAt || 0).getTime()
        return at - bt
      })

      for (const key of ordered) {
        const entry = pending[key]
        const filePath = GoogleDriveSyncManager.decodePathKey(key)

        try {
          const res = await _applyChange(projectId, filePath, entry, state)
          if (res?.diverged) {
            allSucceeded = false
            continue
          }
          await db.googleDriveProjectStates.updateOne(
            { projectId },
            { $unset: { [`pendingChanges.${key}`]: '' } }
          )
        } catch (err) {
          allSucceeded = false
          const attempts = (entry.attempts || 0) + 1

          if (attempts >= OUTBOUND_MAX_ATTEMPTS) {
            // One permanently broken file must not wedge the project forever.
            logger.error(
              { err, projectId, filePath, attempts },
              'GoogleDriveOutboundWorker: dropping change after max attempts'
            )
            await db.googleDriveProjectStates.updateOne(
              { projectId },
              { $unset: { [`pendingChanges.${key}`]: '' } }
            )
          } else {
            logger.warn(
              { err, projectId, filePath, attempts },
              'GoogleDriveOutboundWorker: change failed, will retry'
            )
            await db.googleDriveProjectStates.updateOne(
              { projectId },
              {
                $set: {
                  [`pendingChanges.${key}.attempts`]: attempts,
                  lastOutboundError: err?.message || String(err),
                },
              }
            )
          }

          if (err?.rateLimited) {
            // Stop working this project; the whole account is being throttled.
            await GoogleDriveSyncManager.recordSyncFailure(projectId, err)
            return
          }
        }
      }

      if (allSucceeded) {
        await GoogleDriveSyncManager.clearSyncFailure(projectId)
        await db.googleDriveProjectStates.updateOne(
          { projectId },
          {
            $set: { syncStatus: 'idle', lastSyncedAt: new Date() },
            $unset: { outboundDirtyAt: '' },
          }
        )
      }
    } finally {
      await GoogleDriveSyncManager.releaseProjectLock(projectId)
    }
  },

  /**
   * Selects and flushes every project whose dirty set has settled.
   *
   * @returns {Promise<void>}
   */
  async flushAll() {
    if (!Features.hasFeature('google-drive-sync')) {
      return
    }

    if (isFlushing) {
      logger.debug(
        'GoogleDriveOutboundWorker: flush already in progress, skipping cycle'
      )
      return
    }

    isFlushing = true
    try {
      const debounceSeconds =
        Settings.googleDrive?.outboundDebounceSeconds ?? 15
      const settledBefore = new Date(Date.now() - debounceSeconds * 1000)
      const now = new Date()

      const cursor = db.googleDriveProjectStates.find({
        outboundDirtyAt: { $lt: settledBefore },
        syncSuspended: { $ne: true },
        $or: [
          { backoffUntil: { $exists: false } },
          { backoffUntil: null },
          { backoffUntil: { $lt: now } },
        ],
      })

      for await (const state of cursor) {
        try {
          await GoogleDriveOutboundWorker.flushProject(state)
        } catch (err) {
          logger.error(
            { err, projectId: state.projectId },
            'GoogleDriveOutboundWorker: error flushing project'
          )
        }
      }
    } catch (err) {
      logger.error(
        { err },
        'GoogleDriveOutboundWorker: unexpected error during flushAll'
      )
    } finally {
      isFlushing = false
    }
  },

  /**
   * Starts the recurring flush timer.
   */
  start() {
    if (flushTimer) {
      return
    }
    if (!Features.hasFeature('google-drive-sync')) {
      return
    }

    const flushSeconds = Settings.googleDrive?.outboundFlushSeconds || 600

    logger.info(
      { flushSeconds },
      'GoogleDriveOutboundWorker: starting outbound flush worker'
    )

    flushTimer = setInterval(() => {
      GoogleDriveOutboundWorker.flushAll().catch(err => {
        logger.error(
          { err },
          'GoogleDriveOutboundWorker: error during interval execution'
        )
      })
    }, flushSeconds * 1000)
    flushTimer.unref()
  },

  /**
   * Stops the recurring flush timer.
   */
  stop() {
    if (flushTimer) {
      clearInterval(flushTimer)
      flushTimer = null
      logger.info('GoogleDriveOutboundWorker: stopped outbound flush worker')
    }
  },
}

export default GoogleDriveOutboundWorker
export { GoogleDriveOutboundWorker }
