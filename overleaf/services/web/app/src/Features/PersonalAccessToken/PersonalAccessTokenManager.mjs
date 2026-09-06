import crypto from 'node:crypto'
import { callbackify } from 'node:util'
import OError from '@overleaf/o-error'
import { PersonalAccessToken } from '../../models/PersonalAccessToken.mjs'
import UserGetter from '../User/UserGetter.mjs'

const ALLOWED_SCOPES = ['git_bridge', 'mcp']

// Only persist `lastUsedAt` when the stored value is missing or older than
// this, to avoid a DB write on every authenticated request.
const LAST_USED_THROTTLE_MS = 60 * 1000

/**
 * Creates a new personal access token for git operations.
 * Sets 1-year expiration.
 *
 * @param {string|object} userId
 * @param {string} [name='Git Token']
 * @param {string[]} [scopes=['git_bridge']]
 * @returns {Promise<{token: string, tokenPrefix: string, record: object}>}
 */
async function createToken(userId, name, scopes) {
  const finalScopes =
    Array.isArray(scopes) && scopes.length ? scopes : ['git_bridge']
  for (const s of finalScopes) {
    if (!ALLOWED_SCOPES.includes(s)) {
      throw new OError('invalid personal access token scope', { scope: s })
    }
  }

  const randomHex = crypto.randomBytes(16).toString('hex')
  const token = `olp_${randomHex}`
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
  const tokenPrefix = token.slice(0, 8)
  const now = new Date()
  const expiresAt = new Date(now)
  expiresAt.setFullYear(expiresAt.getFullYear() + 1)

  const record = await PersonalAccessToken.create({
    user_id: userId,
    name: name || 'Git Token',
    tokenHash,
    tokenPrefix,
    scopes: finalScopes,
    createdAt: now,
    expiresAt,
  })

  return {
    token,
    tokenPrefix,
    record,
  }
}

/**
 * Validates a raw personal access token.
 * Updates lastUsedAt on success and fetches user information.
 *
 * @param {string} rawToken
 * @returns {Promise<{userId: string, email: string, scopes: string[]}|null>}
 */
async function validateToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') {
    return null
  }

  const token = rawToken.trim()
  if (!token) {
    return null
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
  const record = await PersonalAccessToken.findOne({ tokenHash })
  if (!record) {
    return null
  }

  if (record.expiresAt && new Date(record.expiresAt).getTime() < Date.now()) {
    return null
  }

  const stale =
    !record.lastUsedAt ||
    Date.now() - new Date(record.lastUsedAt).getTime() > LAST_USED_THROTTLE_MS
  if (stale) {
    const now = new Date()
    record.lastUsedAt = now
    if (typeof record.save === 'function') {
      await record.save()
    } else {
      await PersonalAccessToken.updateOne(
        { _id: record._id },
        { $set: { lastUsedAt: now } }
      )
    }
  }

  let user = null
  if (UserGetter.promises?.getUser) {
    user = await UserGetter.promises.getUser(record.user_id, {
      email: 1,
      emails: 1,
    })
  } else if (typeof UserGetter.getUser === 'function') {
    user = await new Promise(resolve => {
      UserGetter.getUser(record.user_id, { email: 1, emails: 1 }, (err, u) =>
        resolve(u)
      )
    })
  }
  if (!user) {
    return null
  }

  const scopes = Array.isArray(record.scopes)
    ? record.scopes
    : record.scopes
      ? [record.scopes]
      : ['git_bridge']

  return {
    userId: record.user_id ? record.user_id.toString() : null,
    email: user.email,
    scopes,
  }
}

/**
 * Lists all token records for a user (excluding tokenHash), sorted by createdAt descending.
 *
 * @param {string|object} userId
 * @returns {Promise<Array<object>>}
 */
async function listTokens(userId) {
  const query = PersonalAccessToken.find(
    { user_id: userId },
    { tokenHash: 0 }
  ).sort({ createdAt: -1 })

  if (query && typeof query.exec === 'function') {
    return await query.exec()
  }
  return await query
}

/**
 * Revokes a personal access token by id for a specific user.
 *
 * @param {string|object} userId
 * @param {string|object} tokenId
 * @returns {Promise<object>}
 */
async function revokeToken(userId, tokenId) {
  return await PersonalAccessToken.deleteOne({
    _id: tokenId,
    user_id: userId,
  })
}

const PersonalAccessTokenManager = {
  createToken,
  validateToken,
  listTokens,
  revokeToken,
}

PersonalAccessTokenManager.promises = PersonalAccessTokenManager

PersonalAccessTokenManager.callbacks = {
  createToken: callbackify(createToken),
  validateToken: callbackify(validateToken),
  listTokens: callbackify(listTokens),
  revokeToken: callbackify(revokeToken),
}

export default PersonalAccessTokenManager
export {
  createToken,
  validateToken,
  listTokens,
  revokeToken,
  PersonalAccessTokenManager,
  ALLOWED_SCOPES,
  LAST_USED_THROTTLE_MS,
}
