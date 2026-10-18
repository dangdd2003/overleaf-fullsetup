import logger from '@overleaf/logger'
import {
  getCollectionInternal,
  waitForDb,
} from '../../../../app/src/infrastructure/mongodb.mjs'

// The connector collections' indexes. Core turns Mongoose's autoIndex off, so
// this creates them, from the module's startup, while the feature is on.
const CONNECTOR_INDEXES = {
  aiAssistConnectors: [
    { key: { user_id: 1, createdAt: 1 }, name: 'user_id_1_createdAt_1' },
  ],
  aiAssistConnectorCredentials: [
    // One credentials document per connector
    { unique: true, key: { connector_id: 1 }, name: 'connector_id_1' },
    { key: { user_id: 1 }, name: 'user_id_1' },
  ],
  aiAssistOAuthClients: [
    // One registered client per authorization server and callback URL,
    // shared by every user of the instance
    {
      unique: true,
      key: { issuer: 1, redirectUri: 1 },
      name: 'issuer_1_redirectUri_1',
    },
  ],
  aiAssistOAuthStates: [
    { unique: true, key: { stateHash: 1 }, name: 'stateHash_1' },
    // Sign-ins nobody finished are removed once they expire
    {
      key: { expiresAt: 1 },
      name: 'expiresAt_1',
      expireAfterSeconds: 0,
    },
  ],
  aiAssistUserSettings: [
    { unique: true, key: { user_id: 1 }, name: 'user_id_1' },
  ],
}

/**
 * Creates the connector indexes. Only the enabled feature calls this, so a
 * disabled instance creates nothing. Creating an index that exists is a no-op.
 */
export async function ensureAiAssistIndexes() {
  await waitForDb()
  for (const [collectionName, indexes] of Object.entries(CONNECTOR_INDEXES)) {
    const collection = await getCollectionInternal(collectionName)
    for (const { key, ...options } of indexes) {
      await collection.createIndex(key, { background: true, ...options })
    }
  }
  logger.debug({}, '[AiAssist] connector indexes in place')
}

export default { ensureAiAssistIndexes }
