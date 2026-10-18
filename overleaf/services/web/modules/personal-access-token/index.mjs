import Settings from '@overleaf/settings'
import PersonalAccessTokenRouter from './app/src/PersonalAccessTokenRouter.mjs'

/**
 * @import { WebModule } from "../../types/web-module"
 */

function isEnabled() {
  // Tokens exist for the features that accept them
  return Boolean(Settings.enableGitBridge || Settings.enableMcp)
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
  hooks: {
    promises: {
      async listPersonalAccessTokens(userId) {
        if (!isEnabled()) return []
        const { default: PersonalAccessTokenManager } = await import(
          '../../../../app/src/Features/PersonalAccessToken/PersonalAccessTokenManager.mjs'
        )
        return PersonalAccessTokenManager.listTokens(userId)
      },
      async cleanupPersonalAccessTokens(userId) {
        if (!isEnabled()) return
        const { PersonalAccessToken } = await import(
          '../../../../app/src/models/PersonalAccessToken.mjs'
        )
        await PersonalAccessToken.deleteMany({ user_id: userId })
      },
    },
  },
}

export default PersonalAccessTokenModule
