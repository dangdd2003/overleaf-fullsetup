import mongoose from '../infrastructure/Mongoose.mjs'

const { Schema } = mongoose
const { ObjectId } = Schema

export const PersonalAccessTokenSchema = new Schema(
  {
    user_id: {
      type: ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    name: {
      type: String,
      default: 'Git Token',
    },
    tokenHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    tokenPrefix: {
      type: String,
      required: true,
    },
    scopes: {
      type: [String],
      default: ['git_bridge'],
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    lastUsedAt: {
      type: Date,
    },
    expiresAt: {
      type: Date,
    },
  },
  {
    collection: 'personalAccessTokens',
    minimize: false,
  }
)

export const PersonalAccessToken = mongoose.model(
  'PersonalAccessToken',
  PersonalAccessTokenSchema
)

export default PersonalAccessToken
