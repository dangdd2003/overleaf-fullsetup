import PersonalAccessTokenManager from '../../../../app/src/Features/PersonalAccessToken/PersonalAccessTokenManager.mjs'
import { extractToken } from './GitBridgeApiController.mjs'

const Oauth2TokenInfoController = {
  async getTokenInfo(req, res) {
    const rawToken = extractToken(req)
    if (!rawToken) {
      return res.status(401).json({
        error: 'invalid_token',
        error_description: 'Authorization header is missing or malformed.',
      })
    }

    const tokenInfo = await PersonalAccessTokenManager.validateToken(rawToken)
    if (!tokenInfo) {
      return res.status(401).json({
        error: 'invalid_token',
        error_description: 'The access token provided is invalid or expired.',
      })
    }

    // A token without the git_bridge scope (e.g. an mcp-only token) is refused
    // here, as requireGitBridgeAuth refuses it for every git-bridge operation.
    // 401 rather than 403: git-bridge treats any other 4xx from this endpoint as
    // a server error, and a 401 keeps its "enter your Git token" message.
    if (!(tokenInfo.scopes || []).includes('git_bridge')) {
      return res.status(401).json({
        error: 'invalid_token',
        error_description: 'The access token is missing the git_bridge scope.',
      })
    }

    return res.json(tokenInfo)
  },
}

export default Oauth2TokenInfoController
