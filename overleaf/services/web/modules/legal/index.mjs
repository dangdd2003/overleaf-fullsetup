import './app/src/ModuleSettings.mjs'
import Settings from '@overleaf/settings'
import LegalRouter from './app/src/LegalRouter.mjs'

function isEnabled() {
  return Boolean(Settings.enableLegalPage)
}

const LegalModule = {
  name: 'legal',
  router: {
    apply(webRouter, privateApiRouter, publicApiRouter) {
      if (!isEnabled()) return
      LegalRouter.apply(webRouter)
    },
  },
}

export default LegalModule
