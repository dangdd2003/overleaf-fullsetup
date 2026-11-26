import crypto from 'node:crypto'
import Settings from '@overleaf/settings'

// Connector secrets are sealed with AES-256-GCM under a key derived from the
// instance's session secret (OVERLEAF_SESSION_SECRET), so there is nothing
// extra to configure. Each value is bound to the document and field it was
// written for (the GCM additional data), so a ciphertext copied into another
// connector does not decrypt. The key id in front lets a rotated secret
// (security.sessionSecretFallback) still open what the old one sealed.
//
//   v2:<keyId>:<iv>:<authTag>:<ciphertext>   (hex)
//
// The key id is an HMAC of the key, not a hash of it: a plain SHA-256 of the
// key let anyone who can read the rows test guesses of the secret against a
// fingerprint. Seals written before this (keyId = SHA-256 of the key) still
// open: `open` tries every configured key when no id matches.

const SALT = Buffer.from('overleaf-ai-connectors-salt', 'utf8')
const INFO = Buffer.from('connectors-encryption-key', 'utf8')
const VERSION = 'v2'

export class ConnectorSecretUnavailableError extends Error {
  constructor() {
    super(
      'Saved credentials can no longer be decrypted: the instance session secret changed. Sign in or enter them again.'
    )
    this.name = 'ConnectorSecretUnavailableError'
    this.code = 'SECRET_UNAVAILABLE'
  }
}

function keyFor(secret) {
  const key = Buffer.from(
    crypto.hkdfSync(
      'sha256',
      Buffer.from(String(secret), 'utf8'),
      SALT,
      INFO,
      32
    )
  )
  const id = crypto
    .createHmac('sha256', key)
    .update('ai-assist-key-id')
    .digest('hex')
    .slice(0, 8)
  // The id the seals of earlier versions carry
  const legacyId = crypto.createHash('sha256').update(key).digest('hex').slice(0, 8)
  return { id, legacyId, key }
}

const keyCache = new Map()

/** The current key first, then any the instance is rotating away from. */
function keys() {
  const security = Settings.security || {}
  const secrets = [
    security.sessionSecret,
    security.sessionSecretUpcoming,
    security.sessionSecretFallback,
  ].filter(Boolean)
  if (secrets.length === 0) {
    throw new Error('The instance has no session secret to seal credentials')
  }
  // Forget the keys of secrets the instance has rotated out of its settings
  for (const secret of keyCache.keys()) {
    if (!secrets.includes(secret)) keyCache.delete(secret)
  }
  return secrets.map(secret => {
    if (!keyCache.has(secret)) keyCache.set(secret, keyFor(secret))
    return keyCache.get(secret)
  })
}

function aadFor(context) {
  return Buffer.from(String(context || ''), 'utf8')
}

/** Seals `value` (any JSON) for the document field named by `context`. */
export function seal(value, context) {
  if (value === undefined || value === null) return null
  const { id, key } = keys()[0]
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aadFor(context))
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ])
  return [
    VERSION,
    id,
    iv.toString('hex'),
    cipher.getAuthTag().toString('hex'),
    ciphertext.toString('hex'),
  ].join(':')
}

/**
 * Opens what `seal` wrote for the same `context`. Null for an empty field;
 * throws ConnectorSecretUnavailableError when no configured key opens it.
 */
export function open(sealed, context) {
  if (!sealed || typeof sealed !== 'string') return null
  const parts = sealed.split(':')
  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new ConnectorSecretUnavailableError()
  }
  const [, keyId, ivHex, tagHex, cipherHex] = parts
  if (
    !/^[0-9a-f]{24}$/i.test(ivHex) ||
    !/^[0-9a-f]{32}$/i.test(tagHex)
  ) {
    throw new ConnectorSecretUnavailableError()
  }
  const iv = Buffer.from(ivHex, 'hex')
  const tag = Buffer.from(tagHex, 'hex')
  const ciphertext = Buffer.from(cipherHex, 'hex')
  const all = keys()
  const matching = all.filter(k => k.id === keyId || k.legacyId === keyId)
  // An id that matches no key (or a key that changed) still gets every key tried
  const candidates = matching.length ? matching : all
  for (const { key } of candidates) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, {
        authTagLength: 16,
      })
      decipher.setAAD(aadFor(context))
      decipher.setAuthTag(tag)
      const text = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString('utf8')
      return JSON.parse(text)
    } catch {}
  }
  throw new ConnectorSecretUnavailableError()
}

/** True when `sealed` was written with a key other than the current one. */
export function isStale(sealed) {
  if (!sealed || typeof sealed !== 'string') return false
  return sealed.split(':')[1] !== keys()[0].id
}
