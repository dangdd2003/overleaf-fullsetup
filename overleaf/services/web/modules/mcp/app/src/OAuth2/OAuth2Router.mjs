import Settings from '@overleaf/settings'
import OAuth2MetadataController from './OAuth2MetadataController.mjs'
import OAuth2RegistrationController from './OAuth2RegistrationController.mjs'
import OAuth2AuthorizeController from './OAuth2AuthorizeController.mjs'
import OAuth2TokenController from './OAuth2TokenController.mjs'
import OAuth2RevocationController from './OAuth2RevocationController.mjs'
import SessionManager from '../../../../../app/src/Features/Authentication/SessionManager.mjs'
import { RateLimiter } from '../../../../../app/src/infrastructure/RateLimiter.mjs'
import RateLimiterMiddleware from '../../../../../app/src/Features/Security/RateLimiterMiddleware.mjs'

const OAuth2Router = {
  apply(webRouter, privateApiRouter, publicApiRouter) {
    // The OAuth2 authorization server exists solely to authenticate MCP clients.
    if (!Settings.enableMcp) {
      return
    }

    // Limiters are created here, not at import, so a deployment with MCP
    // disabled never constructs them.
    const rateLimiters = {
      register: new RateLimiter('oauth2-register-ip', {
        points: 10,
        duration: 60,
      }),
      token: new RateLimiter('oauth2-token-ip', {
        points: 30,
        duration: 60,
      }),
      revoke: new RateLimiter('oauth2-revoke-ip', {
        points: 60,
        duration: 60,
      }),
      authorizeIp: new RateLimiter('oauth2-authorize-ip', {
        points: 60,
        duration: 60,
      }),
      authorizeUser: new RateLimiter('oauth2-authorize-user', {
        points: 30,
        duration: 60,
      }),
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
      RateLimiterMiddleware.rateLimit(rateLimiters.register, { ipOnly: true }),
      OAuth2RegistrationController.register
    )

    // Token Endpoint (cookieless, Bearer/Basic/Body authentication)
    publicApiRouter.post(
      '/oauth/token',
      RateLimiterMiddleware.rateLimit(rateLimiters.token, { ipOnly: true }),
      OAuth2TokenController.token
    )

    // Token Revocation (RFC 7009, cookieless, token possession is the credential)
    publicApiRouter.post(
      '/oauth/revoke',
      RateLimiterMiddleware.rateLimit(rateLimiters.revoke, { ipOnly: true }),
      OAuth2RevocationController.revoke
    )

    // Authorization & Consent (Session-authenticated on webRouter). Limited per
    // IP for anonymous traffic, and per signed-in user where a session exists.
    const authorizeRateLimits = [
      RateLimiterMiddleware.rateLimit(rateLimiters.authorizeIp, {
        ipOnly: true,
      }),
      RateLimiterMiddleware.rateLimit(rateLimiters.authorizeUser, {
        getUserId: req => SessionManager.getLoggedInUserId(req.session),
      }),
    ]
    webRouter.get(
      '/oauth/authorize',
      ...authorizeRateLimits,
      OAuth2AuthorizeController.showAuthorizePage
    )
    webRouter.post(
      '/oauth/authorize',
      ...authorizeRateLimits,
      OAuth2AuthorizeController.handleAuthorize
    )
  },
}

export default OAuth2Router
export { OAuth2Router }
