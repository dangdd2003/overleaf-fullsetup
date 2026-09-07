import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'

let cachedKeypair = null
const DEFAULT_KEY_PATH = '/var/lib/overleaf/oauth2_key.pem'

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input)
  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function base64urlDecode(str) {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/')
  while (base64.length % 4) {
    base64 += '='
  }
  return Buffer.from(base64, 'base64')
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

const OAuth2KeyManager = {
  _clearCache() {
    cachedKeypair = null
  },

  async getKeypair() {
    if (cachedKeypair) {
      return cachedKeypair
    }

    const kid = Settings.mcpOauth2KeyId || 'overleaf-mcp-key-1'
    const envPrivateKey =
      process.env.MCP_OAUTH2_PRIVATE_KEY || Settings.mcpOauth2PrivateKey

    if (envPrivateKey) {
      let privateKey, publicKey
      try {
        privateKey = crypto.createPrivateKey(envPrivateKey)
        publicKey = Settings.mcpOauth2PublicKey
          ? crypto.createPublicKey(Settings.mcpOauth2PublicKey)
          : crypto.createPublicKey(privateKey)
      } catch (err) {
        throw new Error(
          'OAuth2 keypair is misconfigured: MCP_OAUTH2_PRIVATE_KEY / mcpOauth2PublicKey must be a valid PEM-encoded key',
          { cause: err }
        )
      }
      cachedKeypair = { privateKey, publicKey, kid }
      return cachedKeypair
    }

    const keyPath = process.env.MCP_OAUTH2_KEY_FILE || DEFAULT_KEY_PATH
    try {
      if (fs.existsSync(keyPath)) {
        const pem = fs.readFileSync(keyPath, 'utf8')
        const privateKey = crypto.createPrivateKey(pem)
        const publicKey = crypto.createPublicKey(privateKey)
        cachedKeypair = { privateKey, publicKey, kid }
        logger.info(
          { kid, keyPath },
          'loaded persistent OAuth2 RS256 keypair from disk'
        )
        return cachedKeypair
      }
    } catch (err) {
      logger.warn({ err, keyPath }, 'failed to read OAuth2 key file from disk')
    }

    // Generate RSA 2048 keypair
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
    })

    // Attempt to persist to disk for durability across restarts
    try {
      const dir = path.dirname(keyPath)
      if (fs.existsSync(dir)) {
        const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' })
        fs.writeFileSync(keyPath, privatePem, { mode: 0o600 })
        logger.info(
          { kid, keyPath },
          'persisted new OAuth2 RS256 keypair to disk'
        )
      }
    } catch (err) {
      logger.warn(
        { err, keyPath },
        'could not persist OAuth2 keypair to disk; running in-memory'
      )
    }

    cachedKeypair = { privateKey, publicKey, kid }
    return cachedKeypair
  },

  async getJwks() {
    const { publicKey, kid } = await this.getKeypair()
    const jwk = publicKey.export({ format: 'jwk' })
    return {
      keys: [
        {
          kty: jwk.kty || 'RSA',
          use: 'sig',
          alg: 'RS256',
          kid,
          n: jwk.n,
          e: jwk.e,
        },
      ],
    }
  },

  async signJwt(payload) {
    const { privateKey, kid } = await this.getKeypair()
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
   * that `iss`/`aud` match this instance's canonical MCP resource — closes
   * the audience-confusion gap now that the token endpoint accepts a
   * caller-supplied `resource` (RFC 8707): a token minted for a different
   * resource must not be accepted here just because it carries the `mcp`
   * scope and a valid signature.
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

    const { publicKey } = await this.getKeypair()
    const verify = crypto.createVerify('SHA256')
    verify.update(signingInput)
    verify.end()

    const isValid = verify.verify(publicKey, signature)
    if (!isValid) {
      throw new Error('Invalid JWT signature')
    }

    const payload = JSON.parse(base64urlDecode(encodedPayload).toString('utf8'))
    const now = Math.floor(Date.now() / 1000)
    if (typeof payload.exp !== 'number') {
      throw new Error('JWT exp claim is missing or invalid')
    }
    if (payload.exp < now) {
      throw new Error('JWT has expired')
    }
    if (payload.nbf && payload.nbf > now) {
      throw new Error('JWT is not yet active')
    }

    if (req) {
      const expectedIssuer = getBaseUrl(req)
      const expectedAudience = `${expectedIssuer}/mcp`
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

export default OAuth2KeyManager
