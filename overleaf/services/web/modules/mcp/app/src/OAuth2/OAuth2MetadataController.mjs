import OAuth2KeyManager from './OAuth2KeyManager.mjs'
import { getBaseUrl } from './OAuth2Utils.mjs'

const OAuth2MetadataController = {
  async getAuthorizationServerMetadata(req, res) {
    const baseUrl = getBaseUrl(req)
    return res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      jwks_uri: `${baseUrl}/.well-known/jwks.json`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      revocation_endpoint: `${baseUrl}/oauth/revoke`,
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      // Clients are public: the token endpoint reads client_id from the body
      // and never checks a secret, so advertising secret methods would mislead
      // clients that then send credentials the server ignores.
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
    })
  },

  async getOpenIdConfiguration(req, res) {
    return OAuth2MetadataController.getAuthorizationServerMetadata(req, res)
  },

  async getJwks(req, res) {
    const jwks = await OAuth2KeyManager.getJwks()
    if (res.setHeader) {
      res.setHeader('Cache-Control', 'public, max-age=86400')
    }
    return res.json(jwks)
  },
}

export default OAuth2MetadataController
