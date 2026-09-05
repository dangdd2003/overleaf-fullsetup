import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import Features from '../../infrastructure/Features.mjs'
import { db } from '../../infrastructure/mongodb.mjs'
import GoogleDriveSyncManager from './GoogleDriveSyncManager.mjs'

let pollIntervalTimer = null
let isPolling = false
let pollCycleCounter = 0

/**
 * Background polling worker that regularly checks linked Google Drive accounts
 * for inbound remote file changes and triggers project reconciliation.
 */
const GoogleDrivePollingWorker = {
  /**
   * Polls linked Google Drive users sequentially for remote changes.
   * If a user has an active, unexpired push watch channel, they are polled
   * only every Nth cycle (watchedUserPollRatio) as a fallback.
   */
  async pollAllUsers() {
    if (isPolling) {
      logger.debug(
        'GoogleDrivePollingWorker: poll already in progress, skipping cycle'
      )
      return
    }

    isPolling = true
    pollCycleCounter++
    const cycle = pollCycleCounter
    const pollRatio = Settings.googleDrive?.watchedUserPollRatio || 10
    const now = Date.now()

    try {
      const cursor = db.googleDriveUserCredentials.find(
        {},
        {
          projection: {
            user_id: 1,
            watchChannelId: 1,
            watchExpiresAt: 1,
          },
        }
      )
      for await (const creds of cursor) {
        const isWatched =
          Boolean(creds.watchChannelId) &&
          Boolean(creds.watchExpiresAt) &&
          new Date(creds.watchExpiresAt).getTime() > now

        if (isWatched && cycle % pollRatio !== 0) {
          // Push notifications handle this user; skip this poll cycle
          continue
        }

        try {
          await GoogleDriveSyncManager.pollUserChanges(creds.user_id)
        } catch (err) {
          logger.error(
            { err, userId: creds.user_id },
            'GoogleDrivePollingWorker: error polling changes for user'
          )
        }
      }
    } catch (err) {
      logger.error(
        { err },
        'GoogleDrivePollingWorker: unexpected error during pollAllUsers'
      )
    } finally {
      isPolling = false
    }
  },

  /**
   * Starts the recurring background polling timer.
   */
  start() {
    if (pollIntervalTimer) {
      return
    }

    if (!Features.hasFeature('google-drive-sync')) {
      return
    }

    const pollIntervalSeconds = Settings.googleDrive?.pollIntervalSeconds || 300
    const intervalMs = pollIntervalSeconds * 1000

    logger.info(
      { pollIntervalSeconds },
      'GoogleDrivePollingWorker: starting background polling worker'
    )

    pollIntervalTimer = setInterval(() => {
      GoogleDrivePollingWorker.pollAllUsers().catch(err => {
        logger.error(
          { err },
          'GoogleDrivePollingWorker: error during interval execution'
        )
      })
    }, intervalMs)
    pollIntervalTimer.unref()
  },

  /**
   * Stops the recurring background polling timer.
   */
  stop() {
    if (pollIntervalTimer) {
      clearInterval(pollIntervalTimer)
      pollIntervalTimer = null
      logger.info('GoogleDrivePollingWorker: stopped background polling worker')
    }
  },
}

export default GoogleDrivePollingWorker
export { GoogleDrivePollingWorker }
