import logger from '@overleaf/logger'
import { db, waitForDb } from '../../../../../app/src/infrastructure/mongodb.mjs'

// MCP grants live until 90 days past their last refresh (refreshTokenExpiresAt).
// Only MCP grants carry that field, so this touches no other OAuth record.
const IDLE_EXPIRY_INDEX = {
  key: { refreshTokenExpiresAt: 1 },
  name: 'refreshTokenExpiresAt_1',
  partialFilterExpression: { refreshTokenExpiresAt: { $exists: true } },
  expireAfterSeconds: 0,
}

/**
 * Lets Mongo remove idle grants, and clears accessTokenExpiresAt from grants
 * written before it was dropped: upstream's TTL on that field would delete
 * them, refresh token included, a day after their first access token expired.
 * Both steps are no-ops once done. Only the enabled module calls this.
 */
export async function ensureGrantExpiry() {
  await waitForDb()
  const { key, ...options } = IDLE_EXPIRY_INDEX
  try {
    await db.oauthAccessTokens.createIndex(key, options)
  } catch (err) {
    logger.error({ err }, '[MCP] grant idle expiry index not created')
  }
  await db.oauthAccessTokens.updateMany(
    {
      refreshTokenExpiresAt: { $exists: true },
      accessTokenExpiresAt: { $exists: true },
    },
    { $unset: { accessTokenExpiresAt: '' } }
  )
}

export default { ensureGrantExpiry }
