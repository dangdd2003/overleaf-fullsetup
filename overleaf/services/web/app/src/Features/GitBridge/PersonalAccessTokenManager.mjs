import crypto from 'node:crypto'
import { callbackify } from 'node:util'
import { PersonalAccessToken } from '../../models/PersonalAccessToken.mjs'
import UserGetter from '../User/UserGetter.mjs'

/**
 * Creates a new personal access token for git operations.
 * Sets 1-year expiration.
 *
 * @param {string|object} userId
 * @param {string} [name='Git Token']
 * @returns {Promise<{token: string, tokenPrefix: string, record: object}>}
 */
async function createToken(userId, name) {
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
    scopes: ['git_bridge'],
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
 * @returns {Promise<{user_id: string, email: string, scope: string}|null>}
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

  const scope = Array.isArray(record.scopes)
    ? record.scopes.join(' ')
    : record.scopes || 'git_bridge'

  return {
    user_id: record.user_id ? record.user_id.toString() : null,
    email: user.email,
    scope,
  }
}

/**
 * Lists all active token records for a user (excluding tokenHash), sorted by createdAt descending.
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
}
