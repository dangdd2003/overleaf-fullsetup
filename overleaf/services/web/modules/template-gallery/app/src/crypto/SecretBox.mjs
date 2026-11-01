import crypto from 'node:crypto'
import Settings from '@overleaf/settings'

/**
 * AES-256-GCM sealing for small secrets stored in MongoDB (session cookies,
 * outbound proxy credentials). Key: HKDF-SHA256 of security.sessionSecret,
 * or of a public fallback when no secret is configured.
 * Format: v2:<ivHex>:<authTagHex>:<ciphertextHex>
 */

const FALLBACK_SECRET = 'overleaf-ce-template-gallery-fallback-secret'

/**
 * True when an operator configured security.sessionSecret.
 */
export function hasConfiguredSecret() {
  return Boolean(Settings?.security?.sessionSecret || Settings?.sessionSecret)
}

function getSecret() {
  return (
    Settings?.security?.sessionSecret ||
    Settings?.sessionSecret ||
    FALLBACK_SECRET
  )
}

/**
 * Derive 256-bit AES key using HKDF-SHA256.
 */
function deriveKey(secret) {
  const salt = Buffer.from('template-gallery-session-v1', 'utf8')
  const info = Buffer.from('aes-256-gcm', 'utf8')
  return crypto.hkdfSync('sha256', secret, salt, info, 32)
}

/**
 * Encrypt a plaintext value using AES-256-GCM.
 * Output format: v2:<ivHex>:<authTagHex>:<ciphertextHex>
 */
export function encryptSecret(plaintext, secret = null) {
  if (typeof plaintext !== 'string' || !plaintext) {
    throw new Error('Plaintext cookie must be a non-empty string')
  }

  const key = deriveKey(secret || getSecret())
  const iv = crypto.randomBytes(12) // 96-bit IV recommended for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()

  return `v2:${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`
}

/**
 * Decrypt a payload produced by encryptSecret.
 */
export function decryptSecret(payload, secret = null) {
  if (typeof payload !== 'string' || !payload) {
    throw new Error('Payload must be a non-empty string')
  }

  const parts = payload.split(':')
  if (parts.length !== 4 || parts[0] !== 'v2') {
    throw new Error(
      `Invalid encrypted credential format: expected v2:... but got ${payload.slice(0, 10)}`
    )
  }

  const [, ivHex, authTagHex, ciphertextHex] = parts
  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(authTagHex, 'hex')
  const ciphertext = Buffer.from(ciphertextHex, 'hex')

  const key = deriveKey(secret || getSecret())
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)

  try {
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ])
    return decrypted.toString('utf8')
  } catch (err) {
    throw new Error(
      `Failed to decrypt credential payload: authentication tag mismatch or corrupted secret (${err.message})`
    )
  }
}

export default {
  hasConfiguredSecret,
  encryptSecret,
  decryptSecret,
}
