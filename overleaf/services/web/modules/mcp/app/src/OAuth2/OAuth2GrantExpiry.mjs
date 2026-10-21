import logger from '@overleaf/logger'
import { db, waitForDb } from '../../../../../app/src/infrastructure/mongodb.mjs'

// The refresh_token grant finds the grant by its refreshToken on every refresh.
const REFRESH_TOKEN_INDEX = {
  key: { refreshToken: 1 },
  name: 'refreshToken_1',
}

// MCP grants live until 90 days past their last refresh (refreshTokenExpiresAt).
// Only MCP grants carry that field, so this touches no other OAuth record.
const IDLE_EXPIRY_INDEX = {
  key: { refreshTokenExpiresAt: 1 },
  name: 'refreshTokenExpiresAt_1',
  partialFilterExpression: { refreshTokenExpiresAt: { $exists: true } },
  expireAfterSeconds: 0,
}

// Finds the grant that superseded a refresh token, to detect its reuse.
const SUPERSEDED_HASH_INDEX = {
  key: { 'supersededRefreshTokens.hash': 1 },
  name: 'supersededRefreshTokens.hash_1',
  partialFilterExpression: {
    'supersededRefreshTokens.hash': { $exists: true },
  },
}

// Upstream declares no indexes on oauthAccessTokens, so the MCP module owns these.
export const GRANT_INDEXES = [
  REFRESH_TOKEN_INDEX,
  IDLE_EXPIRY_INDEX,
  SUPERSEDED_HASH_INDEX,
]

/**
 * Creates the grant indexes. Each is a no-op once it exists. Only the enabled
 * module calls this.
 */
export async function ensureGrantExpiry() {
  await waitForDb()
  for (const { key, ...options } of GRANT_INDEXES) {
    try {
      await db.oauthAccessTokens.createIndex(key, options)
    } catch (err) {
      logger.error(
        { err, index: options.name },
        '[MCP] grant index not created'
      )
    }
  }
  // Grants written before accessTokenExpiresAt was dropped would be deleted by
  // upstream's TTL on that field, refresh token included. Clear it once.
  await db.oauthAccessTokens.updateMany(
    {
      refreshTokenExpiresAt: { $exists: true },
      accessTokenExpiresAt: { $exists: true },
    },
    { $unset: { accessTokenExpiresAt: '' } }
  )
}
