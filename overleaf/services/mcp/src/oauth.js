import crypto from 'node:crypto'
import { DEFAULT_RESOURCE_URI } from './config.js'

const JWKS_TIMEOUT_MS = 10000
// Forced JWKS refreshes (an unknown kid) run at most once per window, so an
// unauthenticated token with a made-up kid cannot make every request fetch.
const MIN_FORCED_REFRESH_MS = 30000

/**
 * Build RFC 9728 Protected Resource Metadata for the MCP endpoint.
 *
 * @param {{ resourceUri: string, authServerUrl: string }} config
 * @returns {object}
 */
export function getProtectedResourceMetadata(config) {
  const resourceUri = config.resourceUri
  const authServerUrl = config.authServerUrl
  return {
    resource: resourceUri,
    authorization_servers: [authServerUrl],
    scopes_supported: ['mcp'],
    bearer_methods_supported: ['header'],
    resource_documentation: `${authServerUrl}/help`,
  }
}

export const PROTECTED_RESOURCE_WELL_KNOWN_PATH =
  '/.well-known/oauth-protected-resource'

/**
 * Build the RFC 9728 Protected Resource Metadata URL for a resource identifier.
 *
 * Per RFC 9728 §3.1 the well-known suffix is inserted *between* the host and
 * the resource path, so `https://host/mcp` resolves to
 * `https://host/.well-known/oauth-protected-resource/mcp`. Appending the suffix
 * to the path is the OIDC convention and is not a valid form here.
 *
 * @param {string} resourceUri
 * @returns {string}
 */
export function buildProtectedResourceMetadataUrl(resourceUri) {
  const url = new URL(resourceUri)
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${PROTECTED_RESOURCE_WELL_KNOWN_PATH}${path}`
}

/**
 * Build WWW-Authenticate challenge header value for OAuth 2.0 / RFC 9728.
 *
 * @param {{ resourceUri: string }} config
 * @param {string} [error]
 * @param {string} [description]
 * @returns {string}
 */
export function buildWwwAuthenticateHeader(config, error, description) {
  let resourceUri = config?.resourceUri || DEFAULT_RESOURCE_URI
  if (!resourceUri.startsWith('http://') && !resourceUri.startsWith('https://')) {
    resourceUri = `http://${resourceUri}`
  }
  const metaUrl = buildProtectedResourceMetadataUrl(resourceUri)
  let header = `Bearer resource_metadata="${metaUrl}", scope="mcp"`
  if (error) {
    // error is an RFC 6750 token; anything else could break the quoted header.
    header += `, error="${String(error).replace(/[^A-Za-z0-9_.-]/g, '')}"`
  }
  if (description) {
    // Verifier messages quote claim values, and a raw quote would end the
    // quoted-string early and leave the challenge unparseable for the client.
    const safe = String(description).replace(/["\\]/g, "'")
    header += `, error_description="${safe}"`
  }
  return header
}

/**
 * Read a JWT `scope` claim, which is either a space-separated string or an
 * array. Anything else, including a missing claim, grants no scopes.
 *
 * @param {unknown} scope
 * @returns {string[]}
 */
export function parseScopes(scope) {
  if (typeof scope === 'string') {
    return scope.split(' ').filter(Boolean)
  }
  return Array.isArray(scope) ? scope : []
}

function base64urlDecode(str) {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/')
  while (base64.length % 4) {
    base64 += '='
  }
  return Buffer.from(base64, 'base64')
}

/**
 * Pick the JWK for a token. A kid must match exactly. Without one, the first
 * RSA key is used, as before.
 */
function findKey(jwks, kid) {
  const keys = Array.isArray(jwks?.keys) ? jwks.keys : []
  if (kid) {
    return keys.find(k => k.kid === kid) || null
  }
  return (
    keys.find(k => k.kty === 'RSA' && (k.alg === 'RS256' || !k.alg)) ||
    keys[0] ||
    null
  )
}

// Parsed KeyObjects, keyed by the JWK object they came from. A refreshed JWKS
// holds new objects, so entries for retired keys are collected with them.
const publicKeys = new WeakMap()

function publicKeyOf(jwk) {
  let publicKey = publicKeys.get(jwk)
  if (!publicKey) {
    publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' })
    publicKeys.set(jwk, publicKey)
  }
  return publicKey
}

function verifyRs256(jwk, signingInput, signature) {
  // A kid can name a key of another type; only an RSA key may verify RS256.
  if (jwk.kty !== 'RSA') return false
  const publicKey = publicKeyOf(jwk)
  const verifier = crypto.createVerify('SHA256')
  verifier.update(signingInput)
  verifier.end()
  return verifier.verify(publicKey, signature)
}

/**
 * Create a stateless RS256 JWT verifier with cached JWKS support.
 *
 * @param {object} options
 * @param {string} [options.jwksUrl]
 * @param {Function} [options.fetchJwks]
 * @param {string} [options.resourceUri] Expected audience
 * @param {string} [options.issuer] Expected issuer
 * @param {Function} [options.fetchImpl] Fetch implementation
 * @param {number} [options.jwksTtlMs=3600000] In-memory cache TTL for JWKS (default: 1 hour)
 * @returns {{ verifyToken: (jwtString: string) => Promise<object> }}
 */
export function createJwtVerifier({
  jwksUrl,
  fetchJwks,
  resourceUri,
  issuer,
  fetchImpl = globalThis.fetch,
  jwksTtlMs = 3600000,
} = {}) {
  let cachedJwks = null
  let jwksExpiresAt = 0
  let lastForcedRefreshAt = 0
  let pendingLoad = null

  // Bounded so a stalled auth server cannot hold every request open. Any
  // failure to load the key set (refused connection, timeout, error status,
  // unparseable body) is the auth server being unavailable, not a bad token,
  // so every one of them is tagged JWKS_UNAVAILABLE.
  async function fetchKeySet() {
    if (fetchJwks) return fetchJwks()

    if (!jwksUrl) {
      throw new Error('Neither jwksUrl nor fetchJwks provided to JWT verifier')
    }

    try {
      const response = await fetchImpl(jwksUrl, { signal: AbortSignal.timeout(JWKS_TIMEOUT_MS) })
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        throw new Error(`status ${response.status}`)
      }
      return await response.json()
    } catch (cause) {
      const err = new Error(`Failed to fetch JWKS from ${jwksUrl}: ${cause?.message ?? cause}`)
      err.code = 'JWKS_UNAVAILABLE'
      err.cause = cause
      throw err
    }
  }

  // One load at a time: requests that arrive while the key set is being fetched
  // wait for that fetch rather than each starting another.
  function loadJwks() {
    pendingLoad ??= fetchKeySet()
      .then(jwks => {
        cachedJwks = jwks
        jwksExpiresAt = Date.now() + jwksTtlMs
        return jwks
      })
      .finally(() => {
        pendingLoad = null
      })
    return pendingLoad
  }

  async function getJwks() {
    if (cachedJwks && jwksExpiresAt > Date.now()) {
      return cachedJwks
    }
    return loadJwks()
  }

  // The window is tracked by time, not by whether a key set is cached, so a
  // failed fetch cannot reset it. Within the window the cached set is used.
  async function refreshJwks() {
    const now = Date.now()
    if (cachedJwks && now - lastForcedRefreshAt < MIN_FORCED_REFRESH_MS) {
      return cachedJwks
    }
    lastForcedRefreshAt = now
    return loadJwks()
  }

  async function verifyToken(jwtString) {
    if (typeof jwtString !== 'string') {
      throw new Error('JWT must be a string')
    }

    const parts = jwtString.split('.')
    if (parts.length !== 3) {
      throw new Error('Malformed JWT: must have 3 dot-separated segments')
    }

    const [encodedHeader, encodedPayload, encodedSignature] = parts

    let header
    try {
      header = JSON.parse(base64urlDecode(encodedHeader).toString('utf8'))
    } catch {
      throw new Error('Malformed JWT header')
    }

    if (!header || header.alg !== 'RS256') {
      throw new Error(`Unsupported JWT algorithm: ${header?.alg || 'unknown'}, expected RS256`)
    }

    let jwks = await getJwks()
    if (!jwks || !Array.isArray(jwks.keys) || jwks.keys.length === 0) {
      throw new Error('JWKS contains no keys')
    }

    // The JWKS is cached per process. A token signed with a key that appeared
    // after the cache was filled must not be rejected until the TTL runs out,
    // so refetch on a kid miss and, below, on a signature failure.
    let refreshed = false
    let matchingKey = findKey(jwks, header.kid)
    if (!matchingKey) {
      jwks = await refreshJwks()
      refreshed = true
      matchingKey = findKey(jwks, header.kid)
      if (!matchingKey) {
        throw new Error(`No matching key found in JWKS for kid "${header.kid}"`)
      }
    }

    const signingInput = `${encodedHeader}.${encodedPayload}`
    const signature = base64urlDecode(encodedSignature)

    let isValid = verifyRs256(matchingKey, signingInput, signature)
    if (!isValid && header.kid && !refreshed) {
      // A rotation can reuse the kid of the key it replaces. Refetch once
      // before rejecting. Only a token that names a kid triggers this, so a
      // forged token without one cannot force a refetch on every request.
      const freshKey = findKey(await refreshJwks(), header.kid)
      isValid = Boolean(freshKey) && verifyRs256(freshKey, signingInput, signature)
    }
    if (!isValid) {
      throw new Error('Invalid JWT signature')
    }

    let payload
    try {
      payload = JSON.parse(base64urlDecode(encodedPayload).toString('utf8'))
    } catch {
      throw new Error('Malformed JWT payload')
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Malformed JWT payload')
    }

    const now = Math.floor(Date.now() / 1000)

    // Every access token expires (web sets a one-hour exp). A token without a
    // numeric exp was not minted under that policy, so it is refused.
    if (typeof payload.exp !== 'number') {
      throw new Error('JWT exp claim is missing or not a number')
    }
    if (payload.exp < now) {
      throw new Error('JWT has expired')
    }

    if (payload.nbf !== undefined && payload.nbf > now) {
      throw new Error('JWT is not yet active (nbf in future)')
    }

    if (issuer && payload.iss !== issuer) {
      throw new Error(`JWT issuer mismatch: expected "${issuer}", got "${payload.iss}"`)
    }

    if (resourceUri) {
      const audList = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
      if (!audList.includes(resourceUri)) {
        throw new Error(`JWT audience mismatch: expected "${resourceUri}", got "${payload.aud}"`)
      }
    }

    // A missing scope claim grants nothing. Web always mints one, so a token
    // without it was not issued by web.
    if (!parseScopes(payload.scope).includes('mcp')) {
      const err = new Error('JWT missing required "mcp" scope')
      err.code = 'insufficient_scope'
      throw err
    }

    return payload
  }

  return {
    verifyToken,
  }
}
