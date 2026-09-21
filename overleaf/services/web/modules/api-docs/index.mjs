import './app/src/ModuleSettings.mjs'
import Settings from '@overleaf/settings'
import ApiDocsRouter from './app/src/ApiDocsRouter.mjs'

function isEnabled() {
  return Boolean(Settings.enableApiDocs)
}

const ApiDocsModule = {
  name: 'api-docs',
  router: {
    apply(webRouter, privateApiRouter, publicApiRouter) {
      if (!isEnabled()) return
      ApiDocsRouter.apply(webRouter)
    },
  },
}

export default ApiDocsModule
