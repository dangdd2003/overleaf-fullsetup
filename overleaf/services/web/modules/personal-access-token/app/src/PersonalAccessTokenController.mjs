import PersonalAccessTokenManager, {
  ALLOWED_SCOPES,
} from '../../../../app/src/Features/PersonalAccessToken/PersonalAccessTokenManager.mjs'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import { PersonalAccessToken } from '../../../../app/src/models/PersonalAccessToken.mjs'
import crypto from 'node:crypto'
import logger from '@overleaf/logger'

// Generic 500 body. The error stays server-side, under the id the client gets.
function internalError(res, err) {
  const errorId = crypto.randomUUID()
  logger.error({ err, errorId }, 'internal error')
  return res
    .status(500)
    .json({ code: 'error', message: 'internal error', errorId })
}

const MAX_TOKEN_NAME_LENGTH = 100
// Active means not expired. Revoking deletes the record, so it is not counted.
const MAX_ACTIVE_TOKENS_PER_USER = 20

async function countActiveTokens(userId) {
  return await PersonalAccessToken.countDocuments({
    user_id: userId,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
  })
}

const PersonalAccessTokenController = {
  async createToken(req, res) {
    const userId =
      req.session?.user?._id || SessionManager.getLoggedInUserId(req.session)
    const { name } = req.body || {}
    if (
      name != null &&
      (typeof name !== 'string' || name.length > MAX_TOKEN_NAME_LENGTH)
    ) {
      return res.status(400).json({
        code: 'validation_error',
        message: `name must be a string of at most ${MAX_TOKEN_NAME_LENGTH} characters`,
      })
    }

    let scopes = req.body?.scopes
    if (typeof scopes === 'string') {
      scopes = [scopes]
    }
    if (!Array.isArray(scopes) || scopes.length === 0) {
      scopes = ['git_bridge']
    }
    scopes = [...new Set(scopes)]
    const invalidScope = scopes.find(s => !ALLOWED_SCOPES.includes(s))
    if (invalidScope) {
      return res.status(400).json({
        code: 'validation_error',
        message: `invalid token scope: ${invalidScope}`,
      })
    }

    try {
      // Create first, then count, so concurrent requests cannot both pass the
      // check. If the new token pushed the user over the cap, it is revoked.
      const result = await PersonalAccessTokenManager.createToken(
        userId,
        name,
        scopes
      )
      if ((await countActiveTokens(userId)) > MAX_ACTIVE_TOKENS_PER_USER) {
        await PersonalAccessTokenManager.revokeToken(userId, result.record._id)
        return res.status(409).json({
          code: 'token_limit_reached',
          message: `you can have at most ${MAX_ACTIVE_TOKENS_PER_USER} active personal access tokens; revoke one before creating another`,
        })
      }

      return res.status(201).json({
        _id: result.record._id,
        token: result.token,
        tokenPrefix: result.tokenPrefix,
        name: result.record.name,
        createdAt: result.record.createdAt,
        expiresAt: result.record.expiresAt,
        scopes: result.record.scopes,
      })
    } catch (err) {
      logger.error({ err, userId }, 'error creating personal access token')
      return internalError(res, err)
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
      return internalError(res, err)
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
      // A token id that is not an ObjectId cannot name a token of this user.
      if (err?.name === 'CastError') {
        return res.status(404).json({ code: 'not_found', message: 'token not found' })
      }
      logger.error(
        { err, userId, tokenId },
        'error revoking personal access token'
      )
      return internalError(res, err)
    }
  },
}

export default PersonalAccessTokenController
