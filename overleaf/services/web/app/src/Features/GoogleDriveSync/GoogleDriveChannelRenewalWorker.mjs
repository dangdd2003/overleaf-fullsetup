import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import Features from '../../infrastructure/Features.mjs'
import { db } from '../../infrastructure/mongodb.mjs'
import GoogleDriveWatchManager from './GoogleDriveWatchManager.mjs'

let renewTimer = null
let isRenewing = false

const GoogleDriveChannelRenewalWorker = {
  /**
   * Scans all linked Google Drive users and renews watch channels expiring soon.
   */
  async renewAllChannels() {
    if (!Features.hasFeature('google-drive-sync')) {
      return
    }

    const webhookUrl = Settings.googleDrive?.webhookUrl
    if (!webhookUrl) {
      return
    }

    if (isRenewing) {
      logger.debug(
        'GoogleDriveChannelRenewalWorker: renewal already in progress, skipping cycle'
      )
      return
    }

    isRenewing = true
    try {
      const cursor = db.googleDriveUserCredentials.find(
        {},
        { projection: { user_id: 1 } }
      )
      for await (const creds of cursor) {
        try {
          await GoogleDriveWatchManager.ensureChannel(creds.user_id)
        } catch (err) {
          logger.error(
            { err, userId: creds.user_id },
            'GoogleDriveChannelRenewalWorker: error renewing channel for user'
          )
        }
      }
    } catch (err) {
      logger.error(
        { err },
        'GoogleDriveChannelRenewalWorker: unexpected error during renewAllChannels'
      )
    } finally {
      isRenewing = false
    }
  },

  /**
   * Starts the recurring background channel renewal timer.
   */
  start() {
    if (renewTimer) {
      return
    }

    if (!Features.hasFeature('google-drive-sync')) {
      return
    }

    const webhookUrl = Settings.googleDrive?.webhookUrl
    if (!webhookUrl) {
      return
    }

    const intervalSeconds =
      Settings.googleDrive?.channelRenewIntervalSeconds || 3600

    logger.info(
      { intervalSeconds },
      'GoogleDriveChannelRenewalWorker: starting background channel renewal worker'
    )

    // Run once at start to verify/establish channels
    GoogleDriveChannelRenewalWorker.renewAllChannels().catch(err => {
      logger.error(
        { err },
        'GoogleDriveChannelRenewalWorker: error during initial renewal run'
      )
    })

    renewTimer = setInterval(() => {
      GoogleDriveChannelRenewalWorker.renewAllChannels().catch(err => {
        logger.error(
          { err },
          'GoogleDriveChannelRenewalWorker: error during interval renewal execution'
        )
      })
    }, intervalSeconds * 1000)
    renewTimer.unref()
  },

  /**
   * Stops the recurring background channel renewal timer.
   */
  stop() {
    if (renewTimer) {
      clearInterval(renewTimer)
      renewTimer = null
      logger.info(
        'GoogleDriveChannelRenewalWorker: stopped background channel renewal worker'
      )
    }
  },
}

export default GoogleDriveChannelRenewalWorker
export { GoogleDriveChannelRenewalWorker }
