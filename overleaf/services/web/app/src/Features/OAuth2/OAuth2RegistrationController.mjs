import crypto from 'node:crypto'
import { OauthApplication } from '../../models/OauthApplication.mjs'

const OAuth2RegistrationController = {
  async register(req, res) {
    const { client_name, redirect_uris, grant_types, scope } = req.body || {}
    if (!client_name || typeof client_name !== 'string') {
      return res.status(400).json({
        error: 'invalid_client_metadata',
        error_description: 'client_name is required',
      })
    }
    if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      return res.status(400).json({
        error: 'invalid_redirect_uri',
        error_description: 'redirect_uris array is required',
      })
    }

    for (const uri of redirect_uris) {
      try {
        const parsed = new URL(uri)
        const isHttps = parsed.protocol === 'https:'
        const isLoopback =
          parsed.protocol === 'http:' &&
          (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
        if ((!isHttps && !isLoopback) || parsed.username || parsed.password) {
          return res.status(400).json({
            error: 'invalid_redirect_uri',
            error_description:
              'redirect_uris must be valid HTTPS URLs or loopback HTTP URLs without userinfo',
          })
        }
      } catch {
        return res.status(400).json({
          error: 'invalid_redirect_uri',
          error_description: 'Invalid redirect_uri format',
        })
      }
    }

    const clientId = `client_${crypto.randomBytes(16).toString('hex')}`
    const grants = Array.isArray(grant_types)
      ? grant_types
      : ['authorization_code', 'refresh_token']
    const scopes = typeof scope === 'string' ? scope.split(' ') : ['mcp']

    await OauthApplication.create({
      id: clientId,
      name: client_name,
      redirectUris: redirect_uris,
      grants,
      scopes,
      pkceEnabled: true,
    })

    return res.status(201).json({
      client_id: clientId,
      client_name,
      redirect_uris,
      grant_types: grants,
      scope: scopes.join(' '),
      token_endpoint_auth_method: 'none',
    })
  },
}

export default OAuth2RegistrationController
