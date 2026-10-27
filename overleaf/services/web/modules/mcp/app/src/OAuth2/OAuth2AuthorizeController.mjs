import crypto from 'node:crypto'
import SessionManager from '../../../../../app/src/Features/Authentication/SessionManager.mjs'
import OAuth2RedirectUri from './OAuth2RedirectUri.mjs'
import {
  getBaseUrl,
  hashToken,
  isValidS256Challenge,
  normalizeScope,
} from './OAuth2Utils.mjs'
import { OauthApplication } from '../../../../../app/src/models/OauthApplication.mjs'
import { OauthAuthorizationCode } from '../../../../../app/src/models/OauthAuthorizationCode.mjs'
import { getToolCategories } from './OAuth2ToolCatalog.mjs'

// Clients exist only once they have registered at /oauth/register; there are no
// pre-trusted client ids.
async function findClient(clientId) {
  // Express parses `client_id[$ne]=x` into an object. Passing that to Mongo
  // would match an arbitrary client, so only plain strings are looked up.
  if (typeof clientId !== 'string') return null
  const dbClient = await OauthApplication.findOne({ id: clientId })
  if (!dbClient) return null
  return {
    id: dbClient.id,
    name: dbClient.name,
    redirectUris: dbClient.redirectUris,
    _id: dbClient._id,
  }
}

/**
 * Check client_id and redirect_uri. Errors here are shown on this server, not
 * redirected, because the redirect target cannot be trusted yet.
 *
 * @returns {Promise<{client: object}|{error: {status: number, body: object}}>}
 */
async function resolveClientAndRedirect(clientId, redirectUri) {
  if (!clientId) {
    return {
      error: {
        status: 400,
        body: {
          error: 'invalid_request',
          error_description: 'client_id is required',
        },
      },
    }
  }
  const client = await findClient(clientId)
  if (!client) {
    return {
      error: {
        status: 400,
        body: { error: 'invalid_client', error_description: 'Unknown client_id' },
      },
    }
  }
  if (!redirectUri) {
    return {
      error: {
        status: 400,
        body: {
          error: 'invalid_request',
          error_description: 'redirect_uri is required',
        },
      },
    }
  }
  if (!OAuth2RedirectUri.isRedirectUriAllowed(client, redirectUri)) {
    return {
      error: {
        status: 400,
        body: {
          error: 'invalid_request',
          error_description: 'redirect_uri is not allowed for this client',
        },
      },
    }
  }
  return { client }
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

// Send an error back to the client's (already validated) redirect_uri.
function redirectWithError(res, redirectUri, state, error, errorDescription) {
  const params = { error, error_description: errorDescription }
  if (state) params.state = state
  return res.redirect(appendQueryParams(redirectUri, params))
}

// What the user is approving the code for. Shown on the consent page so a
// phishing client that redirects elsewhere is visible before approval.
function redirectDestination(redirectUri) {
  const url = new URL(redirectUri)
  // Native apps may use a custom scheme with no host (RFC 8252 §7.1).
  return url.host ? `${url.protocol}//${url.host}` : url.protocol
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

    const { client, error } = await resolveClientAndRedirect(
      client_id,
      redirect_uri
    )
    if (error) {
      return res.status(error.status).json(error.body)
    }

    // Check response_type
    if (response_type !== 'code') {
      return redirectWithError(
        res,
        redirect_uri,
        state,
        'unsupported_response_type',
        'Only response_type=code is supported'
      )
    }

    // Strict PKCE requirement (RFC 7636 / OAuth 2.1). Checked here as well as on
    // the consent POST, so a bad challenge fails before the user reaches consent.
    if (!code_challenge) {
      return redirectWithError(
        res,
        redirect_uri,
        state,
        'invalid_request',
        'code_challenge is required (PKCE)'
      )
    }

    if (code_challenge_method !== 'S256') {
      return redirectWithError(
        res,
        redirect_uri,
        state,
        'invalid_request',
        'Only code_challenge_method=S256 is supported'
      )
    }

    if (!isValidS256Challenge(code_challenge)) {
      return redirectWithError(
        res,
        redirect_uri,
        state,
        'invalid_request',
        'code_challenge must be a 43-character base64url S256 value'
      )
    }

    const grantedScope = normalizeScope(scope)
    if (grantedScope === null) {
      return redirectWithError(
        res,
        redirect_uri,
        state,
        'invalid_scope',
        'Supported scopes are mcp and optional offline_access'
      )
    }

    // Check session login
    const user = SessionManager.getSessionUser(req.session)
    if (!user) {
      // Redirect to login with original URL for post-login return
      const originalUrl = req.originalUrl || req.url
      return res.redirect(`/login?redir=${encodeURIComponent(originalUrl)}`)
    }

    const toolCategories = await getToolCategories()

    return res.render('oauth/authorize', {
      title:
        req.i18n?.translate?.('oauth_authorization_request') ||
        'OAuth Authorization Request',
      client,
      user,
      scope: grantedScope,
      redirectDestination: redirectDestination(redirect_uri),
      state,
      redirect_uri,
      response_type,
      code_challenge,
      code_challenge_method,
      toolCategories,
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

    const { client, error } = await resolveClientAndRedirect(
      client_id,
      redirect_uri
    )
    if (error) {
      return res.status(error.status).json(error.body)
    }

    // Handle user denial / cancellation
    if (action === 'deny') {
      return redirectWithError(
        res,
        redirect_uri,
        state,
        'access_denied',
        'The user denied the authorization request'
      )
    }
    // Only the consent form's approve button approves. Anything else is refused
    // rather than read as approval.
    if (action !== 'authorize') {
      return redirectWithError(
        res,
        redirect_uri,
        state,
        'invalid_request',
        'unknown authorization action'
      )
    }

    // Strict PKCE requirement. An S256 challenge is 43 base64url characters.
    if (
      !isValidS256Challenge(code_challenge) ||
      code_challenge_method !== 'S256'
    ) {
      return redirectWithError(
        res,
        redirect_uri,
        state,
        'invalid_request',
        'code_challenge and S256 code_challenge_method are required'
      )
    }

    const grantedScope = normalizeScope(scope)
    if (grantedScope === null) {
      return redirectWithError(
        res,
        redirect_uri,
        state,
        'invalid_scope',
        'Supported scopes are mcp and optional offline_access'
      )
    }

    // Check user session
    const user = SessionManager.getSessionUser(req.session)
    if (!user) {
      const query = new URLSearchParams({
        client_id,
        redirect_uri,
        response_type: response_type || 'code',
        code_challenge,
        code_challenge_method,
      })
      if (state) query.set('state', state)
      if (scope) query.set('scope', scope)
      return res.redirect(
        `/login?redir=${encodeURIComponent(`/oauth/authorize?${query}`)}`
      )
    }

    // Generate authorization code: oac_<32 hex chars>. Only its hash is stored,
    // so a database read cannot be replayed at the token endpoint.
    const authorizationCode = `oac_${crypto.randomBytes(16).toString('hex')}`
    await OauthAuthorizationCode.create({
      authorizationCode: hashToken(authorizationCode),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5 minutes TTL
      client_id: client.id,
      oauthApplication_id: client._id,
      redirectUri: redirect_uri,
      scope: grantedScope,
      user_id: user._id,
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method,
    })

    const redirectParams = {
      code: authorizationCode,
      iss: getBaseUrl(req),
    }
    if (state) {
      redirectParams.state = state
    }
    return res.redirect(appendQueryParams(redirect_uri, redirectParams))
  },
}

export default OAuth2AuthorizeController
