import crypto from 'node:crypto'
import Settings from '@overleaf/settings'
import { connectorFetch } from './ConnectorFetch.mjs'
import { seal, open } from './ConnectorCrypto.mjs'
import {
  ConnectorModel,
  OAuthClientModel,
  OAuthStateModel,
} from './ConnectorModel.mjs'
import { loadCredentials, saveCredentials } from './ConnectorCredentials.mjs'
import { presetFor } from './ConnectorPresets.mjs'

// OAuth 2.1 for remote MCP servers, as the MCP authorization spec
// (2025-06-18, 2025-11-25) and claude.ai's connectors do it:
//   protected resource metadata (RFC 9728) -> authorization server metadata
//   (RFC 8414 / OIDC) -> a client (own, CIMD, or DCR) -> authorization code
//   with PKCE S256 and the resource indicator (RFC 8707) -> tokens, refreshed
//   ahead of expiry and again on a 401.

const STATE_LIFETIME_MS = 60 * 60 * 1000
// Refresh this long before the access token runs out (claude.ai: 5 minutes)
const REFRESH_AHEAD_MS = 5 * 60 * 1000
// The renewal lease outlasts a token request (30s), so a crashed replica's
// lease ends soon after it, and a waiting request polls for the other's answer
const REFRESH_LEASE_MS = 45 * 1000
const REFRESH_WAIT_MS = 45 * 1000
const REFRESH_POLL_MS = 500
const CLIENT_NAME = 'Overleaf AI Assist'

export function siteUrl() {
  return (Settings.siteUrl || '').replace(/\/+$/, '')
}

export function redirectUri() {
  return `${siteUrl()}/ai-assist/connectors/oauth/callback`
}

export function clientMetadataUrl() {
  return `${siteUrl()}/ai-assist/connectors/oauth/client-metadata.json`
}

/**
 * An authorization server can only fetch our Client ID Metadata Document
 * when the instance is on a public https address.
 */
export function canUseCimd() {
  try {
    const url = new URL(siteUrl())
    return (
      url.protocol === 'https:' &&
      url.hostname !== 'localhost' &&
      !url.hostname.endsWith('.localhost')
    )
  } catch {
    return false
  }
}

export class OAuthClientRequiredError extends Error {
  constructor(message) {
    super(
      message ||
        "This server's sign-in does not register apps automatically. Add your own OAuth client ID (and secret, if the server requires one) in the connector's advanced settings."
    )
    this.name = 'OAuthClientRequiredError'
    this.code = 'OAUTH_CLIENT_REQUIRED'
    this.status = 400
  }
}

/**
 * An endpoint the server named, or the user typed, that is an http(s) address.
 * The authorization one is sent to the browser, where any other scheme would
 * run script in this origin.
 */
export function isHttpUrl(value) {
  if (typeof value !== 'string' || !value) return false
  try {
    const { protocol } = new URL(value)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

async function getJson(fetch, url) {
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    timeoutMs: 10_000,
  })
  if (!res.ok) return null
  try {
    return await res.json()
  } catch {
    return null
  }
}

function normalizePrm(json, url) {
  return {
    resource: json.resource || url,
    authorization_servers: Array.isArray(json.authorization_servers)
      ? json.authorization_servers
      : [],
    scopes_supported: Array.isArray(json.scopes_supported)
      ? json.scopes_supported
      : [],
    raw: json,
  }
}

export async function discoverProtectedResourceMetadata({
  url,
  resourceMetadataUrl,
  fetch = connectorFetch,
}) {
  const candidates = []
  if (resourceMetadataUrl) candidates.push(resourceMetadataUrl)
  const parsed = new URL(url)
  const path = parsed.pathname.replace(/\/+$/, '')
  if (path) {
    candidates.push(
      `${parsed.origin}/.well-known/oauth-protected-resource${path}`
    )
  }
  candidates.push(`${parsed.origin}/.well-known/oauth-protected-resource`)

  for (const candidate of candidates) {
    try {
      const json = await getJson(fetch, candidate)
      if (json) return normalizePrm(json, url)
    } catch {}
  }
  return {
    resource: url,
    authorization_servers: [],
    scopes_supported: [],
    raw: null,
  }
}

export async function discoverAuthorizationServerMetadata({
  issuer,
  fetch = connectorFetch,
}) {
  const parsed = new URL(issuer)
  const path = parsed.pathname.replace(/\/+$/, '')
  // The order the MCP spec gives for an issuer with and without a path
  const candidates = path
    ? [
        `${parsed.origin}/.well-known/oauth-authorization-server${path}`,
        `${parsed.origin}/.well-known/openid-configuration${path}`,
        `${parsed.origin}${path}/.well-known/openid-configuration`,
      ]
    : [
        `${parsed.origin}/.well-known/oauth-authorization-server`,
        `${parsed.origin}/.well-known/openid-configuration`,
      ]

  for (const candidate of candidates) {
    try {
      const json = await getJson(fetch, candidate)
      // Only web addresses: the endpoints come from a server we do not trust
      const authorization = isHttpUrl(json?.authorization_endpoint)
        ? json.authorization_endpoint
        : undefined
      const token = isHttpUrl(json?.token_endpoint)
        ? json.token_endpoint
        : undefined
      const registration = isHttpUrl(json?.registration_endpoint)
        ? json.registration_endpoint
        : undefined
      if (!authorization && !token) continue
      return {
        issuer: json.issuer || issuer,
        authorization_endpoint: authorization,
        token_endpoint: token,
        registration_endpoint: registration,
        scopes_supported: Array.isArray(json.scopes_supported)
          ? json.scopes_supported
          : [],
        token_endpoint_auth_methods_supported: Array.isArray(
          json.token_endpoint_auth_methods_supported
        )
          ? json.token_endpoint_auth_methods_supported
          : ['client_secret_basic'],
        client_id_metadata_document_supported: Boolean(
          json.client_id_metadata_document_supported
        ),
        raw: json,
      }
    } catch {}
  }
  throw new Error(
    `Failed to discover OAuth authorization server metadata for issuer: ${issuer}`
  )
}

/** Everything known about how to sign in to a connector's server. */
export async function discover({
  url,
  resourceMetadataUrl,
  issuer,
  fetch = connectorFetch,
}) {
  let prm = null
  try {
    prm = await discoverProtectedResourceMetadata({
      url,
      resourceMetadataUrl,
      fetch,
    })
  } catch {}
  const asIssuer = issuer || prm?.authorization_servers?.[0]
  let as = null
  if (asIssuer) {
    try {
      as = await discoverAuthorizationServerMetadata({ issuer: asIssuer, fetch })
    } catch {}
  }
  return { prm, as, preset: presetFor(url) }
}

function cimdAccepted(as) {
  return (
    as?.client_id_metadata_document_supported &&
    as.token_endpoint_auth_methods_supported.includes('none')
  )
}

/** A client this instance registered with `issuer` before, still valid. */
async function sharedDcrClient(issuer) {
  const doc = await OAuthClientModel.findOne({
    issuer,
    redirectUri: redirectUri(),
  })
    .lean()
    .exec()
  if (!doc) return null
  if (doc.secretExpiresAt && doc.secretExpiresAt < new Date()) return null
  return doc
}

function sharedClientContext(issuer) {
  return `aiAssistOAuthClients:${issuer}:${redirectUri()}:clientSecret`
}

async function registerDcrClient(as, fetch) {
  const res = await fetch(as.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      client_uri: siteUrl(),
      redirect_uris: [redirectUri()],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
    timeoutMs: 10_000,
  })
  if (!res.ok) {
    throw new Error(
      `Automatic registration failed with HTTP ${res.status}: ${await res.text()}`
    )
  }
  const json = await res.json()
  if (!json?.client_id) {
    throw new Error('Automatic registration returned no client_id')
  }
  const update = {
    registrationEndpoint: as.registration_endpoint,
    clientId: json.client_id,
    clientSecret: json.client_secret
      ? seal(json.client_secret, sharedClientContext(as.issuer))
      : null,
    tokenEndpointAuthMethod: json.token_endpoint_auth_method || 'none',
    secretExpiresAt: json.client_secret_expires_at
      ? new Date(json.client_secret_expires_at * 1000)
      : null,
  }
  await OAuthClientModel.updateOne(
    { issuer: as.issuer, redirectUri: redirectUri() },
    { $set: update },
    { upsert: true }
  ).exec()
  return { ...update, issuer: as.issuer }
}

/**
 * Picks the client to sign in with, in the MCP spec's order: the user's own
 * client, then Overleaf's published identity (CIMD), then a registered one
 * (DCR, shared by everyone on this instance).
 */
export async function resolveClient({ connector, as, fetch = connectorFetch }) {
  const mode = connector.oauth?.clientMode || 'auto'

  if (mode === 'custom' || connector.oauth?.customClientId) {
    if (!connector.oauth?.customClientId) throw new OAuthClientRequiredError()
    return { clientId: connector.oauth.customClientId, registration: 'custom' }
  }

  if (mode === 'cimd' || (mode === 'auto' && canUseCimd() && cimdAccepted(as))) {
    return { clientId: clientMetadataUrl(), registration: 'cimd' }
  }

  if (mode === 'dcr' || (mode === 'auto' && as?.registration_endpoint)) {
    if (!as?.registration_endpoint) {
      throw new OAuthClientRequiredError(
        'This server does not offer automatic registration. Choose another client option or add your own OAuth client.'
      )
    }
    const client =
      (await sharedDcrClient(as.issuer)) || (await registerDcrClient(as, fetch))
    return { clientId: client.clientId, registration: 'dcr' }
  }

  throw new OAuthClientRequiredError()
}

/** The secret that goes with the connector's current client, if any. */
async function clientSecretFor(connector, credentials) {
  const registration = connector.oauth?.registration
  if (registration === 'custom') return credentials?.clientSecret || null
  if (registration === 'dcr' && connector.oauth?.issuer) {
    const doc = await sharedDcrClient(connector.oauth.issuer)
    if (doc?.clientSecret) {
      return open(doc.clientSecret, sharedClientContext(connector.oauth.issuer))
    }
  }
  return null
}

function joinScopes(...lists) {
  const scopes = []
  for (const list of lists) {
    for (const scope of String(list || '').split(/\s+/)) {
      if (scope && !scopes.includes(scope)) scopes.push(scope)
    }
  }
  return scopes.join(' ')
}

/**
 * The endpoints to use now: the user's own, else discovered, else a known
 * server's preset. Discovered values are returned, never saved as overrides.
 */
function endpointsFor({ connector, as, preset }) {
  const oauth = connector.oauth || {}
  return {
    authorizationEndpoint:
      oauth.authorizationUrl ||
      as?.authorization_endpoint ||
      preset?.oauth.authorizationUrl ||
      '',
    tokenEndpoint:
      oauth.tokenUrl || as?.token_endpoint || preset?.oauth.tokenUrl || '',
  }
}

/**
 * Whether a sign-in can actually be started for this connector: endpoints the
 * user entered, a known preset, or an authorization server discovery finds.
 */
export async function signInOffered({ connector, fetch = connectorFetch }) {
  const preset = presetFor(connector.url)
  const known = endpointsFor({ connector, as: null, preset })
  if (known.authorizationEndpoint && known.tokenEndpoint) return true
  const { as } = await discover({
    url: connector.url,
    resourceMetadataUrl: connector.oauth?.resourceMetadataUrl,
    issuer: connector.oauth?.issuer,
    fetch,
  })
  const found = endpointsFor({ connector, as, preset })
  return Boolean(found.authorizationEndpoint && found.tokenEndpoint)
}

/** The connector a sign-in state belongs to, read without consuming it. */
export async function pendingConnectorId({ state, userId }) {
  if (typeof state !== 'string' || !state || !userId) return ''
  const stateHash = crypto.createHash('sha256').update(state).digest('hex')
  const pending = await OAuthStateModel.findOne({ stateHash, user_id: userId })
    .lean()
    .exec()
  return pending?.connector_id ? String(pending.connector_id) : ''
}

export async function startAuthorization({
  connector,
  stepUpScope = null,
  fetch = connectorFetch,
}) {
  const { prm, as, preset } = await discover({
    url: connector.url,
    resourceMetadataUrl: connector.oauth?.resourceMetadataUrl,
    issuer: connector.oauth?.issuer,
    fetch,
  })

  const oauth = connector.oauth
  if (prm?.resource) oauth.resource = prm.resource
  if (as?.issuer) oauth.issuer = as.issuer

  // Discovered endpoints are used for this sign-in only and never written
  // into the user's own URL fields, so a later server change rediscovers.
  const { authorizationEndpoint, tokenEndpoint } = endpointsFor({
    connector,
    as,
    preset,
  })
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new Error(
      "This server's sign-in could not be discovered. Enter its authorization and token URLs in the connector's advanced settings."
    )
  }
  if (!isHttpUrl(authorizationEndpoint) || !isHttpUrl(tokenEndpoint)) {
    throw new Error(
      "This server's sign-in address is not a web (http or https) address. Enter its authorization and token URLs in the connector's advanced settings."
    )
  }
  if (!oauth.issuer && preset?.oauth.issuer) oauth.issuer = preset.oauth.issuer

  const { clientId, registration } = await resolveClient({
    connector,
    as,
    fetch,
  })
  oauth.clientId = clientId
  oauth.registration = registration

  let scope = joinScopes(
    oauth.scopes ||
      (prm?.scopes_supported?.length
        ? prm.scopes_supported.join(' ')
        : preset?.oauth.scopes || ''),
    stepUpScope
  )
  // A refresh token keeps the connector signed in (claude.ai asks the same)
  if (
    as?.scopes_supported?.includes('offline_access') &&
    !scope.split(' ').includes('offline_access')
  ) {
    scope = joinScopes(scope, 'offline_access')
  }

  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto
    .createHash('sha256')
    .update(verifier)
    .digest('base64url')
  const state = crypto.randomBytes(32).toString('base64url')
  const stateHash = crypto.createHash('sha256').update(state).digest('hex')

  await OAuthStateModel.create({
    stateHash,
    connector_id: connector._id,
    user_id: connector.user_id,
    verifier: seal(verifier, `aiAssistOAuthStates:${stateHash}:verifier`),
    redirectUri: redirectUri(),
    clientId,
    scope,
    issuer: oauth.issuer || '',
    resource: oauth.resource || '',
    expiresAt: new Date(Date.now() + STATE_LIFETIME_MS),
  })
  await connector.save()

  const authUrl = new URL(authorizationEndpoint)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('client_id', clientId)
  authUrl.searchParams.set('redirect_uri', redirectUri())
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('code_challenge', challenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  if (scope) authUrl.searchParams.set('scope', scope)
  if (oauth.resource && !preset?.omitResource) {
    authUrl.searchParams.set('resource', oauth.resource)
  }
  const extraParams = oauth.extraParams?.length
    ? oauth.extraParams
    : preset?.oauth.extraParams || []
  for (const p of extraParams) {
    if (p.name && p.value) authUrl.searchParams.set(p.name, p.value)
  }

  return { authorizationUrl: authUrl.toString() }
}

async function tokenRequest({ connector, credentials, tokenUrl, params, fetch }) {
  const clientId = connector.oauth.clientId || connector.oauth.customClientId
  const clientSecret = await clientSecretFor(connector, credentials)
  const body = new URLSearchParams(params)
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  }
  const method = connector.oauth.tokenEndpointAuthMethod || 'auto'
  if (clientSecret && method !== 'none') {
    if (method === 'client_secret_post') {
      body.set('client_id', clientId)
      body.set('client_secret', clientSecret)
    } else {
      headers.Authorization = `Basic ${Buffer.from(
        `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`
      ).toString('base64')}`
    }
  } else if (clientId) {
    body.set('client_id', clientId)
  }
  if (connector.oauth.resource && !presetFor(connector.url)?.omitResource) {
    body.set('resource', connector.oauth.resource)
  }

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers,
    body: body.toString(),
    timeoutMs: 30_000,
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    // GitHub-style form-encoded answers
    json = Object.fromEntries(new URLSearchParams(text))
  }
  if (!res.ok || !json?.access_token) {
    const err = new Error(
      json?.error_description ||
        json?.error ||
        `Token request failed with HTTP ${res.status}`
    )
    err.code = json?.error || 'TOKEN_ERROR'
    throw err
  }
  return json
}

async function storeTokens(connector, previous, tokenData, tokenEndpoint) {
  const tokens = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token || previous?.refresh_token || null,
    token_type: tokenData.token_type || 'Bearer',
    scope: tokenData.scope || previous?.scope || null,
    // Sealed with the tokens: a refresh goes to the endpoint that issued them
    token_endpoint: tokenEndpoint || previous?.token_endpoint || null,
  }
  await saveCredentials(connector._id, connector.user_id, { tokens })
  connector.oauth.expiresAt = tokenData.expires_in
    ? new Date(Date.now() + Number(tokenData.expires_in) * 1000)
    : null
  connector.oauth.hasRefreshToken = Boolean(tokens.refresh_token)
  if (tokenData.scope) connector.oauth.grantedScopes = tokenData.scope
  return tokens
}

export async function handleCallback({
  code,
  state,
  iss,
  error,
  errorDescription,
  userId,
  fetch = connectorFetch,
}) {
  if (error) {
    throw new Error(errorDescription || error)
  }
  if (typeof state !== 'string' || !state || typeof code !== 'string' || !code) {
    throw new Error('Missing code or state parameter in OAuth callback')
  }
  if (!userId) {
    throw new Error('Sign in to Overleaf, then connect the connector again.')
  }

  const stateHash = crypto.createHash('sha256').update(state).digest('hex')
  // One use only, and only by the account that started it: a replayed or
  // foreign callback finds nothing to consume
  const pending = await OAuthStateModel.findOneAndDelete({
    stateHash,
    user_id: userId,
  })
    .lean()
    .exec()
  if (!pending) {
    throw new Error(
      'This sign-in link was already used, has expired, or belongs to another account.'
    )
  }
  if (pending.expiresAt < new Date()) {
    throw new Error('This sign-in has expired. Please try again.')
  }
  // RFC 9207
  if (iss && pending.issuer && iss !== pending.issuer) {
    throw new Error(`Issuer mismatch: expected ${pending.issuer}, got ${iss}`)
  }

  const connector = await ConnectorModel.findOne({
    _id: pending.connector_id,
    user_id: pending.user_id,
  }).exec()
  if (!connector) throw new Error('Connector not found')

  const verifier = open(
    pending.verifier,
    `aiAssistOAuthStates:${stateHash}:verifier`
  )
  const credentials = await loadCredentials(connector._id)
  // The user's own token URL, else the server's current metadata (the code
  // must go to the authorization server it was issued by)
  let tokenUrl = connector.oauth.tokenUrl
  if (!tokenUrl) {
    const { as, preset } = await discover({
      url: connector.url,
      resourceMetadataUrl: connector.oauth.resourceMetadataUrl,
      issuer: pending.issuer || connector.oauth.issuer,
      fetch,
    })
    if (as?.issuer && pending.issuer && as.issuer !== pending.issuer) {
      throw new Error(
        `Issuer mismatch: expected ${pending.issuer}, got ${as.issuer}`
      )
    }
    tokenUrl = as?.token_endpoint || preset?.oauth.tokenUrl || ''
  }
  if (!tokenUrl) {
    throw new Error(
      "This server's sign-in could not be discovered. Enter its authorization and token URLs in the connector's advanced settings."
    )
  }
  connector.oauth.clientId = pending.clientId || connector.oauth.clientId
  const tokenData = await tokenRequest({
    connector,
    credentials,
    tokenUrl,
    params: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: pending.redirectUri,
      code_verifier: verifier,
    },
    fetch,
  })
  await storeTokens(connector, null, tokenData, tokenUrl)
  if (!tokenData.scope) connector.oauth.grantedScopes = pending.scope
  connector.status = 'connected'
  connector.lastError = undefined
  await connector.save()
  return { connector }
}

const refreshing = new Map()

/**
 * Renews the access token. Concurrent callers for one connector share one
 * request, so a rotating refresh token is spent only once.
 */
export function refreshTokens({ connector, fetch = connectorFetch }) {
  const key = connector._id.toString()
  if (!refreshing.has(key)) {
    refreshing.set(
      key,
      doRefresh(connector, fetch).finally(() => refreshing.delete(key))
    )
  }
  return refreshing.get(key)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Takes the renewal lease on the connector. The update is atomic in Mongo, so
 * across every web replica one renewal at a time may spend the rotating refresh
 * token. Returns the lease's end time, or null while another renewal holds it.
 */
async function acquireRefreshLease(connector) {
  const now = new Date()
  const until = new Date(now.getTime() + REFRESH_LEASE_MS)
  const held = await ConnectorModel.findOneAndUpdate(
    {
      _id: connector._id,
      user_id: connector.user_id,
      $or: [
        { refreshLockUntil: null },
        { refreshLockUntil: { $lte: now } },
      ],
    },
    { $set: { refreshLockUntil: until } }
  )
    .lean()
    .exec()
  return held ? until : null
}

async function releaseRefreshLease(connector, until) {
  await ConnectorModel.updateOne(
    { _id: connector._id, refreshLockUntil: until },
    { $unset: { refreshLockUntil: '' } }
  )
    .exec()
    .catch(() => {})
}

/**
 * Waits while another replica renews the connector. Its new access token, once
 * stored, is the answer: this request does not spend the refresh token again.
 * Once that renewal has ended without a new token, the lease is taken here.
 */
async function awaitRenewal(connector, sent) {
  const deadline = Date.now() + REFRESH_WAIT_MS
  do {
    await sleep(REFRESH_POLL_MS)
    const stored = (await loadCredentials(connector._id)).tokens
    if (stored?.access_token && stored.access_token !== sent.accessToken) {
      return { accessToken: stored.access_token }
    }
    const until = await acquireRefreshLease(connector)
    if (until) return { until }
  } while (Date.now() < deadline)
  return null
}

/** One renewal, made while holding the lease. */
async function renewWithLease(connector, fetch) {
  // Read again under the lease: a renewal that just ended may have rotated it
  const credentials = await loadCredentials(connector._id)
  const refreshToken = credentials.tokens?.refresh_token
  const tokenUrl =
    connector.oauth?.tokenUrl || credentials.tokens?.token_endpoint
  try {
    if (!refreshToken || !tokenUrl) {
      const err = new Error('Sign in again to renew access')
      err.code = 'invalid_grant'
      throw err
    }
    const tokenData = await tokenRequest({
      connector,
      credentials,
      tokenUrl,
      params: { grant_type: 'refresh_token', refresh_token: refreshToken },
      fetch,
    })
    const tokens = await storeTokens(
      connector,
      credentials.tokens,
      tokenData,
      tokenUrl
    )
    connector.status = 'connected'
    connector.lastError = undefined
    await connector.save()
    return tokens.access_token
  } catch (err) {
    if (err.code === 'invalid_grant') {
      // A refusal can be for a refresh token another replica has just rotated
      // away from. Its stored answer stands; the connector is not signed out.
      const latest = (await loadCredentials(connector._id)).tokens
      if (
        refreshToken &&
        latest?.access_token &&
        latest.refresh_token !== refreshToken
      ) {
        return latest.access_token
      }
      await saveCredentials(connector._id, connector.user_id, { tokens: null })
      connector.oauth.expiresAt = null
      connector.oauth.hasRefreshToken = false
      connector.status = 'needs_auth'
      await connector.save()
    }
    throw err
  }
}

async function doRefresh(connector, fetch) {
  const before = (await loadCredentials(connector._id)).tokens
  let until = await acquireRefreshLease(connector)
  if (!until) {
    const renewed = await awaitRenewal(connector, {
      accessToken: before?.access_token,
    })
    if (!renewed) {
      const err = new Error(
        'Another renewal of this connector is still running. Try again shortly.'
      )
      err.code = 'refresh_busy'
      throw err
    }
    if (renewed.accessToken) return renewed.accessToken
    until = renewed.until
  }
  try {
    return await renewWithLease(connector, fetch)
  } finally {
    await releaseRefreshLease(connector, until)
  }
}

/**
 * The access token to send now, refreshed first when it is about to expire.
 * Null when the connector has none.
 */
export async function currentAccessToken({ connector, credentials, fetch }) {
  const tokens = credentials?.tokens
  if (!tokens?.access_token) return null
  const expiresAt = connector.oauth?.expiresAt
  if (
    expiresAt &&
    tokens.refresh_token &&
    new Date(expiresAt).getTime() - Date.now() < REFRESH_AHEAD_MS
  ) {
    try {
      return await refreshTokens({ connector, fetch })
    } catch {
      return tokens.access_token
    }
  }
  return tokens.access_token
}

export default {
  discover,
  discoverProtectedResourceMetadata,
  discoverAuthorizationServerMetadata,
  resolveClient,
  startAuthorization,
  handleCallback,
  refreshTokens,
  currentAccessToken,
}
