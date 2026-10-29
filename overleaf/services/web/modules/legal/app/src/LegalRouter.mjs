import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import LegalController from './LegalController.mjs'

// Upstream public/robots.txt, with only the legal page opened to crawlers so
// services such as Google's OAuth verification can read the privacy policy
const ROBOTS_TXT = 'User-agent: *\nAllow: /legal\nDisallow: /\n'

const LegalRouter = {
  // The app-level hook runs before the static middleware that serves
  // public/robots.txt
  applyAppMiddleware(app) {
    app.get('/robots.txt', (req, res) => {
      res.type('text/plain').send(ROBOTS_TXT)
    })
  },

  apply(webRouter) {
    // Public page, also reachable on private instances before login
    AuthenticationController.addEndpointToLoginWhitelist('/legal')
    webRouter.get('/legal', LegalController.renderPage)
  },
}

export default LegalRouter
