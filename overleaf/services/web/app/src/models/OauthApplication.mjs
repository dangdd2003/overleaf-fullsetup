import mongoose from '../infrastructure/Mongoose.mjs'

const { Schema } = mongoose

export const OauthApplicationSchema = new Schema(
  {
    id: String,
    clientSecret: String,
    grants: [String],
    name: String,
    redirectUris: [String],
    scopes: [String],
    pkceEnabled: Boolean,
    createdAt: { type: Date, default: Date.now },
  },
  {
    collection: 'oauthApplications',
    minimize: false,
  }
)

// Every /oauth/authorize resolves the client with findOne({ id }), and dynamic
// client registration lets anyone add rows, so this lookup must not be a
// collection scan. Sparse because pre-existing rows may predate the `id` field;
// a plain unique index would treat their missing values as duplicate nulls.
OauthApplicationSchema.index({ id: 1 }, { unique: true, sparse: true })

export const OauthApplication = mongoose.model(
  'OauthApplication',
  OauthApplicationSchema
)
