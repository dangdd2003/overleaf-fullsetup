import './app/src/ModuleSettings.mjs'
import Settings from '@overleaf/settings'
import GitHubOAuthRouter from './app/src/GitHubOAuthRouter.mjs'
import GitHubSyncRouter from './app/src/GitHubSyncRouter.mjs'

/**
 * @import { WebModule } from "../../types/web-module"
 */

// The module is always present in moduleImportSequence so that its frontend
// slot registrations resolve at webpack build time. Everything it does at
// runtime is gated here, so an instance with GITHUB_SYNC_ENABLED unset behaves
// exactly like upstream Overleaf CE: no routes, no hooks, no database work.
function isEnabled() {
  return Boolean(Settings.enableGithubSync)
}

/** @type {WebModule} */
const GithubSyncModule = {
  name: 'github-sync',
  router: {
    // Modules.mjs awaits router.apply() but NOT router.applyNonCsrfRouter() —
    // both must stay synchronous (route registration only, no dynamic
    // import/await) or the non-CSRF routes can still be registering when the
    // server starts accepting requests.
    apply(webRouter, privateApiRouter, publicApiRouter) {
      if (!isEnabled()) return
      GitHubOAuthRouter.apply(webRouter)
      GitHubSyncRouter.apply(webRouter)
    },
    applyNonCsrfRouter(webRouter, privateApiRouter, publicApiRouter) {
      if (!isEnabled()) return
      GitHubOAuthRouter.applyNonCsrfRouter(webRouter)
    },
  },
  hooks: {
    // passportSetup fires synchronously with (passport, callback) — Server.mjs:225.
    // The callback MUST be invoked on every path, including the disabled one,
    // or boot blocks waiting for a strategy that will never register.
    async passportSetup(passport, callback) {
      if (!isEnabled()) return callback()
      try {
        const { createStrategy } = await import('./app/src/GitHubPassportStrategy.mjs')
        createStrategy(passport)
        callback()
      } catch (err) {
        callback(err)
      }
    },
    promises: {
      // projectModified fires with a single object payload — QueueWorkers.mjs:114
      projectModified: async ({ projectId }) => {
        if (!isEnabled()) return
        const { default: GitHubSyncManager } = await import('./app/src/GitHubSyncManager.mjs')
        await GitHubSyncManager.promises.markProjectModified(projectId)
      },
      removeGithub: async userId => {
        if (!isEnabled()) return
        const { default: GitHubSyncManager } = await import('./app/src/GitHubSyncManager.mjs')
        await GitHubSyncManager.promises.onUserRemoved(userId)
      },
      deleteUser: async userId => {
        if (!isEnabled()) return
        const { default: GitHubSyncManager } = await import('./app/src/GitHubSyncManager.mjs')
        await GitHubSyncManager.promises.onUserRemoved(userId)
      },
      expireDeletedUser: async userId => {
        if (!isEnabled()) return
        const { default: GitHubSyncManager } = await import('./app/src/GitHubSyncManager.mjs')
        await GitHubSyncManager.promises.onUserRemoved(userId)
      },
      deactivateProject: async projectId => {
        if (!isEnabled()) return
        const { default: GitHubSyncManager } = await import('./app/src/GitHubSyncManager.mjs')
        await GitHubSyncManager.promises.onProjectInactive(projectId)
      },
      projectExpired: async projectId => {
        if (!isEnabled()) return
        const { default: GitHubSyncManager } = await import('./app/src/GitHubSyncManager.mjs')
        await GitHubSyncManager.promises.onProjectInactive(projectId)
      },
    },
  },
}

export default GithubSyncModule
