import crypto from 'node:crypto'
import Settings from '@overleaf/settings'
import OAuth2KeyManager from './OAuth2KeyManager.mjs'
import { OauthAuthorizationCode } from '../../models/OauthAuthorizationCode.mjs'
import { OauthAccessToken } from '../../models/OauthAccessToken.mjs'

function base64url(buf) {
  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function getBaseUrl(req) {
  if (Settings.siteUrl) {
    return Settings.siteUrl.replace(/\/+$/, '')
  }
  const host = req?.get ? req.get('host') : req?.headers?.host
  if (host) {
    const protocol = req?.protocol || 'http'
    return `${protocol}://${host}`
  }
  return 'http://localhost:3000'
}

const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/

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
    } = req.body || {}

    if (grant_type === 'authorization_code') {
      if (!code || !code_verifier) {
        return res.status(400).json({
          error: 'invalid_request',
          error_description: 'code and code_verifier are required',
        })
      }

      // 1. Fetch authorization code atomically to prevent double-spending
      const authRecord = await OauthAuthorizationCode.findOneAndDelete({
        authorizationCode: code,
      })
      if (!authRecord) {
        return res.status(400).json({
          error: 'invalid_grant',
          error_description: 'Authorization code is invalid or already used',
        })
      }

      // 2. Expiration check
      if (new Date(authRecord.expiresAt).getTime() < Date.now()) {
        return res.status(400).json({
          error: 'invalid_grant',
          error_description: 'Authorization code has expired',
        })
      }

      // 4. Client & Redirect URI match (both required per RFC 6749 §4.1.3 —
      // omitting either must not skip the check)
      if (
        !client_id ||
        !redirect_uri ||
        authRecord.client_id !== client_id ||
        authRecord.redirectUri !== redirect_uri
      ) {
        return res.status(400).json({
          error: 'invalid_grant',
          error_description: 'client_id or redirect_uri mismatch',
        })
      }

      // 5. PKCE Verification (Mandatory in OAuth 2.1)
      if (
        !OAuth2TokenController.verifyPkce(
          code_verifier,
          authRecord.codeChallenge
        )
      ) {
        return res.status(400).json({
          error: 'invalid_grant',
          error_description: 'PKCE verification failed',
        })
      }

      // 6. Mint RS256 JWT Access Token
      const baseUrl = getBaseUrl(req)
      const audience = resource || authRecord.resource || `${baseUrl}/mcp`
      const now = Math.floor(Date.now() / 1000)
      const expiresIn = 3600 // 1 hour

      const payload = {
        iss: baseUrl,
        sub: authRecord.user_id ? authRecord.user_id.toString() : '',
        aud: audience,
        client_id: client_id || authRecord.client_id,
        scope: authRecord.scope || 'mcp',
        iat: now,
        exp: now + expiresIn,
        jti: `jwt_${crypto.randomBytes(16).toString('hex')}`,
      }

      const accessToken = await OAuth2KeyManager.signJwt(payload)
      const refreshTokenValue = `oar_${crypto.randomBytes(32).toString('hex')}`
      const refreshToken = hashToken(refreshTokenValue)

      // Store token record in DB. Only the hash is persisted; the raw
      // refresh token is returned to the client once and never stored.
      await OauthAccessToken.create({
        accessToken: payload.jti,
        accessTokenPartial: payload.jti.slice(0, 8),
        refreshToken,
        refreshTokenExpiresAt: new Date(Date.now() + 30 * 86400 * 1000),
        user_id: authRecord.user_id,
        client_id: payload.client_id,
        audience: payload.aud,
        scope: authRecord.scope || 'mcp',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + expiresIn * 1000),
      })

      return res.json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: expiresIn,
        refresh_token: refreshTokenValue,
        scope: authRecord.scope || 'mcp',
      })
    }

    if (grant_type === 'refresh_token') {
      if (!refresh_token) {
        return res.status(400).json({
          error: 'invalid_request',
          error_description: 'refresh_token is required',
        })
      }

      const tokenRecord = await OauthAccessToken.findOne({
        refreshToken: hashToken(refresh_token),
      })
      if (!tokenRecord) {
        return res.status(400).json({
          error: 'invalid_grant',
          error_description: 'Invalid refresh token',
        })
      }

      if (
        tokenRecord.refreshTokenExpiresAt &&
        new Date(tokenRecord.refreshTokenExpiresAt).getTime() < Date.now()
      ) {
        return res.status(400).json({
          error: 'invalid_grant',
          error_description: 'Refresh token has expired',
        })
      }

      // client_id is required for public clients per RFC 6749 §6 — omitting
      // it must not skip the check.
      if (!client_id || tokenRecord.client_id !== client_id) {
        return res.status(400).json({
          error: 'invalid_grant',
          error_description: 'client_id mismatch for refresh token',
        })
      }

      const baseUrl = getBaseUrl(req)
      const targetAudience = tokenRecord.audience || `${baseUrl}/mcp`
      if (resource && resource !== targetAudience) {
        return res.status(400).json({
          error: 'invalid_target',
          error_description: 'Requested resource does not match granted audience',
        })
      }

      const now = Math.floor(Date.now() / 1000)
      const expiresIn = 3600

      const payload = {
        iss: baseUrl,
        sub: tokenRecord.user_id ? tokenRecord.user_id.toString() : '',
        aud: targetAudience,
        client_id: tokenRecord.client_id,
        scope: tokenRecord.scope || 'mcp',
        iat: now,
        exp: now + expiresIn,
        jti: `jwt_${crypto.randomBytes(16).toString('hex')}`,
      }

      const newAccessToken = await OAuth2KeyManager.signJwt(payload)
      const newRefreshToken = `oar_${crypto.randomBytes(32).toString('hex')}`

      tokenRecord.refreshToken = hashToken(newRefreshToken)
      tokenRecord.refreshTokenExpiresAt = new Date(
        Date.now() + 30 * 86400 * 1000
      )
      tokenRecord.expiresAt = new Date(Date.now() + expiresIn * 1000)
      await tokenRecord.save()

      return res.json({
        access_token: newAccessToken,
        token_type: 'Bearer',
        expires_in: expiresIn,
        refresh_token: newRefreshToken,
        scope: tokenRecord.scope || 'mcp',
      })
    }

    return res.status(400).json({
      error: 'unsupported_grant_type',
      error_description: 'grant_type must be authorization_code or refresh_token',
    })
  },
}

export default OAuth2TokenController
