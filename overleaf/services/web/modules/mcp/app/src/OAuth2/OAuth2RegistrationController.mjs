import crypto from 'node:crypto'
import { OauthApplication } from '../../../../../app/src/models/OauthApplication.mjs'
import { MCP_SCOPE, normalizeScope } from './OAuth2Utils.mjs'

// Registration is unauthenticated, so every field is bounded. The limits are
// well above what any real client sends.
const MAX_CLIENT_NAME_LENGTH = 200
const MAX_REDIRECT_URIS = 10
const MAX_REDIRECT_URI_LENGTH = 2048
const SUPPORTED_GRANT_TYPES = ['authorization_code', 'refresh_token']

const OAuth2RegistrationController = {
  async register(req, res) {
    const { client_name, redirect_uris, grant_types, scope } = req.body || {}
    if (!client_name || typeof client_name !== 'string') {
      return res.status(400).json({
        error: 'invalid_client_metadata',
        error_description: 'client_name is required',
      })
    }
    if (client_name.length > MAX_CLIENT_NAME_LENGTH) {
      return res.status(400).json({
        error: 'invalid_client_metadata',
        error_description: `client_name must be at most ${MAX_CLIENT_NAME_LENGTH} characters`,
      })
    }
    if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      return res.status(400).json({
        error: 'invalid_redirect_uri',
        error_description: 'redirect_uris array is required',
      })
    }
    if (redirect_uris.length > MAX_REDIRECT_URIS) {
      return res.status(400).json({
        error: 'invalid_redirect_uri',
        error_description: `redirect_uris may hold at most ${MAX_REDIRECT_URIS} entries`,
      })
    }
    if (
      grant_types !== undefined &&
      (!Array.isArray(grant_types) ||
        grant_types.some(grant => !SUPPORTED_GRANT_TYPES.includes(grant)))
    ) {
      return res.status(400).json({
        error: 'invalid_client_metadata',
        error_description: `grant_types must be a subset of ${SUPPORTED_GRANT_TYPES.join(', ')}`,
      })
    }
    if (scope !== undefined && normalizeScope(scope) !== MCP_SCOPE) {
      return res.status(400).json({
        error: 'invalid_client_metadata',
        error_description: 'Only scope=mcp is supported',
      })
    }

    for (const uri of redirect_uris) {
      if (typeof uri !== 'string' || uri.length > MAX_REDIRECT_URI_LENGTH) {
        return res.status(400).json({
          error: 'invalid_redirect_uri',
          error_description: `each redirect_uri must be a string of at most ${MAX_REDIRECT_URI_LENGTH} characters`,
        })
      }
      try {
        const parsed = new URL(uri)
        const isHttps = parsed.protocol === 'https:'
        // RFC 8252 §7.3 allows the IPv6 loopback literal, which the redirect
        // matcher already accepts.
        const isLoopback =
          parsed.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
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

    const grants = Array.isArray(grant_types)
      ? [...new Set(grant_types)]
      : ['authorization_code', 'refresh_token']
    // The only scope this server grants, so it is the only one stored.
    const scopes = [MCP_SCOPE]
    const redirectUris = [...new Set(redirect_uris)]

    // This endpoint is unauthenticated by design, so re-adding a connector in
    // ChatGPT or Gemini would otherwise insert another permanent row for a
    // client we already know. A row is reused only when every registered field
    // matches: name, the set of redirect URIs, the set of grant types, and the
    // auth method (public, so no secret). Any difference gets a new client, so
    // a registration with the same name cannot take over another client.
    const existing = await OauthApplication.findOne({
      name: client_name,
      redirectUris: { $all: redirectUris, $size: redirectUris.length },
      grants: { $all: grants, $size: grants.length },
      clientSecret: null,
    })
    if (existing) {
      return res.status(201).json({
        client_id: existing.id,
        client_name: existing.name,
        redirect_uris: existing.redirectUris,
        grant_types: existing.grants,
        scope: (existing.scopes || []).join(' '),
        token_endpoint_auth_method: 'none',
      })
    }

    const clientId = `client_${crypto.randomBytes(16).toString('hex')}`

    await OauthApplication.create({
      id: clientId,
      name: client_name,
      redirectUris,
      grants,
      scopes,
      pkceEnabled: true,
    })

    return res.status(201).json({
      client_id: clientId,
      client_name,
      redirect_uris: redirectUris,
      grant_types: grants,
      scope: scopes.join(' '),
      token_endpoint_auth_method: 'none',
    })
  },
}

export default OAuth2RegistrationController
