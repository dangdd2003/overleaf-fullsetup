import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import { RateLimiter } from '../../infrastructure/RateLimiter.mjs'
import OAuth2MetadataController from './OAuth2MetadataController.mjs'
import OAuth2RegistrationController from './OAuth2RegistrationController.mjs'
import OAuth2AuthorizeController from './OAuth2AuthorizeController.mjs'
import OAuth2TokenController from './OAuth2TokenController.mjs'

const oauthRateLimiter = new RateLimiter('oauth-public-api', {
  points: 60,
  duration: 60,
})

function oauthRateLimit(req, res, next) {
  oauthRateLimiter
    .consume(req.ip, 1, { method: 'ip' })
    .then(() => next())
    .catch(err => {
      if (err instanceof Error) {
        logger.warn({ err }, 'oauth rate limiter backend error')
        return next()
      }
      return res.status(429).json({
        error: 'slow_down',
        error_description: 'Too many requests, please try again later',
      })
    })
}

const OAuth2Router = {
  apply(webRouter, privateApiRouter, publicApiRouter) {
    // The OAuth2 authorization server exists solely to authenticate MCP clients.
    if (!Settings.enableMcp) {
      return
    }

    // Public discovery metadata
    for (const r of [publicApiRouter, webRouter]) {
      r.get(
        '/.well-known/oauth-authorization-server',
        OAuth2MetadataController.getAuthorizationServerMetadata
      )
      r.get(
        '/.well-known/openid-configuration',
        OAuth2MetadataController.getOpenIdConfiguration
      )
      r.get('/.well-known/jwks.json', OAuth2MetadataController.getJwks)
    }

    // Dynamic Client Registration (cookieless, public API)
    publicApiRouter.post(
      '/oauth/register',
      oauthRateLimit,
      OAuth2RegistrationController.register
    )

    // Token Endpoint (cookieless, Bearer/Basic/Body authentication)
    publicApiRouter.post(
      '/oauth/token',
      oauthRateLimit,
      OAuth2TokenController.token
    )

    // Authorization & Consent (Session-authenticated on webRouter)
    webRouter.get('/oauth/authorize', OAuth2AuthorizeController.showAuthorizePage)
    webRouter.post('/oauth/authorize', OAuth2AuthorizeController.handleAuthorize)
  },
}

export default OAuth2Router
export { OAuth2Router }
