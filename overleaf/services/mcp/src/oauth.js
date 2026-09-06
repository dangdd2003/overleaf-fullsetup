import crypto from 'node:crypto'

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

/**
 * Build WWW-Authenticate challenge header value for OAuth 2.0 / RFC 9728.
 *
 * @param {{ resourceUri: string }} config
 * @param {string} [error]
 * @param {string} [description]
 * @returns {string}
 */
export function buildWwwAuthenticateHeader(config, error, description) {
  let resourceUri = config?.resourceUri || 'http://localhost:3050/mcp'
  if (!resourceUri.startsWith('http://') && !resourceUri.startsWith('https://')) {
    resourceUri = `http://${resourceUri}`
  }
  const metaUrl = new URL(
    '/.well-known/oauth-protected-resource',
    resourceUri
  ).toString()
  let header = `Bearer resource_metadata="${metaUrl}", scope="mcp"`
  if (error) {
    header += `, error="${error}"`
  }
  if (description) {
    header += `, error_description="${description}"`
  }
  return header
}

function base64urlDecode(str) {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/')
  while (base64.length % 4) {
    base64 += '='
  }
  return Buffer.from(base64, 'base64')
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

  async function getJwks() {
    const now = Date.now()
    if (cachedJwks && jwksExpiresAt > now) {
      return cachedJwks
    }

    if (fetchJwks) {
      cachedJwks = await fetchJwks()
      jwksExpiresAt = now + jwksTtlMs
      return cachedJwks
    }

    if (!jwksUrl) {
      throw new Error('Neither jwksUrl nor fetchJwks provided to JWT verifier')
    }

    const response = await fetchImpl(jwksUrl)
    if (!response.ok) {
      throw new Error(`Failed to fetch JWKS from ${jwksUrl}: ${response.status}`)
    }
    cachedJwks = await response.json()
    jwksExpiresAt = now + jwksTtlMs
    return cachedJwks
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

    const jwks = await getJwks()
    if (!jwks || !Array.isArray(jwks.keys) || jwks.keys.length === 0) {
      throw new Error('JWKS contains no keys')
    }

    let matchingKey = null
    if (header.kid) {
      matchingKey = jwks.keys.find(k => k.kid === header.kid)
      if (!matchingKey && cachedJwks) {
        cachedJwks = null
        const freshJwks = await getJwks()
        matchingKey = freshJwks.keys?.find(k => k.kid === header.kid)
      }
      if (!matchingKey) {
        throw new Error(`No matching key found in JWKS for kid "${header.kid}"`)
      }
    } else {
      matchingKey =
        jwks.keys.find(k => k.kty === 'RSA' && (k.alg === 'RS256' || !k.alg)) ||
        jwks.keys[0]
    }

    const publicKey = crypto.createPublicKey({
      key: matchingKey,
      format: 'jwk',
    })

    const signingInput = `${encodedHeader}.${encodedPayload}`
    const signature = base64urlDecode(encodedSignature)

    const verifier = crypto.createVerify('SHA256')
    verifier.update(signingInput)
    verifier.end()

    const isValid = verifier.verify(publicKey, signature)
    if (!isValid) {
      throw new Error('Invalid JWT signature')
    }

    let payload
    try {
      payload = JSON.parse(base64urlDecode(encodedPayload).toString('utf8'))
    } catch {
      throw new Error('Malformed JWT payload')
    }

    const now = Math.floor(Date.now() / 1000)

    if (payload.exp !== undefined && payload.exp < now) {
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

    if (payload.scope) {
      const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ') : payload.scope
      if (!scopes.includes('mcp')) {
        throw new Error('JWT missing required "mcp" scope')
      }
    }

    return payload
  }

  return {
    verifyToken,
  }
}
