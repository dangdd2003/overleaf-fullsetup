import logger from '@overleaf/logger'
import {
  getCollectionInternal,
  waitForDb,
} from '../../../../app/src/infrastructure/mongodb.mjs'

// Core turns Mongoose's autoIndex off, and upstream only creates githubSync
// indexes on saas, so this creates them from the module's startup while the
// feature is on. The names differ from upstream's saas ones (`user_id_1`,
// `project_id_1`, both non-unique) so the two can never collide.
const GITHUB_SYNC_INDEXES = {
  githubSyncUserCredentials: [
    // One linked GitHub account per user
    { unique: true, key: { user_id: 1 }, name: 'user_id_1_unique' },
  ],
  githubSyncProjectStates: [
    // One link per project; also serves every lock and status lookup
    { unique: true, key: { project_id: 1 }, name: 'project_id_1_unique' },
    // unlinkAllForUser, on unlink and on account deletion
    { key: { user_id: 1 }, name: 'user_id_1_states' },
  ],
}

/**
 * Creates each index on its own, so one that cannot be built (a unique index
 * over existing duplicates) is logged and does not keep the rest from being
 * created. Creating an index that exists is a no-op.
 */
export async function ensureGithubSyncIndexes() {
  await waitForDb()
  for (const [collectionName, indexes] of Object.entries(GITHUB_SYNC_INDEXES)) {
    const collection = await getCollectionInternal(collectionName)
    for (const { key, ...options } of indexes) {
      try {
        await collection.createIndex(key, options)
      } catch (err) {
        logger.error(
          { err, collectionName, index: options.name },
          '[GitHubSync] index not created'
        )
      }
    }
  }
}

export default { ensureGithubSyncIndexes }
