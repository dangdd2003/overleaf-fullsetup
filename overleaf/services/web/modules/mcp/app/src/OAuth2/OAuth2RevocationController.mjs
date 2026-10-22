import OAuth2KeyManager from './OAuth2KeyManager.mjs'
import { hashToken, oauthError } from './OAuth2Utils.mjs'
import { OauthAccessToken } from '../../../../../app/src/models/OauthAccessToken.mjs'

/**
 * A Mongo filter that matches the grant a token belongs to, or null if the
 * token does not identify one.
 *
 * An access token must verify before its grant_id is trusted. Otherwise anyone
 * could delete someone else's grant by forging a JWT. An expired access token
 * does not resolve; the client can revoke with its refresh token instead.
 */
async function grantFilterForToken(token) {
  if (token.startsWith('oar_')) {
    const hash = hashToken(token)
    return { refreshToken: hash }
  }

  if (token.split('.').length === 3) {
    try {
      const payload = await OAuth2KeyManager.verifyJwt(token)
      return payload.grant_id ? { _id: payload.grant_id } : null
    } catch {
      return null
    }
  }

  return null
}

const OAuth2RevocationController = {
  /**
   * Token revocation (RFC 7009). Deleting the grant revokes its refresh token
   * and every access token minted from it, and the MCP auth gate checks the
   * grant on each request.
   *
   * The response is 200 whether or not the token was known, as RFC 7009 §2.2
   * asks, so the endpoint cannot be used to probe for valid tokens.
   */
  async revoke(req, res) {
    const { token, client_id: clientId } = req.body || {}
    if (!token || typeof token !== 'string') {
      return oauthError(res, 400, 'invalid_request', 'token is required')
    }

    // RFC 7009 §2.1: only the client the token was issued to may revoke it.
    // A missing or mismatched client_id gets the same 200 as an unknown token,
    // so the response does not reveal whether the token exists.
    if (typeof clientId === 'string' && clientId) {
      const filter = await grantFilterForToken(token)
      if (filter) {
        await OauthAccessToken.deleteOne({ ...filter, client_id: clientId })
      }
    }

    return res.status(200).json({})
  },
}

export default OAuth2RevocationController
