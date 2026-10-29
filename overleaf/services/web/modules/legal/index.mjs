import './app/src/ModuleSettings.mjs'
import Settings from '@overleaf/settings'
import LegalRouter from './app/src/LegalRouter.mjs'

function isEnabled() {
  return Boolean(Settings.enableLegalPage)
}

const LegalModule = {
  name: 'legal',
  appMiddleware(app) {
    if (!isEnabled()) return
    LegalRouter.applyAppMiddleware(app)
  },
  router: {
    apply(webRouter, privateApiRouter, publicApiRouter) {
      if (!isEnabled()) return
      LegalRouter.apply(webRouter)
    },
  },
}

export default LegalModule
