import Settings from '@overleaf/settings'
import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import ApiDocsController from './ApiDocsController.mjs'

const ApiDocsRouter = {
  apply(webRouter) {
    if (!Settings.enableApiDocs) {
      return
    }
    webRouter.get(
      '/api-docs',
      AuthenticationController.requireLogin(),
      ApiDocsController.renderPage
    )
    webRouter.get(
      '/api/v0/openapi.json',
      AuthenticationController.requireLogin(),
      ApiDocsController.serveSpec
    )
  },
}

export default ApiDocsRouter
export { ApiDocsRouter }
