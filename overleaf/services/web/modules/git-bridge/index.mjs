import './app/src/ModuleSettings.mjs'
import Settings from '@overleaf/settings'
import GitBridgeRouter from './app/src/GitBridgeRouter.mjs'

/**
 * @import { WebModule } from "../../types/web-module"
 */

function isEnabled() {
  return Boolean(Settings.enableGitBridge)
}

/** @type {WebModule} */
const GitBridgeModule = {
  name: 'git-bridge',
  router: {
    apply(webRouter, privateApiRouter, publicApiRouter) {
      if (!isEnabled()) return
      GitBridgeRouter.apply(webRouter, privateApiRouter, publicApiRouter)
    },
  },
}

export default GitBridgeModule
