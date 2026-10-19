import crypto from 'node:crypto'
import mongoose from '../../../../../app/src/infrastructure/Mongoose.mjs'
import OAuth2KeyManager from './OAuth2KeyManager.mjs'
import {
  base64url,
  getBaseUrl,
  hashToken,
  normalizeScope,
  MCP_SCOPE,
  mcpAudience,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_IDLE_MS,
} from './OAuth2Utils.mjs'
import { OauthAuthorizationCode } from '../../../../../app/src/models/OauthAuthorizationCode.mjs'
import { OauthAccessToken } from '../../../../../app/src/models/OauthAccessToken.mjs'

const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/

// Access tokens are short-lived JWTs (ACCESS_TOKEN_TTL_SECONDS). Clients renew
// A refresh token stays valid until it has gone REFRESH_TOKEN_IDLE_MS without
// use; each refresh resets that window. A grant that goes idle is dropped,
// and the user must authorize again.
//
// The grant records no accessTokenExpiresAt: the JWT carries its own exp, and
// upstream's TTL on that field would delete the grant, refresh token included,
// a day after the first access token expired.

// Idle expiry of a refresh token issued or rotated now.
function refreshExpiresAt(now = Date.now()) {
  return new Date(now + REFRESH_TOKEN_IDLE_MS)
}

// Grants made before the idle expiry was recorded count from creation.
function refreshIsIdleExpired(grant) {
  const expiresAt = grant.refreshTokenExpiresAt
    ? new Date(grant.refreshTokenExpiresAt).getTime()
    : new Date(grant.createdAt).getTime() + REFRESH_TOKEN_IDLE_MS
  // A missing date gives NaN, which counts as expired rather than valid.
  return !(expiresAt > Date.now())
}

function newRefreshToken() {
  return `oar_${crypto.randomBytes(32).toString('hex')}`
}

/**
 * Sign an RS256 access token for a grant. `grant_id` ties the JWT to its
 * OauthAccessToken record, so revoking the grant also revokes every access
 * token minted from it.
 */
async function mintAccessToken({
  baseUrl,
  userId,
  clientId,
  audience,
  scope,
  grantId,
}) {
  const jti = `jwt_${crypto.randomBytes(16).toString('hex')}`
  const nowSeconds = Math.floor(Date.now() / 1000)
  const accessToken = await OAuth2KeyManager.signJwt({
    iss: baseUrl,
    sub: userId ? userId.toString() : '',
    aud: audience,
    client_id: clientId,
    scope,
    iat: nowSeconds,
    exp: nowSeconds + ACCESS_TOKEN_TTL_SECONDS,
    grant_id: grantId.toString(),
    jti,
  })
  return { accessToken, jti }
}

function tokenResponse({ accessToken, scope, refreshToken }) {
  const body = {
    access_token: accessToken,
    token_type: 'Bearer',
    scope,
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
  }
  if (refreshToken !== undefined) {
    body.refresh_token = refreshToken
  }
  return body
}

function error(res, status, errorCode, errorDescription) {
  return res.status(status).json({
    error: errorCode,
    error_description: errorDescription,
  })
}

function findGrantByRefreshHash(hash) {
  return OauthAccessToken.findOne({ refreshToken: hash })
}

/**
 * Rotate `presentedHash` to `newHash` on the grant state that was read.
 * Atomic update pins the presented token to prevent race conditions.
 */
function rotateRefreshToken(grant, presentedHash, newHash) {
  const now = Date.now()
  const expiry = {
    refreshTokenExpiresAt: refreshExpiresAt(now),
    expiresAt: null,
    lastUsedAt: new Date(now),
  }
  const options = { projection: { _id: 1 } }

  return OauthAccessToken.findOneAndUpdate(
    {
      _id: grant._id,
      refreshToken: presentedHash,
    },
    {
      $set: {
        ...expiry,
        refreshToken: newHash,
      },
      // Grants written before accessTokenExpiresAt was dropped lose it here
      $unset: { accessTokenExpiresAt: '' },
    },
    options
  )
}

const OAuth2TokenController = {
  verifyPkce(codeVerifier, codeChallenge) {
    if (
      !codeVerifier ||
      !codeChallenge ||
      typeof codeVerifier !== 'string' ||
      typeof codeChallenge !== 'string' ||
      !PKCE_VERIFIER_PATTERN.test(codeVerifier)
    ) {
      return false
    }
    const computed = base64url(
      crypto.createHash('sha256').update(codeVerifier).digest()
    )
    if (computed.length !== codeChallenge.length) return false
    return crypto.timingSafeEqual(
      Buffer.from(computed),
      Buffer.from(codeChallenge)
    )
  },

  async token(req, res) {
    const {
      grant_type,
      client_id,
      code,
      redirect_uri,
      code_verifier,
      refresh_token,
      resource,
      scope,
    } = req.body || {}

    // Parameters are used as query values and as hash input, so an object
    // (e.g. `code[$ne]=x`) must be refused before it reaches Mongo.
    if (
      (client_id != null && typeof client_id !== 'string') ||
      (resource != null && typeof resource !== 'string') ||
      (redirect_uri != null && typeof redirect_uri !== 'string')
    ) {
      return error(res, 400, 'invalid_request', 'parameters must be strings')
    }

    if (grant_type === 'authorization_code') {
      return OAuth2TokenController._authorizationCodeGrant(req, res, {
        client_id,
        code,
        redirect_uri,
        code_verifier,
        resource,
      })
    }

    if (grant_type === 'refresh_token') {
      return OAuth2TokenController._refreshTokenGrant(req, res, {
        client_id,
        refresh_token,
        resource,
        scope,
      })
    }

    return error(
      res,
      400,
      'unsupported_grant_type',
      'grant_type must be authorization_code or refresh_token'
    )
  },

  async _authorizationCodeGrant(
    req,
    res,
    { client_id, code, redirect_uri, code_verifier, resource }
  ) {
    if (
      typeof code !== 'string' ||
      typeof code_verifier !== 'string' ||
      !code ||
      !code_verifier
    ) {
      return error(
        res,
        400,
        'invalid_request',
        'code and code_verifier are required'
      )
    }

    // The code is consumed atomically, so it can be redeemed only once. Codes
    // are stored hashed, so the lookup is by hash. The code is 128 random bits,
    // so a lookup on its hash leaks nothing a timing attack could use.
    const authRecord = await OauthAuthorizationCode.findOneAndDelete({
      authorizationCode: hashToken(code),
    })
    if (!authRecord) {
      return error(
        res,
        400,
        'invalid_grant',
        'Authorization code is invalid or already used'
      )
    }

    if (new Date(authRecord.expiresAt).getTime() < Date.now()) {
      return error(res, 400, 'invalid_grant', 'Authorization code has expired')
    }

    // Both are required per RFC 6749 §4.1.3. Omitting either must not skip
    // the check.
    if (
      !client_id ||
      !redirect_uri ||
      authRecord.client_id !== client_id ||
      authRecord.redirectUri !== redirect_uri
    ) {
      return error(
        res,
        400,
        'invalid_grant',
        'client_id or redirect_uri mismatch'
      )
    }

    if (
      !OAuth2TokenController.verifyPkce(code_verifier, authRecord.codeChallenge)
    ) {
      return error(res, 400, 'invalid_grant', 'PKCE verification failed')
    }

    const baseUrl = getBaseUrl(req)
    const audience = authRecord.resource || mcpAudience(baseUrl)
    // A caller may name only the granted audience, otherwise a token could be
    // minted for any resource.
    if (resource && resource !== audience) {
      return error(
        res,
        400,
        'invalid_target',
        'Requested resource does not match granted audience'
      )
    }

    // The grant id is generated up front so the JWT can carry it.
    const grantId = new mongoose.Types.ObjectId()
    const scope = authRecord.scope || MCP_SCOPE
    const { accessToken, jti } = await mintAccessToken({
      baseUrl,
      userId: authRecord.user_id,
      clientId: client_id,
      audience,
      scope,
      grantId,
    })
    const refreshTokenValue = newRefreshToken()

    // Only the refresh token hash is persisted. The raw value is returned to
    // the client once and never stored.
    const createdAt = new Date()
    await OauthAccessToken.create({
      _id: grantId,
      accessToken: jti,
      accessTokenPartial: jti.slice(0, 8),
      refreshToken: hashToken(refreshTokenValue),
      refreshTokenExpiresAt: refreshExpiresAt(createdAt.getTime()),
      user_id: authRecord.user_id,
      client_id,
      audience,
      scope,
      createdAt,
    })

    return res.json(
      tokenResponse({ accessToken, scope, refreshToken: refreshTokenValue })
    )
  },

  async _refreshTokenGrant(
    req,
    res,
    { client_id, refresh_token, resource, scope }
  ) {
    if (typeof refresh_token !== 'string' || !refresh_token) {
      return error(res, 400, 'invalid_request', 'refresh_token is required')
    }
    if (scope !== undefined && normalizeScope(scope) === null) {
      return error(res, 400, 'invalid_scope', 'Only scope=mcp is supported')
    }

    const presentedHash = hashToken(refresh_token)
    const grant = await findGrantByRefreshHash(presentedHash)
    if (!grant) {
      return error(res, 400, 'invalid_grant', 'Invalid refresh token')
    }

    // client_id is required for public clients per RFC 6749 §6. Omitting it
    // must not skip the check.
    if (!client_id || grant.client_id !== client_id) {
      return error(
        res,
        400,
        'invalid_grant',
        'client_id mismatch for refresh token'
      )
    }

    // A refresh token unused for the idle window is refused. The user must
    // authorize again. The grant is left for the expiry index to remove.
    if (refreshIsIdleExpired(grant)) {
      return error(
        res,
        400,
        'invalid_grant',
        'Refresh token has expired; authorize the client again'
      )
    }

    const baseUrl = getBaseUrl(req)
    const audience = grant.audience || mcpAudience(baseUrl)
    if (resource && resource !== audience) {
      return error(
        res,
        400,
        'invalid_target',
        'Requested resource does not match granted audience'
      )
    }

    // Mint before rotating. If signing fails, the client keeps a token that
    // still works. The grant's client, user, audience and scope do not change
    // on rotation, so the access token is the same whichever read it came from.
    const grantId = grant._id
    const grantedScope = grant.scope || MCP_SCOPE
    const { accessToken } = await mintAccessToken({
      baseUrl,
      userId: grant.user_id,
      clientId: grant.client_id,
      audience,
      scope: grantedScope,
      grantId,
    })

    const refreshTokenValue = newRefreshToken()
    const newHash = hashToken(refreshTokenValue)
    const rotated = await rotateRefreshToken(grant, presentedHash, newHash)
    if (!rotated) {
      return error(
        res,
        400,
        'invalid_grant',
        'Refresh token has already been used; the grant has been revoked'
      )
    }

    return res.json(
      tokenResponse({
        accessToken,
        scope: grantedScope,
        refreshToken: refreshTokenValue,
      })
    )
  },
}

export default OAuth2TokenController
