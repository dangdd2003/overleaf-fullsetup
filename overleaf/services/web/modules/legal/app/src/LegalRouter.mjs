import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import LegalController from './LegalController.mjs'

const LegalRouter = {
  apply(webRouter) {
    // Public page, also reachable on private instances before login
    AuthenticationController.addEndpointToLoginWhitelist('/legal')
    webRouter.get('/legal', LegalController.renderPage)
  },
}

export default LegalRouter
