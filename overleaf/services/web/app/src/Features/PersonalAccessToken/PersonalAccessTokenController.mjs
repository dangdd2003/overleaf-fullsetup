import PersonalAccessTokenManager, {
  ALLOWED_SCOPES,
} from './PersonalAccessTokenManager.mjs'
import SessionManager from '../Authentication/SessionManager.mjs'
import logger from '@overleaf/logger'

const PersonalAccessTokenController = {
  async createToken(req, res) {
    const userId =
      req.session?.user?._id || SessionManager.getLoggedInUserId(req.session)
    const { name } = req.body || {}

    let scopes = req.body?.scopes
    if (typeof scopes === 'string') {
      scopes = [scopes]
    }
    if (!Array.isArray(scopes) || scopes.length === 0) {
      scopes = ['git_bridge']
    }
    const invalidScope = scopes.find(s => !ALLOWED_SCOPES.includes(s))
    if (invalidScope) {
      return res.status(400).json({
        code: 'validation_error',
        message: `invalid token scope: ${invalidScope}`,
      })
    }

    try {
      const result = await PersonalAccessTokenManager.createToken(
        userId,
        name,
        scopes
      )
      return res.json({
        token: result.token,
        tokenPrefix: result.tokenPrefix,
        name: result.record.name,
        createdAt: result.record.createdAt,
        scopes: result.record.scopes,
      })
    } catch (err) {
      logger.error({ err, userId }, 'error creating personal access token')
      return res.status(500).json({ code: 'error', message: err.message })
    }
  },

  async listTokens(req, res) {
    const userId =
      req.session?.user?._id || SessionManager.getLoggedInUserId(req.session)
    try {
      const tokens = await PersonalAccessTokenManager.listTokens(userId)
      return res.json(tokens)
    } catch (err) {
      logger.error({ err, userId }, 'error listing personal access tokens')
      return res.status(500).json({ code: 'error', message: err.message })
    }
  },

  async revokeToken(req, res) {
    const userId =
      req.session?.user?._id || SessionManager.getLoggedInUserId(req.session)
    const { tokenId } = req.params
    try {
      await PersonalAccessTokenManager.revokeToken(userId, tokenId)
      return res.sendStatus(204)
    } catch (err) {
      logger.error(
        { err, userId, tokenId },
        'error revoking personal access token'
      )
      return res.status(500).json({ code: 'error', message: err.message })
    }
  },
}

export default PersonalAccessTokenController
