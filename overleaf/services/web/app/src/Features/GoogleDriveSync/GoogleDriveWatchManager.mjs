import crypto from 'node:crypto'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import { db, ObjectId } from '../../infrastructure/mongodb.mjs'
import GoogleDriveClient from './GoogleDriveClient.mjs'

const CHANNEL_RENEW_THRESHOLD_MS = 24 * 60 * 60 * 1000 // 24 hours

function _toObjectId(id) {
  if (!id) return null
  if (typeof id === 'object' && id._bsontype === 'ObjectID') return id
  if (typeof id === 'string' && ObjectId?.isValid?.(id)) {
    try {
      return new ObjectId(id)
    } catch {
      return id
    }
  }
  return id
}

function _getWebhookSecret() {
  return (
    Settings.googleDrive?.webhookSecret ||
    Settings.security?.sessionSecret ||
    Settings.encryption?.userOAuthTokensSecret ||
    'overleaf-gdrive-webhook-default'
  )
}

const GoogleDriveWatchManager = {
  /**
   * Derives an HMAC-SHA256 token for validating inbound webhook notifications for a user.
   *
   * @param {string|ObjectId} userId
   * @returns {string}
   */
  deriveChannelToken(userId) {
    const secret = _getWebhookSecret()
    return crypto
      .createHmac('sha256', secret)
      .update(String(userId))
      .digest('hex')
  },

  /**
   * Ensures the user has an active Google Drive push notification watch channel.
   * Creates a new one if missing or expiring within 24h.
   *
   * @param {string|ObjectId} userId
   * @returns {Promise<{ success?: boolean, skipped?: string, reused?: boolean, channelId?: string }>}
   */
  async ensureChannel(userId) {
    const webhookUrl = Settings.googleDrive?.webhookUrl
    if (!webhookUrl) {
      return { skipped: 'no-webhook-url' }
    }

    const userObjectId = _toObjectId(userId)
    const creds = await db.googleDriveUserCredentials.findOne({
      user_id: userObjectId,
    })

    if (!creds) {
      return { skipped: 'unlinked' }
    }

    const now = Date.now()
    if (
      creds.watchChannelId &&
      creds.watchExpiresAt &&
      new Date(creds.watchExpiresAt).getTime() - now >
        CHANNEL_RENEW_THRESHOLD_MS
    ) {
      return { reused: true }
    }

    // If an existing channel exists, stop it before creating a new one
    if (creds.watchChannelId && creds.watchResourceId) {
      try {
        await GoogleDriveClient.stopChannel(
          userId,
          creds.watchChannelId,
          creds.watchResourceId
        )
      } catch (err) {
        logger.warn(
          { err, userId, channelId: creds.watchChannelId },
          'GoogleDriveWatchManager: failed to stop old watch channel during renewal (ignoring)'
        )
      }
    }

    let pageToken = creds.startPageToken
    if (!pageToken) {
      pageToken = await GoogleDriveClient.getStartPageToken(userId)
      await db.googleDriveUserCredentials.updateOne(
        { user_id: userObjectId },
        { $set: { startPageToken: pageToken } }
      )
    }

    const channelId = crypto.randomUUID()
    const channelToken = GoogleDriveWatchManager.deriveChannelToken(userId)

    const watchRes = await GoogleDriveClient.watchChanges(userId, pageToken, {
      id: channelId,
      type: 'web_hook',
      address: webhookUrl,
      token: channelToken,
    })

    const expiresAt = watchRes.expiration
      ? new Date(parseInt(watchRes.expiration, 10))
      : new Date(now + 7 * 24 * 60 * 60 * 1000)

    await db.googleDriveUserCredentials.updateOne(
      { user_id: userObjectId },
      {
        $set: {
          watchChannelId: channelId,
          watchResourceId: watchRes.resourceId,
          watchChannelToken: channelToken,
          watchExpiresAt: expiresAt,
          updatedAt: new Date(),
        },
      }
    )

    logger.info(
      { userId, channelId, resourceId: watchRes.resourceId, expiresAt },
      'GoogleDriveWatchManager: established new Google Drive watch channel'
    )

    return { success: true, channelId }
  },

  /**
   * Stops an active watch channel on Google Drive and unsets watch metadata.
   *
   * @param {string|ObjectId} userId
   * @returns {Promise<{ success?: boolean, skipped?: string }>}
   */
  async stopChannel(userId) {
    const userObjectId = _toObjectId(userId)
    const creds = await db.googleDriveUserCredentials.findOne({
      user_id: userObjectId,
    })

    if (!creds || !creds.watchChannelId || !creds.watchResourceId) {
      return { skipped: 'no-active-channel' }
    }

    try {
      await GoogleDriveClient.stopChannel(
        userId,
        creds.watchChannelId,
        creds.watchResourceId
      )
    } catch (err) {
      logger.warn(
        { err, userId, channelId: creds.watchChannelId },
        'GoogleDriveWatchManager: failed to stop channel with Drive API (proceeding with local cleanup)'
      )
    }

    await db.googleDriveUserCredentials.updateOne(
      { user_id: userObjectId },
      {
        $unset: {
          watchChannelId: '',
          watchResourceId: '',
          watchChannelToken: '',
          watchExpiresAt: '',
        },
      }
    )

    logger.info(
      { userId, channelId: creds.watchChannelId },
      'GoogleDriveWatchManager: stopped and removed watch channel'
    )

    return { success: true }
  },
}

export default GoogleDriveWatchManager
export { GoogleDriveWatchManager }
