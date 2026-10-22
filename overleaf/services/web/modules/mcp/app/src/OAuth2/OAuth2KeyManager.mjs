import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import logger from '@overleaf/logger'
import { base64url, getBaseUrl, mcpAudience } from './OAuth2Utils.mjs'

const KEY_PATH = '/var/lib/overleaf/oauth2_key.pem'

/*
 * Key set
 *
 * The signing key is loaded from the persistent key file on disk (or created on
 * first boot). A single-key deployment uses this RS256 keypair for signing and
 * verifying tokens.
 */

// Primary key, loaded once per process.
let cachedPrimary = null
// Ordered list of usable keys: primary key only.
let cachedKeys = null
// Tests point the key file at a temporary directory. Production never sets it.
let keyPathOverride = null

function keyFilePath() {
  return keyPathOverride || KEY_PATH
}

/**
 * RFC 7638 thumbprint of the RSA public key, used as the default `kid`.
 * A replaced key therefore always gets a new kid, so validators that cache
 * JWKS by kid refetch instead of checking new signatures against a stale key.
 */
function thumbprintKid(publicKey) {
  const { e, n } = publicKey.export({ format: 'jwk' })
  const canonical = JSON.stringify({ e, kty: 'RSA', n })
  return base64url(crypto.createHash('sha256').update(canonical).digest())
}

function keyFileError(keyPath, err) {
  return new Error(
    `OAuth2 signing key file ${keyPath} cannot be used; it must be readable and writable by this process`,
    { cause: err }
  )
}

function readKeyFile(keyPath) {
  try {
    const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'))
    return { privateKey, publicKey: crypto.createPublicKey(privateKey) }
  } catch (err) {
    throw keyFileError(keyPath, err)
  }
}

/**
 * Load the signing key from disk, or generate and persist one.
 *
 * Failing here is deliberate. A key that is only held in memory is lost on
 * the next restart, which invalidates every token minted so far. Loading an
 * existing file that cannot be parsed must not fall through to generation,
 * because the new key would overwrite the one that signed outstanding tokens.
 */
function loadOrCreateKeyFile(keyPath) {
  if (fs.existsSync(keyPath)) {
    logger.info({ keyPath }, 'loaded persistent OAuth2 RS256 keypair from disk')
    return readKeyFile(keyPath)
  }

  const keypair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  try {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 })
  } catch (err) {
    throw keyFileError(keyPath, err)
  }
  try {
    // 'wx' fails if another process created the file first. Reading it back
    // then gives every process the same key.
    fs.writeFileSync(
      keyPath,
      keypair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      { mode: 0o600, flag: 'wx' }
    )
  } catch (err) {
    if (err.code === 'EEXIST') {
      return readKeyFile(keyPath)
    }
    throw keyFileError(keyPath, err)
  }
  logger.info({ keyPath }, 'persisted new OAuth2 RS256 keypair to disk')
  return keypair
}

function loadPrimaryKey() {
  const keypair = loadOrCreateKeyFile(keyFilePath())
  return { ...keypair, kid: thumbprintKid(keypair.publicKey) }
}

function getPrimary() {
  if (!cachedPrimary) {
    cachedPrimary = loadPrimaryKey()
  }
  return cachedPrimary
}

function loadKeys() {
  return [getPrimary()]
}

function getKeys() {
  if (!cachedKeys) {
    cachedKeys = loadKeys()
  }
  return cachedKeys
}

function signingKey() {
  return getPrimary()
}

function findKeyByKid(kid) {
  return getKeys().find(key => key.kid === kid)
}

const OAuth2KeyManager = {
  _clearCache() {
    cachedPrimary = null
    cachedKeys = null
  },

  _setKeyPathForTests(keyPath) {
    keyPathOverride = keyPath
  },

  async getJwks() {
    return {
      keys: getKeys().map(({ kid, publicKey }) => {
        const jwk = publicKey.export({ format: 'jwk' })
        return {
          kty: jwk.kty || 'RSA',
          use: 'sig',
          alg: 'RS256',
          kid,
          n: jwk.n,
          e: jwk.e,
        }
      }),
    }
  },

  async signJwt(payload) {
    const { privateKey, kid } = signingKey()
    const header = {
      alg: 'RS256',
      typ: 'JWT',
      kid,
    }
    const encodedHeader = base64url(JSON.stringify(header))
    const encodedPayload = base64url(JSON.stringify(payload))
    const signingInput = `${encodedHeader}.${encodedPayload}`

    const sign = crypto.createSign('SHA256')
    sign.update(signingInput)
    sign.end()
    const signature = base64url(sign.sign(privateKey))

    return `${signingInput}.${signature}`
  },

  /**
   * Verifies signature, exp and nbf. When `req` is given, also enforces
   * that `iss`/`aud` match this instance's canonical MCP resource. That closes
   * the audience-confusion gap left by the token endpoint's caller-supplied
   * `resource` (RFC 8707): a token minted for a different resource must not be
   * accepted here just because it carries the `mcp` scope and a valid
   * signature.
   */
  async verifyJwt(jwtString, req) {
    if (typeof jwtString !== 'string') {
      throw new Error('JWT must be a string')
    }
    const parts = jwtString.split('.')
    if (parts.length !== 3) {
      throw new Error('Malformed JWT')
    }
    const [encodedHeader, encodedPayload, encodedSignature] = parts
    const signingInput = `${encodedHeader}.${encodedPayload}`
    const signature = base64urlDecode(encodedSignature)

    // Only RS256 is ever issued. Refusing other algorithms up front means the
    // header can never select a verification mode.
    const header = JSON.parse(base64urlDecode(encodedHeader).toString('utf8'))
    if (header.alg !== 'RS256') {
      throw new Error('Unsupported JWT alg')
    }

    const publicKey = findVerificationKey(header.kid)
    const verify = crypto.createVerify('SHA256')
    verify.update(signingInput)
    verify.end()

    const isValid = verify.verify(publicKey, signature)
    if (!isValid) {
      throw new Error('Invalid JWT signature')
    }

    const payload = JSON.parse(base64urlDecode(encodedPayload).toString('utf8'))
    const now = Math.floor(Date.now() / 1000)
    // Every access token expires. A token without a numeric exp was not minted
    // under the current policy, so it is refused.
    if (typeof payload.exp !== 'number') {
      throw new Error('JWT exp claim is missing or not a number')
    }
    if (payload.exp < now) {
      throw new Error('JWT has expired')
    }
    if (payload.nbf && payload.nbf > now) {
      throw new Error('JWT is not yet active')
    }

    if (req) {
      const expectedIssuer = getBaseUrl(req)
      const expectedAudience = mcpAudience(expectedIssuer)
      if (payload.iss !== expectedIssuer) {
        throw new Error('Invalid JWT issuer')
      }
      const audiences = Array.isArray(payload.aud)
        ? payload.aud
        : [payload.aud]
      if (!audiences.includes(expectedAudience)) {
        throw new Error('Invalid JWT audience')
      }
    }

    return payload
  },
}

function base64urlDecode(str) {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/')
  while (base64.length % 4) {
    base64 += '='
  }
  return Buffer.from(base64, 'base64')
}

// Tokens name their signing key by kid. A token with no kid is checked against
// the primary signing key.
function findVerificationKey(kid) {
  if (!kid) {
    return signingKey().publicKey
  }
  const key = findKeyByKid(kid)
  if (!key) {
    throw new Error('Unknown JWT kid')
  }
  return key.publicKey
}

export default OAuth2KeyManager
