import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import McpRouter from './app/src/McpRouter.mjs'
import OAuth2Router from './app/src/OAuth2/OAuth2Router.mjs'
import { applyMcpRequestGuard } from './app/src/McpRequestGuard.mjs'

/**
 * @import { WebModule } from "../../types/web-module"
 */

function isEnabled() {
  return Boolean(Settings.enableMcp)
}

/** @type {WebModule} */
const McpModule = {
  name: 'mcp',
  // Runs before the app's body parsers, so MCP requests are authenticated
  // before any large body is read (see McpRequestGuard.mjs).
  appMiddleware(app) {
    if (!isEnabled()) return
    applyMcpRequestGuard(app)
  },
  router: {
    apply(webRouter, privateApiRouter, publicApiRouter) {
      if (!isEnabled()) return
      McpRouter.apply(webRouter, privateApiRouter, publicApiRouter)
      OAuth2Router.apply(webRouter, privateApiRouter, publicApiRouter)
    },
  },
  // Invoked by app.mjs via Modules.start() at boot
  async start() {
    if (!isEnabled()) return
    // Never throws: Modules.start() skips every later module on an error
    try {
      const { ensureGrantExpiry } = await import(
        './app/src/OAuth2/OAuth2GrantExpiry.mjs'
      )
      await ensureGrantExpiry()
    } catch (err) {
      logger.error({ err }, '[MCP] grant expiry setup failed')
    }
  },
  hooks: {
    promises: {
      // Fired by UserDeleter when an account is deleted and again when it
      // expires; revoking twice is a no-op
      async deleteUser(userId) {
        if (!isEnabled()) return
        const { revokeUserGrants } = await import(
          './app/src/OAuth2/OAuth2UserCleanup.mjs'
        )
        await revokeUserGrants(userId)
      },
      async expireDeletedUser(userId) {
        if (!isEnabled()) return
        const { revokeUserGrants } = await import(
          './app/src/OAuth2/OAuth2UserCleanup.mjs'
        )
        await revokeUserGrants(userId)
      },
    },
  },
}

export default McpModule
