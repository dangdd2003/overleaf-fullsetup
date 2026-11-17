import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import PersonalAccessTokenRouter from './app/src/PersonalAccessTokenRouter.mjs'

/**
 * @import { WebModule } from "../../types/web-module"
 */

function isEnabled() {
  // Tokens exist for the features that accept them
  return Boolean(Settings.enableGitBridge || Settings.enableMcp)
}

async function deleteTokensForUser(userId) {
  const { PersonalAccessToken } = await import(
    '../../app/src/models/PersonalAccessToken.mjs'
  )
  await PersonalAccessToken.deleteMany({ user_id: userId })
}

/** @type {WebModule} */
const PersonalAccessTokenModule = {
  name: 'personal-access-token',
  router: {
    apply(webRouter) {
      if (!isEnabled()) return
      PersonalAccessTokenRouter.apply(webRouter)
    },
  },
  // Invoked by app.mjs via Modules.start() at boot
  async start() {
    if (!isEnabled()) return
    // Never throws: Modules.start() skips every later module on an error
    try {
      const { ensurePersonalAccessTokenIndexes } = await import(
        './app/src/PersonalAccessTokenIndexes.mjs'
      )
      await ensurePersonalAccessTokenIndexes()
    } catch (err) {
      logger.error({ err }, '[PersonalAccessToken] index setup failed')
    }
  },
  hooks: {
    promises: {
      async listPersonalAccessTokens(userId) {
        if (!isEnabled()) return []
        const { default: PersonalAccessTokenManager } = await import(
          '../../app/src/Features/PersonalAccessToken/PersonalAccessTokenManager.mjs'
        )
        return PersonalAccessTokenManager.listTokens(userId)
      },
      async cleanupPersonalAccessTokens(userId) {
        await deleteTokensForUser(userId)
      },
      async deleteUser(userId) {
        await deleteTokensForUser(userId)
      },
      async expireDeletedUser(userId) {
        await deleteTokensForUser(userId)
      },
    },
  },
}

export default PersonalAccessTokenModule
