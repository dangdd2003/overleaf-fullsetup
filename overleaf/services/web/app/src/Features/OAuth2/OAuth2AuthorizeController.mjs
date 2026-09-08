import crypto from 'node:crypto'
import Settings from '@overleaf/settings'
import SessionManager from '../Authentication/SessionManager.mjs'
import OAuth2RedirectUri from './OAuth2RedirectUri.mjs'
import { OauthApplication } from '../../models/OauthApplication.mjs'
import { OauthAuthorizationCode } from '../../models/OauthAuthorizationCode.mjs'

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

// Clients exist only once they have registered at /oauth/register; there are no
// pre-trusted client ids.
async function findClient(clientId) {
  const dbClient = await OauthApplication.findOne({ id: clientId })
  if (dbClient) {
    return {
      id: dbClient.id,
      name: dbClient.name,
      redirectUris: dbClient.redirectUris,
      grants: dbClient.grants,
      scopes: dbClient.scopes,
      isPublic: !dbClient.clientSecret,
      _id: dbClient._id,
    }
  }
  return null
}

function appendQueryParams(uri, params) {
  const url = new URL(uri)
  for (const [key, val] of Object.entries(params)) {
    if (val !== undefined && val !== null) {
      url.searchParams.set(key, val)
    }
  }
  return url.toString()
}

const OAuth2AuthorizeController = {
  async showAuthorizePage(req, res) {
    const {
      response_type,
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      state,
      scope,
    } = req.query || {}

    // Check client_id
    if (!client_id) {
      return res.status(400).json({
        error: 'invalid_request',
        error_description: 'client_id is required',
      })
    }

    const client = await findClient(client_id)
    if (!client) {
      return res.status(400).json({
        error: 'invalid_client',
        error_description: 'Unknown client_id',
      })
    }

    // Check redirect_uri
    if (!redirect_uri) {
      return res.status(400).json({
        error: 'invalid_request',
        error_description: 'redirect_uri is required',
      })
    }

    const isAllowed = OAuth2RedirectUri.isRedirectUriAllowed(
      client,
      redirect_uri
    )
    if (!isAllowed) {
      return res.status(400).json({
        error: 'invalid_request',
        error_description: 'redirect_uri is not allowed for this client',
      })
    }

    // Check response_type
    if (response_type !== 'code') {
      const redirectParams = {
        error: 'unsupported_response_type',
        error_description: 'Only response_type=code is supported',
      }
      if (state) redirectParams.state = state
      const redirectUrl = appendQueryParams(redirect_uri, redirectParams)
      return res.redirect(redirectUrl)
    }

    // Strict PKCE requirement (RFC 7636 / OAuth 2.1)
    if (!code_challenge) {
      const redirectParams = {
        error: 'invalid_request',
        error_description: 'code_challenge is required (PKCE)',
      }
      if (state) redirectParams.state = state
      const redirectUrl = appendQueryParams(redirect_uri, redirectParams)
      return res.redirect(redirectUrl)
    }

    if (code_challenge_method !== 'S256') {
      const redirectParams = {
        error: 'invalid_request',
        error_description: 'Only code_challenge_method=S256 is supported',
      }
      if (state) redirectParams.state = state
      const redirectUrl = appendQueryParams(redirect_uri, redirectParams)
      return res.redirect(redirectUrl)
    }

    // Check session login
    const user = SessionManager.getSessionUser(req.session)
    if (!user) {
      // Redirect to login with original URL for post-login return
      const originalUrl = req.originalUrl || req.url
      return res.redirect(`/login?redir=${encodeURIComponent(originalUrl)}`)
    }

    // Render consent page
    return res.render('oauth/authorize', {
      title: req.i18n.translate('oauth_authorization_request'),
      client,
      user,
      scope: scope || 'mcp',
      state,
      redirect_uri,
      response_type,
      code_challenge,
      code_challenge_method,
    })
  },

  async handleAuthorize(req, res) {
    const {
      action,
      client_id,
      redirect_uri,
      response_type,
      code_challenge,
      code_challenge_method,
      state,
      scope,
    } = req.body || {}

    // Check client_id
    if (!client_id) {
      return res.status(400).json({
        error: 'invalid_request',
        error_description: 'client_id is required',
      })
    }

    const client = await findClient(client_id)
    if (!client) {
      return res.status(400).json({
        error: 'invalid_client',
        error_description: 'Unknown client_id',
      })
    }

    // Check redirect_uri
    if (!redirect_uri) {
      return res.status(400).json({
        error: 'invalid_request',
        error_description: 'redirect_uri is required',
      })
    }

    const isAllowed = OAuth2RedirectUri.isRedirectUriAllowed(
      client,
      redirect_uri
    )
    if (!isAllowed) {
      return res.status(400).json({
        error: 'invalid_request',
        error_description: 'redirect_uri is not allowed for this client',
      })
    }

    // Handle user denial / cancellation
    if (action === 'deny') {
      const redirectParams = {
        error: 'access_denied',
        error_description: 'The user denied the authorization request',
      }
      if (state) redirectParams.state = state
      const redirectUrl = appendQueryParams(redirect_uri, redirectParams)
      return res.redirect(redirectUrl)
    }

    // Strict PKCE requirement
    if (!code_challenge || code_challenge_method !== 'S256') {
      const redirectParams = {
        error: 'invalid_request',
        error_description: 'code_challenge and S256 code_challenge_method are required',
      }
      if (state) redirectParams.state = state
      const redirectUrl = appendQueryParams(redirect_uri, redirectParams)
      return res.redirect(redirectUrl)
    }

    // Check user session
    const user = SessionManager.getSessionUser(req.session)
    if (!user) {
      const originalUrl = `/oauth/authorize?client_id=${encodeURIComponent(client_id)}&redirect_uri=${encodeURIComponent(redirect_uri)}&response_type=${encodeURIComponent(response_type || 'code')}&code_challenge=${encodeURIComponent(code_challenge)}&code_challenge_method=${encodeURIComponent(code_challenge_method)}${state ? `&state=${encodeURIComponent(state)}` : ''}${scope ? `&scope=${encodeURIComponent(scope)}` : ''}`
      return res.redirect(`/login?redir=${encodeURIComponent(originalUrl)}`)
    }

    // Generate authorization code: oac_<32 hex chars>
    const codeRandom = crypto.randomBytes(16).toString('hex')
    const authorizationCode = `oac_${codeRandom}`
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000) // 5 minutes TTL

    await OauthAuthorizationCode.create({
      authorizationCode,
      expiresAt,
      client_id: client.id,
      oauthApplication_id: client._id || null,
      redirectUri: redirect_uri,
      scope: scope || 'mcp',
      user_id: user._id,
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method,
    })

    const baseUrl = getBaseUrl(req)
    const redirectParams = {
      code: authorizationCode,
      iss: baseUrl,
    }
    if (state) {
      redirectParams.state = state
    }

    const redirectUrl = appendQueryParams(redirect_uri, redirectParams)
    return res.redirect(redirectUrl)
  },
}

export default OAuth2AuthorizeController
