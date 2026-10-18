import PersonalAccessTokenManager from '../../../../app/src/Features/PersonalAccessToken/PersonalAccessTokenManager.mjs'

function extractToken(req) {
  let token = null
  if (typeof req.query?.access_token === 'string') {
    token = req.query.access_token.trim()
    req.query.access_token = token ? `${token.slice(0, 4)}...` : ''
    if (typeof req.url === 'string' && req.url.includes('access_token=')) {
      req.url = req.url.replace(/([?&]access_token=)[^&]+/g, '$1[REDACTED]')
    }
    if (typeof req.originalUrl === 'string' && req.originalUrl.includes('access_token=')) {
      req.originalUrl = req.originalUrl.replace(/([?&]access_token=)[^&]+/g, '$1[REDACTED]')
    }
  }
  if (!token) {
    const authHeader = req.headers?.authorization || ''
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim()
    } else if (authHeader.startsWith('Basic ')) {
      const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8')
      const [user, ...passParts] = decoded.split(':')
      const pass = passParts.join(':')
      if (pass) token = pass.trim()
      else if (user && user !== 'git') token = user.trim()
    }
  }
  return token
}

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

    return res.json(tokenInfo)
  },
}

export default Oauth2TokenInfoController
