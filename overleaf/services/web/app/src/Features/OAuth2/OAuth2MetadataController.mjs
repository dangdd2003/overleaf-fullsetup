import Settings from '@overleaf/settings'
import OAuth2KeyManager from './OAuth2KeyManager.mjs'

function getBaseUrl(req) {
  if (Settings.siteUrl) {
    return Settings.siteUrl.replace(/\/+$/, '')
  }
  const host = req?.get ? req.get('host') : req?.headers?.host
  if (host) {
    const protocol = req?.protocol || 'http'
    return `${protocol}://${host}`
  }
  const envUrl =
    process.env.PUBLIC_URL ||
    process.env.OVERLEAF_URL ||
    process.env.SITE_URL
  if (envUrl) {
    return envUrl.replace(/\/+$/, '')
  }
  return 'http://localhost:3000'
}

const OAuth2MetadataController = {
  async getAuthorizationServerMetadata(req, res) {
    const baseUrl = getBaseUrl(req)
    return res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      jwks_uri: `${baseUrl}/.well-known/jwks.json`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      scopes_supported: ['mcp'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: [
        'none',
        'client_secret_post',
        'client_secret_basic',
      ],
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
