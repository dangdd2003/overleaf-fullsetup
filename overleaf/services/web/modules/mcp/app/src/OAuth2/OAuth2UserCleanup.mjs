import { OauthAccessToken } from '../../../../../app/src/models/OauthAccessToken.mjs'
import { OauthAuthorizationCode } from '../../../../../app/src/models/OauthAuthorizationCode.mjs'

/**
 * Revokes every grant and pending authorization code of a deleted user. The
 * access JWTs minted from a grant stop working with it, since each request
 * checks that its grant still exists.
 */
export async function revokeUserGrants(userId) {
  await OauthAccessToken.deleteMany({ user_id: userId }).exec()
  await OauthAuthorizationCode.deleteMany({ user_id: userId }).exec()
}
