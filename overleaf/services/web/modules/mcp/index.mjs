import './app/src/ModuleSettings.mjs'
import Settings from '@overleaf/settings'
import McpRouter from './app/src/McpRouter.mjs'
import OAuth2Router from './app/src/OAuth2/OAuth2Router.mjs'

/**
 * @import { WebModule } from "../../types/web-module"
 */

function isEnabled() {
  return Boolean(Settings.enableMcp)
}

/** @type {WebModule} */
const McpModule = {
  name: 'mcp',
  router: {
    apply(webRouter, privateApiRouter, publicApiRouter) {
      if (!isEnabled()) return
      McpRouter.apply(webRouter, privateApiRouter, publicApiRouter)
      OAuth2Router.apply(webRouter, privateApiRouter, publicApiRouter)
    },
  },
}

export default McpModule
