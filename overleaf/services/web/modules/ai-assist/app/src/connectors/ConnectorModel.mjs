// The app's own connection (app/src/infrastructure/Mongoose.mjs) is opened on
// this same mongoose instance at startup; importing it here would connect at
// import time.
import mongoose from 'mongoose'

const { Schema } = mongoose
const { ObjectId } = Schema

// Four collections, split by who reads them and how long they live:
//
// - aiAssistConnectors: what a user configured and what the server told us
//   (tools, instructions). No secrets, so listing and every run read it
//   freely.
// - aiAssistConnectorCredentials: the secrets for one connector (headers,
//   own OAuth client secret, tokens), sealed with ConnectorCrypto. Read only
//   to dial the server or refresh a token; deleted with the connector.
// - aiAssistOAuthClients: clients this instance registered with an
//   authorization server through DCR, shared by every user of that server,
//   as one Overleaf instance is one OAuth client (claude.ai does the same).
// - aiAssistOAuthStates: sign-ins in flight, keyed by the hashed `state`,
//   removed by Mongo's TTL monitor once they expire.

export const ConnectorSchema = new Schema(
  {
    user_id: { type: ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true },
    url: { type: String, required: true },
    transport: {
      type: String,
      enum: ['auto', 'streamable-http', 'sse'],
      default: 'auto',
    },
    // 'auto': connect as is and sign in when the server asks (sign in when
    // needed); 'oauth': sign in before connecting; 'none': never sign in.
    authMode: {
      type: String,
      enum: ['auto', 'oauth', 'none'],
      default: 'auto',
    },
    enabled: { type: Boolean, default: true },
    status: {
      type: String,
      enum: ['connected', 'needs_auth', 'error', 'disconnected', 'pending'],
      default: 'pending',
    },
    lastError: {
      message: String,
      code: String,
      at: Date,
    },
    // Seconds a tool call may run; null waits for as long as the server takes
    // (the run's Stop button still ends it).
    timeoutSeconds: { type: Number, default: null },
    // Names only: the values live in the credentials document.
    headerNames: [String],
    oauth: {
      clientMode: {
        type: String,
        enum: ['auto', 'cimd', 'dcr', 'custom'],
        default: 'auto',
      },
      // Own OAuth client ("Use your own OAuth client"); its secret is sealed.
      customClientId: String,
      scopes: String,
      authorizationUrl: String,
      tokenUrl: String,
      tokenEndpointAuthMethod: {
        type: String,
        enum: ['auto', 'client_secret_basic', 'client_secret_post', 'none'],
        default: 'auto',
      },
      extraParams: [{ _id: false, name: String, value: String }],
      // Learned from discovery
      resource: String,
      resourceMetadataUrl: String,
      issuer: String,
      registration: {
        type: String,
        enum: ['cimd', 'dcr', 'custom', null],
        default: null,
      },
      clientId: String,
      grantedScopes: String,
      expiresAt: Date,
      hasRefreshToken: Boolean,
    },
    server: {
      name: String,
      title: String,
      version: String,
      protocolVersion: String,
      transport: String,
      instructions: String,
      capabilities: Schema.Types.Mixed,
    },
    tools: [
      {
        _id: false,
        name: String,
        title: String,
        description: String,
        inputSchema: Schema.Types.Mixed,
        annotations: Schema.Types.Mixed,
      },
    ],
    toolsUpdatedAt: Date,
    toolPermissions: Schema.Types.Mixed,
    // Set while one replica renews the connector's tokens (see McpOAuth)
    refreshLockUntil: Date,
    lastConnectedAt: Date,
    lastUsedAt: Date,
  },
  { collection: 'aiAssistConnectors', timestamps: true, minimize: false }
)

export const ConnectorCredentialSchema = new Schema(
  {
    connector_id: { type: ObjectId, required: true, unique: true },
    user_id: { type: ObjectId, ref: 'User', required: true, index: true },
    // { [headerName]: value }
    headers: String,
    clientSecret: String,
    // { access_token, refresh_token, token_type, scope }
    tokens: String,
  },
  { collection: 'aiAssistConnectorCredentials', timestamps: true }
)

export const OAuthClientSchema = new Schema(
  {
    issuer: { type: String, required: true },
    redirectUri: { type: String, required: true },
    registrationEndpoint: String,
    clientId: { type: String, required: true },
    clientSecret: String,
    tokenEndpointAuthMethod: String,
    // RFC 7591 client_secret_expires_at; 0 or absent never expires
    secretExpiresAt: Date,
  },
  { collection: 'aiAssistOAuthClients', timestamps: true }
)
OAuthClientSchema.index({ issuer: 1, redirectUri: 1 }, { unique: true })

export const OAuthStateSchema = new Schema(
  {
    stateHash: { type: String, required: true, unique: true },
    connector_id: { type: ObjectId, required: true },
    user_id: { type: ObjectId, ref: 'User', required: true },
    verifier: { type: String, required: true },
    redirectUri: String,
    clientId: String,
    scope: String,
    issuer: String,
    resource: String,
    expiresAt: { type: Date, required: true, expires: 0 },
  },
  { collection: 'aiAssistOAuthStates', timestamps: true }
)

function model(name, schema) {
  return mongoose.models[name] || mongoose.model(name, schema)
}

export const ConnectorModel = model('AiAssistConnector', ConnectorSchema)
export const ConnectorCredentialModel = model(
  'AiAssistConnectorCredential',
  ConnectorCredentialSchema
)
export const OAuthClientModel = model('AiAssistOAuthClient', OAuthClientSchema)
export const OAuthStateModel = model('AiAssistOAuthState', OAuthStateSchema)

export default ConnectorModel
