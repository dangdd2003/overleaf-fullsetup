import crypto from 'node:crypto'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import OError from '@overleaf/o-error'
import { fetchJson, fetchNothing } from '@overleaf/fetch-utils'
import { db, ObjectId } from '../../infrastructure/mongodb.mjs'
import GoogleDriveWatchManager from './GoogleDriveWatchManager.mjs'

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo'
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ')

const REFRESH_BUFFER_MS = 5 * 60 * 1000 // 5 minutes
const STATE_MAX_AGE_MS = 15 * 60 * 1000 // 15 minutes

/**
 * Derives a 32-byte key for AES-256-GCM from the sessionSecret or provided secret.
 *
 * @param {string} [customSecret]
 * @returns {Buffer} 32-byte Buffer
 */
function _getSecretKey(customSecret) {
  const secret = customSecret || Settings.security?.sessionSecret
  if (!secret) {
    throw new OError(
      'Google Drive token encryption unavailable: no security.sessionSecret configured'
    )
  }
  return crypto.createHash('sha256').update(secret).digest()
}

/**
 * Safely converts string / ObjectId to an ObjectId instance if valid.
 *
 * @param {string|ObjectId} id
 * @returns {ObjectId|string}
 */
function _toObjectId(id) {
  if (!id) return null
  if (typeof id === 'object' && id._bsontype === 'ObjectID') {
    return id
  }
  if (typeof id === 'string' && ObjectId?.isValid?.(id)) {
    try {
      return new ObjectId(id)
    } catch {
      return id
    }
  }
  return id
}

/**
 * Encrypts a plaintext string using AES-256-GCM with a random 12-byte IV and 16-byte auth tag.
 * Output format: `<ivHex>:<authTagHex>:<ciphertextHex>`
 *
 * @param {string} text Plaintext to encrypt
 * @param {string} [secret] Optional custom secret
 * @returns {string|null} Encrypted string or null if text is falsy
 */
function encryptToken(text, secret) {
  if (!text) return null
  const key = _getSecretKey(secret)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`
}

/**
 * Decrypts an AES-256-GCM encrypted token string formatted as `<ivHex>:<authTagHex>:<ciphertextHex>`.
 *
 * @param {string} encryptedText Encrypted string
 * @param {string} [secret] Optional custom secret
 * @returns {string|null} Decrypted UTF-8 string or null if encryptedText is falsy
 */
function decryptToken(encryptedText, secret) {
  if (!encryptedText) return null

  const parts = encryptedText.split(':')
  if (parts.length !== 3) {
    throw new OError(
      'Invalid encrypted token format: expected iv:authTag:ciphertext'
    )
  }

  const [ivHex, authTagHex, encryptedHex] = parts
  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(authTagHex, 'hex')
  const encrypted = Buffer.from(encryptedHex, 'hex')

  if (iv.length !== 12 || authTag.length !== 16) {
    throw new OError('Invalid IV or auth tag length for AES-256-GCM')
  }

  const key = _getSecretKey(secret)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)

  try {
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ])
    return decrypted.toString('utf8')
  } catch (err) {
    throw new OError(
      'Failed to decrypt token: authentication tag verification failed',
      {
        cause: err,
      }
    )
  }
}

/**
 * Creates a signed CSRF state parameter for OAuth authorization.
 * Format: `<userId>:<timestamp>:<nonce>.<hmacSha256>`
 *
 * @param {string} userId
 * @param {string} [secret]
 * @param {number} [timestamp]
 * @returns {string} Signed state string
 */
function createOAuthState(userId, secret, timestamp = Date.now()) {
  const sec = secret || Settings.security?.sessionSecret
  if (!sec) {
    throw new OError(
      'OAuth state generation unavailable: no security.sessionSecret configured'
    )
  }
  const nonce = crypto.randomBytes(16).toString('hex')
  const payload = `${userId}:${timestamp}:${nonce}`
  const hmac = crypto.createHmac('sha256', sec).update(payload).digest('hex')
  return `${payload}.${hmac}`
}

/**
 * Validates a signed OAuth state parameter against a userId.
 *
 * @param {string} userId
 * @param {string} state
 * @param {number} [maxAgeMs]
 * @returns {boolean}
 */
function validateOAuthState(userId, state, maxAgeMs = STATE_MAX_AGE_MS) {
  const secret = Settings.security?.sessionSecret
  if (!secret || !state || typeof state !== 'string' || !userId) {
    return false
  }

  const dotIndex = state.lastIndexOf('.')
  if (dotIndex === -1) return false

  const payload = state.slice(0, dotIndex)
  const sig = state.slice(dotIndex + 1)

  const parts = payload.split(':')
  if (parts.length !== 3) return false

  const [stateUserId, timestampStr] = parts
  if (stateUserId !== String(userId)) return false

  const timestamp = Number(timestampStr)
  const now = Date.now()
  if (
    !Number.isFinite(timestamp) ||
    now - timestamp > maxAgeMs ||
    timestamp > now + 60000
  ) {
    return false
  }

  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex')

  const sigBuf = Buffer.from(sig, 'hex')
  const expectedBuf = Buffer.from(expectedSig, 'hex')
  if (sigBuf.length !== expectedBuf.length) return false

  return crypto.timingSafeEqual(sigBuf, expectedBuf)
}

/**
 * Builds the Google OAuth2 authorization consent URL.
 *
 * @param {string} userId
 * @returns {{ url: string, state: string }}
 */
function getAuthorizationUrl(userId) {
  const clientId = Settings.googleDrive?.clientId
  if (!clientId) {
    throw new OError(
      'Google Drive OAuth unavailable: clientId is not configured in Settings.googleDrive'
    )
  }

  const state = createOAuthState(userId)
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: Settings.googleDrive?.redirectUri || '',
    response_type: 'code',
    scope: DEFAULT_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state,
  })

  return {
    url: `${GOOGLE_AUTH_URL}?${params.toString()}`,
    state,
  }
}

/**
 * Handles OAuth callback by validating state, exchanging auth code for tokens,
 * fetching user info, encrypting tokens, and saving credentials in MongoDB.
 *
 * @param {string} userId
 * @param {string} code
 * @param {string} state
 * @returns {Promise<{ googleEmail: string, googleUserId: string }>}
 */
async function handleOAuthCallback(userId, code, state) {
  if (!validateOAuthState(userId, state)) {
    throw new OError('Invalid or expired OAuth state')
  }

  if (!code) {
    throw new OError('Missing OAuth authorization code')
  }

  const clientId = Settings.googleDrive?.clientId
  const clientSecret = Settings.googleDrive?.clientSecret
  const redirectUri = Settings.googleDrive?.redirectUri

  if (!clientId || !clientSecret) {
    throw new OError(
      'Google Drive credentials missing in settings (clientId or clientSecret)'
    )
  }

  const tokenParams = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  })

  const tokenData = await fetchJson(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenParams.toString(),
  })

  const userInfo = await fetchJson(GOOGLE_USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
    },
  })

  const encryptedAccessToken = encryptToken(tokenData.access_token)
  let encryptedRefreshToken = tokenData.refresh_token
    ? encryptToken(tokenData.refresh_token)
    : null

  const userObjectId = _toObjectId(userId)

  // If refresh_token was omitted (e.g. re-auth without prompt), retain existing refresh token
  if (!encryptedRefreshToken) {
    const existing = await db.googleDriveUserCredentials.findOne({
      user_id: userObjectId,
    })
    if (existing?.encryptedRefreshToken) {
      encryptedRefreshToken = existing.encryptedRefreshToken
    }
  }

  const expiresIn = tokenData.expires_in || 3600
  const tokenExpiry = new Date(Date.now() + expiresIn * 1000)

  const updateDoc = {
    $set: {
      user_id: userObjectId,
      googleEmail: userInfo.email,
      googleUserId: userInfo.id,
      encryptedAccessToken,
      tokenExpiry,
      updatedAt: new Date(),
    },
    $setOnInsert: {
      linkedAt: new Date(),
    },
  }

  if (encryptedRefreshToken) {
    updateDoc.$set.encryptedRefreshToken = encryptedRefreshToken
  }

  await db.googleDriveUserCredentials.updateOne(
    { user_id: userObjectId },
    updateDoc,
    { upsert: true }
  )

  logger.info(
    { userId, googleEmail: userInfo.email },
    'Linked Google Drive account'
  )

  // Best-effort channel creation
  try {
    await GoogleDriveWatchManager.ensureChannel(userId)
  } catch (chanErr) {
    logger.warn(
      { err: chanErr, userId },
      'failed to establish initial push notification channel during link'
    )
  }

  return {
    googleEmail: userInfo.email,
    googleUserId: userInfo.id,
  }
}

/**
 * Retrieves a valid, decrypted access token for a user, automatically refreshing
 * the token if it is expired or expiring within 5 minutes.
 *
 * @param {string} userId
 * @returns {Promise<string>} Decrypted access token
 */
async function getValidAccessToken(userId) {
  const userObjectId = _toObjectId(userId)
  const creds = await db.googleDriveUserCredentials.findOne({
    user_id: userObjectId,
  })

  if (!creds || !creds.encryptedAccessToken) {
    throw new OError('Google Drive account not linked for user', { userId })
  }

  const now = Date.now()
  const expiryTime = creds.tokenExpiry
    ? new Date(creds.tokenExpiry).getTime()
    : 0
  const isExpiring = !creds.tokenExpiry || expiryTime - now < REFRESH_BUFFER_MS

  if (!isExpiring) {
    return decryptToken(creds.encryptedAccessToken)
  }

  // Token is expired or expiring soon; refresh it
  if (!creds.encryptedRefreshToken) {
    throw new OError(
      'No refresh token available to refresh Google Drive access token',
      { userId }
    )
  }

  const refreshToken = decryptToken(creds.encryptedRefreshToken)
  const clientId = Settings.googleDrive?.clientId
  const clientSecret = Settings.googleDrive?.clientSecret

  const refreshParams = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })

  const refreshData = await fetchJson(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: refreshParams.toString(),
  })

  const newEncryptedAccessToken = encryptToken(refreshData.access_token)
  const expiresIn = refreshData.expires_in || 3600
  const newTokenExpiry = new Date(Date.now() + expiresIn * 1000)

  const update = {
    $set: {
      encryptedAccessToken: newEncryptedAccessToken,
      tokenExpiry: newTokenExpiry,
      updatedAt: new Date(),
    },
  }

  if (refreshData.refresh_token) {
    update.$set.encryptedRefreshToken = encryptToken(refreshData.refresh_token)
  }

  await db.googleDriveUserCredentials.updateOne(
    { user_id: userObjectId },
    update
  )

  return refreshData.access_token
}

/**
 * Unlinks a user's Google Drive account by revoking credentials and deleting
 * their record from the database.
 *
 * @param {string} userId
 * @returns {Promise<{ success: boolean }>}
 */
async function unlinkAccount(userId) {
  const userObjectId = _toObjectId(userId)
  const creds = await db.googleDriveUserCredentials.findOne({
    user_id: userObjectId,
  })

  if (creds) {
    let tokenToRevoke = null
    try {
      if (creds.encryptedAccessToken) {
        tokenToRevoke = decryptToken(creds.encryptedAccessToken)
      } else if (creds.encryptedRefreshToken) {
        tokenToRevoke = decryptToken(creds.encryptedRefreshToken)
      }
    } catch (err) {
      logger.warn(
        { err, userId },
        'Failed to decrypt token for revocation during unlink'
      )
    }

    if (tokenToRevoke) {
      try {
        const revokeUrl = `${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(tokenToRevoke)}`
        await fetchNothing(revokeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        })
      } catch (err) {
        logger.warn(
          { err, userId },
          'Failed to revoke Google Drive OAuth token during unlink'
        )
      }
    }
  }

  try {
    await GoogleDriveWatchManager.stopChannel(userId)
  } catch (chanErr) {
    logger.warn(
      { err: chanErr, userId },
      'failed to stop push notification channel during unlink'
    )
  }

  await db.googleDriveUserCredentials.deleteOne({ user_id: userObjectId })
  logger.info({ userId }, 'Unlinked Google Drive account')

  return { success: true }
}

/**
 * Checks whether a user has linked their Google Drive account.
 *
 * @param {string} userId
 * @returns {Promise<{ isLinked: boolean, googleEmail?: string, googleUserId?: string, linkedAt?: Date }>}
 */
async function isLinked(userId) {
  const userObjectId = _toObjectId(userId)
  const creds = await db.googleDriveUserCredentials.findOne({
    user_id: userObjectId,
  })

  if (creds && creds.encryptedAccessToken) {
    return {
      isLinked: true,
      googleEmail: creds.googleEmail,
      googleUserId: creds.googleUserId,
      linkedAt: creds.linkedAt,
    }
  }

  return {
    isLinked: false,
  }
}

const GoogleDriveOAuthManager = {
  encryptToken,
  decryptToken,
  createOAuthState,
  validateOAuthState,
  getAuthorizationUrl,
  handleOAuthCallback,
  getValidAccessToken,
  unlinkAccount,
  isLinked,
}

export default GoogleDriveOAuthManager
export {
  encryptToken,
  decryptToken,
  createOAuthState,
  validateOAuthState,
  getAuthorizationUrl,
  handleOAuthCallback,
  getValidAccessToken,
  unlinkAccount,
  isLinked,
}
