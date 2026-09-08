import AccessTokenEncryptor from '@overleaf/access-token-encryptor'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import { GithubSyncUserCredentials } from './models/GithubSyncModels.mjs'

// Same defensive pattern as CollaboratorsInviteHelper.mjs:32-42 —
// a missing GITHUB_TOKEN_SECRET must not crash boot.
let accessTokenEncryptor
try {
  accessTokenEncryptor = new AccessTokenEncryptor(
    Settings.githubSyncEncryptorOptions
  )
} catch (error) {
  logger.error(
    { err: error },
    'Failed to initialise GitHub sync token encryption. Please ensure GITHUB_TOKEN_SECRET is set.'
  )
}

function _requireEncryptor() {
  if (!accessTokenEncryptor) {
    throw new Error(
      'GitHub token encryption not configured; set GITHUB_TOKEN_SECRET'
    )
  }
}

async function encryptAccessToken(payload) {
  _requireEncryptor()
  return accessTokenEncryptor.promises.encryptJson(payload)
}

async function decryptAccessToken(encrypted) {
  _requireEncryptor()
  return accessTokenEncryptor.promises.decryptToJson(encrypted)
}

async function storeCredentials(
  userId,
  { githubUserId, githubUsername, email, accessToken, scope }
) {
  const encryptedAccessToken = await encryptAccessToken({ accessToken })
  return GithubSyncUserCredentials.findOneAndUpdate(
    { user_id: userId },
    {
      $set: {
        user_id: userId,
        githubUserId,
        githubUsername,
        email,
        encryptedAccessToken,
        scope,
        lastUsedAt: new Date(),
      },
    },
    { upsert: true, new: true }
  )
}

async function getCredentials(userId) {
  return GithubSyncUserCredentials.findOne({ user_id: userId })
}

async function getAccessToken(userId) {
  const doc = await getCredentials(userId)
  if (!doc || !doc.encryptedAccessToken) {
    throw new Error('GitHub account not linked')
  }
  const { accessToken } = await decryptAccessToken(doc.encryptedAccessToken)
  return accessToken
}

async function deleteCredentials(userId) {
  await GithubSyncUserCredentials.deleteOne({ user_id: userId })
}

async function touch(userId) {
  await GithubSyncUserCredentials.updateOne(
    { user_id: userId },
    { $set: { lastUsedAt: new Date() } }
  )
}

const GitHubCredentialsManager = {
  promises: {
    encryptAccessToken,
    decryptAccessToken,
    storeCredentials,
    getCredentials,
    getAccessToken,
    deleteCredentials,
    touch,
  },
}

export default GitHubCredentialsManager
