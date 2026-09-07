import mongoose from '../infrastructure/Mongoose.mjs'

const { Schema } = mongoose
const { ObjectId } = Schema

export const OauthAccessTokenSchema = new Schema(
  {
    accessToken: String,
    accessTokenPartial: String,
    type: String,
    accessTokenExpiresAt: Date,
    oauthApplication_id: { type: ObjectId, ref: 'OauthApplication' },
    refreshToken: String,
    refreshTokenExpiresAt: Date,
    client_id: { type: String, default: null },
    audience: { type: String, default: null },
    scope: String,
    user_id: { type: ObjectId, ref: 'User' },
    createdAt: { type: Date },
    expiresAt: Date,
    lastUsedAt: Date,
    lastNotifiedAt: {
      type: {
        warning: Date,
        expired: Date,
      },
      _id: false,
    },
    notificationsSuppressedAt: Date,
  },
  {
    collection: 'oauthAccessTokens',
    minimize: false,
  }
)

OauthAccessTokenSchema.index(
  { refreshTokenExpiresAt: 1 },
  { expireAfterSeconds: 0 }
)

// The refresh_token grant resolves the token with findOne({ refreshToken }).
// The TTL index above does not serve that lookup, so without this it scans.
OauthAccessTokenSchema.index({ refreshToken: 1 })

export const OauthAccessToken = mongoose.model(
  'OauthAccessToken',
  OauthAccessTokenSchema
)
