import mongoose from '../infrastructure/Mongoose.mjs'

const { Schema } = mongoose
const { ObjectId } = Schema

export const OauthAuthorizationCodeSchema = new Schema(
  {
    authorizationCode: String,
    expiresAt: Date,
    client_id: String,
    oauthApplication_id: { type: ObjectId, ref: 'OauthApplication' },
    redirectUri: String,
    scope: String,
    user_id: { type: ObjectId, ref: 'User' },
    codeChallenge: String,
    codeChallengeMethod: String,
  },
  {
    collection: 'oauthAuthorizationCodes',
    minimize: false,
  }
)

OauthAuthorizationCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export const OauthAuthorizationCode = mongoose.model(
  'OauthAuthorizationCode',
  OauthAuthorizationCodeSchema
)
