import PersonalAccessTokenManager from './PersonalAccessTokenManager.mjs'

function extractToken(req) {
  if (typeof req.query?.access_token === 'string') {
    return req.query.access_token.trim()
  }
  const authHeader = req.headers?.authorization || ''
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim()
  }
  if (authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8')
    const [user, ...passParts] = decoded.split(':')
    const pass = passParts.join(':')
    if (pass) return pass.trim()
    if (user && user !== 'git') return user.trim()
    return null
  }
  return null
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
