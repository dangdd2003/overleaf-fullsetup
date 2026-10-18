import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import { base64url, getBaseUrl, mcpAudience } from './OAuth2Utils.mjs'

const DEFAULT_KEY_PATH = '/var/lib/overleaf/oauth2_key.pem'
const KEYRING_FILE_NAME = 'oauth2_keyring.json'

/*
 * Key set
 *
 * The primary key is the one that has always existed: MCP_OAUTH2_PRIVATE_KEY
 * (or mcpOauth2PrivateKey), or the key file. Single-key deployments never
 * need anything else.
 *
 * rotateSigningKey() generates another key and records it in a keyring file
 * next to the key file. The newest key signs. Every key that is not retired
 * stays in the JWKS, so tokens signed earlier still verify. Nothing retires a
 * key on a timer. Only retireSigningKey() does, and it refuses the key that is
 * currently signing.
 */

// Primary key, loaded once per process.
let cachedPrimary = null
// Ordered list of usable keys: primary first, then rotated keys oldest to
// newest. The last entry signs.
let cachedKeys = null

function keyFilePath() {
  return process.env.MCP_OAUTH2_KEY_FILE || DEFAULT_KEY_PATH
}

function keyringFilePath() {
  return path.join(path.dirname(keyFilePath()), KEYRING_FILE_NAME)
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
    `OAuth2 signing key file ${keyPath} cannot be used; set MCP_OAUTH2_KEY_FILE to a readable and writable path, or MCP_OAUTH2_PRIVATE_KEY`,
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
  const envPrivateKey =
    process.env.MCP_OAUTH2_PRIVATE_KEY || Settings.mcpOauth2PrivateKey

  let keypair
  if (envPrivateKey) {
    try {
      const privateKey = crypto.createPrivateKey(envPrivateKey)
      const publicKey = Settings.mcpOauth2PublicKey
        ? crypto.createPublicKey(Settings.mcpOauth2PublicKey)
        : crypto.createPublicKey(privateKey)
      keypair = { privateKey, publicKey }
    } catch (err) {
      throw new Error(
        'OAuth2 keypair is misconfigured: MCP_OAUTH2_PRIVATE_KEY / mcpOauth2PublicKey must be a valid PEM-encoded key',
        { cause: err }
      )
    }
  } else {
    keypair = loadOrCreateKeyFile(keyFilePath())
  }

  const kid = Settings.mcpOauth2KeyId || thumbprintKid(keypair.publicKey)
  return { ...keypair, kid }
}

// A keyring that cannot be parsed is an error, never an empty keyring. Treating
// it as empty would drop keys that outstanding tokens still need.
function readKeyringFile() {
  const filePath = keyringFilePath()
  let raw
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { keys: [], retiredKids: [] }
    }
    throw new Error(`OAuth2 keyring ${filePath} cannot be read`, { cause: err })
  }
  let data
  try {
    data = JSON.parse(raw)
  } catch (err) {
    throw new Error(`OAuth2 keyring ${filePath} is not valid JSON`, {
      cause: err,
    })
  }
  return {
    keys: Array.isArray(data.keys) ? data.keys : [],
    retiredKids: Array.isArray(data.retiredKids) ? data.retiredKids : [],
  }
}

// Rotation and retirement read the keyring, change it and write it back. Two
// processes doing that at once would each drop the other's change, so the
// sequence runs under an exclusive lockfile next to the keyring.
const KEYRING_LOCK_RETRY_MS = 25
const KEYRING_LOCK_ATTEMPTS = 400 // about 10 seconds in total
// A lock older than this belonged to a process that died holding it. The
// critical section takes milliseconds, so the window is generous.
const KEYRING_LOCK_STALE_MS = 30 * 1000

function removeIfStale(lockPath) {
  try {
    const { mtimeMs } = fs.statSync(lockPath)
    if (Date.now() - mtimeMs > KEYRING_LOCK_STALE_MS) {
      fs.rmSync(lockPath, { force: true })
      logger.warn({ lockPath }, 'removed stale OAuth2 keyring lock')
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
}

async function withKeyringLock(fn) {
  const lockPath = `${keyringFilePath()}.lock`
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 })
  for (let attempt = 0; ; attempt++) {
    try {
      // 'wx' is O_CREAT|O_EXCL: exactly one process can create the file.
      fs.closeSync(
        fs.openSync(lockPath, 'wx', 0o600)
      )
      break
    } catch (err) {
      if (err.code !== 'EEXIST') {
        throw new Error(`OAuth2 keyring lock ${lockPath} cannot be taken`, {
          cause: err,
        })
      }
      removeIfStale(lockPath)
      if (attempt >= KEYRING_LOCK_ATTEMPTS) {
        throw new Error(`OAuth2 keyring ${lockPath} is locked by another process`)
      }
      await delay(KEYRING_LOCK_RETRY_MS)
    }
  }
  try {
    return await fn()
  } finally {
    fs.rmSync(lockPath, { force: true })
  }
}

function writeKeyringFile(keyring) {
  const filePath = keyringFilePath()
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  // Write to a temporary file and rename, so a crash cannot leave a partial
  // keyring behind.
  const tmpPath = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify(keyring, null, 2), { mode: 0o600 })
  fs.renameSync(tmpPath, filePath)
}

function getPrimary() {
  if (!cachedPrimary) {
    cachedPrimary = loadPrimaryKey()
  }
  return cachedPrimary
}

// Rebuilt from the keyring file on demand. Other processes may have rotated.
function loadKeys() {
  const primary = getPrimary()
  const stored = readKeyringFile()
  const retired = new Set(stored.retiredKids)

  const keys = []
  if (!retired.has(primary.kid)) {
    keys.push({
      kid: primary.kid,
      privateKey: primary.privateKey,
      publicKey: primary.publicKey,
    })
  }
  for (const entry of stored.keys) {
    if (retired.has(entry.kid)) continue
    const privateKey = crypto.createPrivateKey(entry.privateKey)
    keys.push({
      kid: entry.kid,
      privateKey,
      publicKey: crypto.createPublicKey(privateKey),
    })
  }
  if (keys.length === 0) {
    throw new Error('OAuth2 has no active signing key')
  }
  return keys
}

function getKeys() {
  if (!cachedKeys) {
    cachedKeys = loadKeys()
  }
  return cachedKeys
}

function signingKey() {
  const keys = getKeys()
  return keys[keys.length - 1]
}

function findKeyByKid(kid) {
  return getKeys().find(key => key.kid === kid)
}

const OAuth2KeyManager = {
  _clearCache() {
    cachedPrimary = null
    cachedKeys = null
  },

  async getKeypair() {
    const { privateKey, publicKey, kid } = signingKey()
    return { privateKey, publicKey, kid }
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

  /**
   * Generate a new signing key and make it the one that signs. Keys that were
   * already published stay in the JWKS until retireSigningKey() removes them.
   *
   * @returns {Promise<{kid: string}>}
   */
  async rotateSigningKey() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
    })
    const kid = thumbprintKid(publicKey)

    await withKeyringLock(() => {
      // Read under the lock, so the change is made to the file as it is now.
      const stored = readKeyringFile()
      stored.keys.push({
        kid,
        createdAt: new Date().toISOString(),
        privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      })
      writeKeyringFile(stored)
      cachedKeys = null
    })
    logger.info({ kid }, 'rotated OAuth2 signing key')
    return { kid }
  },

  /**
   * Stop publishing a key. Tokens signed with it stop verifying, so call this
   * only after they have all expired or been revoked. The key that is
   * currently signing cannot be retired; rotate first.
   *
   * @param {string} kid
   * @returns {Promise<void>}
   */
  async retireSigningKey(kid) {
    const remainingKeys = await withKeyringLock(() => {
      // Validate against the keyring as it is now, not a cached copy.
      cachedKeys = null
      const keys = getKeys()
      if (!findKeyByKid(kid)) {
        throw new Error(`OAuth2 key ${kid} is not an active key`)
      }
      if (signingKey().kid === kid) {
        throw new Error(
          'Cannot retire the active signing key; call rotateSigningKey() first'
        )
      }

      const stored = readKeyringFile()
      stored.keys = stored.keys.filter(entry => entry.kid !== kid)
      if (!stored.retiredKids.includes(kid)) {
        stored.retiredKids.push(kid)
      }
      writeKeyringFile(stored)

      cachedKeys = null
      return keys.length - 1
    })
    logger.info({ kid, remainingKeys }, 'retired OAuth2 key')
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

// Tokens name their signing key by kid. A kid we do not know may belong to a
// key another process has just rotated in, so the keyring is re-read once
// before the token is refused. A token with no kid is checked against the
// signing key.
function findVerificationKey(kid) {
  if (!kid) {
    return signingKey().publicKey
  }
  let key = findKeyByKid(kid)
  if (!key) {
    cachedKeys = null
    key = findKeyByKid(kid)
  }
  if (!key) {
    throw new Error('Unknown JWT kid')
  }
  return key.publicKey
}

export default OAuth2KeyManager
