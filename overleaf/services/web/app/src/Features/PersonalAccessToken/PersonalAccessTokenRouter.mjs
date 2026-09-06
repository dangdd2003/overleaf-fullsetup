import Settings from '@overleaf/settings'
import AuthenticationController from '../Authentication/AuthenticationController.mjs'
import PersonalAccessTokenController from './PersonalAccessTokenController.mjs'

const PersonalAccessTokenRouter = {
  apply(webRouter) {
    if (!(Settings.enableGitBridge || Settings.enableMcp)) {
      return
    }
    webRouter.post(
      '/user/personal-access-tokens',
      AuthenticationController.requireLogin(),
      PersonalAccessTokenController.createToken
    )
    webRouter.get(
      '/user/personal-access-tokens',
      AuthenticationController.requireLogin(),
      PersonalAccessTokenController.listTokens
    )
    webRouter.delete(
      '/user/personal-access-tokens/:tokenId',
      AuthenticationController.requireLogin(),
      PersonalAccessTokenController.revokeToken
    )
  },
}

export default PersonalAccessTokenRouter
export { PersonalAccessTokenRouter }
