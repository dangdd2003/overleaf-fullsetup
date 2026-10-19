import logger from '@overleaf/logger'
import {
  getCollectionInternal,
  waitForDb,
} from '../../../../app/src/infrastructure/mongodb.mjs'

// Core turns Mongoose's autoIndex off, so the declarations in
// PersonalAccessToken.mjs are never built. The personal-access-token module
// creates these from its startup while tokens are in use.
const PERSONAL_ACCESS_TOKEN_INDEXES = [
  // Every token-authenticated request looks its token up by hash
  { unique: true, key: { tokenHash: 1 }, name: 'tokenHash_1' },
  // Listing a user's tokens, and removing them when the user is deleted
  { key: { user_id: 1 }, name: 'user_id_1' },
]

/**
 * Creates each index on its own and logs any that fail. Creating an index that
 * exists is a no-op.
 */
export async function ensurePersonalAccessTokenIndexes() {
  await waitForDb()
  const collection = await getCollectionInternal('personalAccessTokens')
  for (const { key, ...options } of PERSONAL_ACCESS_TOKEN_INDEXES) {
    try {
      await collection.createIndex(key, options)
    } catch (err) {
      logger.error(
        { err, index: options.name },
        '[PersonalAccessToken] index not created'
      )
    }
  }
}

export default { ensurePersonalAccessTokenIndexes }
