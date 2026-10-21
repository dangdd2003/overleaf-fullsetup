import Settings from '@overleaf/settings'
import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import RateLimiterMiddleware from '../../../../app/src/Features/Security/RateLimiterMiddleware.mjs'
import { RateLimiter } from '../../../../app/src/infrastructure/RateLimiter.mjs'
import PersonalAccessTokenController from './PersonalAccessTokenController.mjs'

// Per user. Creating tokens is rare, so this stays well below the token cap.
const CREATE_RATE_LIMIT = { points: 10, duration: 60 * 60 }

const PersonalAccessTokenRouter = {
  apply(webRouter) {
    if (!(Settings.enableGitBridge || Settings.enableMcp)) {
      return
    }
    // Created here, not at import, so nothing is set up unless the router is applied
    const createRateLimit = RateLimiterMiddleware.rateLimit(
      new RateLimiter('personal-access-token-create', CREATE_RATE_LIMIT)
    )
    webRouter.post(
      '/user/personal-access-tokens',
      AuthenticationController.requireLogin(),
      createRateLimit,
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
