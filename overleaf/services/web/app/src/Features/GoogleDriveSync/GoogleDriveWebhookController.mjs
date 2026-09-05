import crypto from 'node:crypto'
import logger from '@overleaf/logger'
import { db } from '../../infrastructure/mongodb.mjs'
import GoogleDriveSyncManager from './GoogleDriveSyncManager.mjs'

const activeTimers = new Map()
const inFlightPolls = new Set()
const pendingRePolls = new Set()

/**
 * Triggers a debounced changes poll for the user.
 *
 * @param {string} userIdStr
 * @param {number} [debounceMs=20]
 */
function _scheduleUserPoll(userIdStr, debounceMs = 20) {
  if (activeTimers.has(userIdStr)) {
    clearTimeout(activeTimers.get(userIdStr))
  }

  const timer = setTimeout(async () => {
    activeTimers.delete(userIdStr)

    if (inFlightPolls.has(userIdStr)) {
      pendingRePolls.add(userIdStr)
      return
    }

    inFlightPolls.add(userIdStr)
    try {
      await GoogleDriveSyncManager.pollUserChanges(userIdStr)
    } catch (err) {
      logger.error(
        { err, userId: userIdStr },
        'GoogleDriveWebhookController: error executing webhook-triggered poll'
      )
    } finally {
      inFlightPolls.delete(userIdStr)
      if (pendingRePolls.has(userIdStr)) {
        pendingRePolls.delete(userIdStr)
        _scheduleUserPoll(userIdStr, 0)
      }
    }
  }, debounceMs)

  if (typeof timer.unref === 'function') {
    timer.unref()
  }
  activeTimers.set(userIdStr, timer)
}

const GoogleDriveWebhookController = {
  /**
   * Handles inbound Google Drive push notification POST requests.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   */
  async handleWebhook(req, res) {
    const channelId = req.headers['x-goog-channel-id']
    const channelToken = req.headers['x-goog-channel-token']
    const resourceState = req.headers['x-goog-resource-state']

    if (!channelId || !channelToken) {
      return res.sendStatus(200)
    }

    let creds
    try {
      creds = await db.googleDriveUserCredentials.findOne({
        watchChannelId: channelId,
      })
    } catch (err) {
      logger.error(
        { err, channelId },
        'GoogleDriveWebhookController: db error resolving channel'
      )
      return res.sendStatus(200)
    }

    if (!creds || !creds.watchChannelToken) {
      return res.sendStatus(200)
    }

    const expectedBuf = Buffer.from(creds.watchChannelToken)
    const actualBuf = Buffer.from(channelToken)

    if (
      expectedBuf.length !== actualBuf.length ||
      !crypto.timingSafeEqual(expectedBuf, actualBuf)
    ) {
      logger.warn(
        { channelId, userId: creds.user_id },
        'GoogleDriveWebhookController: invalid channel token on webhook notification'
      )
      return res.sendStatus(200)
    }

    // Google sends 'sync' on channel creation as a handshake ping
    if (resourceState === 'sync') {
      logger.debug(
        { channelId, userId: creds.user_id },
        'GoogleDriveWebhookController: received channel sync handshake ping'
      )
      return res.sendStatus(200)
    }

    const userIdStr = creds.user_id.toString()
    _scheduleUserPoll(userIdStr, 20)

    return res.sendStatus(200)
  },
}

export default GoogleDriveWebhookController
export { GoogleDriveWebhookController }
