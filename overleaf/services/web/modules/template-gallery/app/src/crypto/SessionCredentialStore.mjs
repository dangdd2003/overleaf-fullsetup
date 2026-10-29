import crypto from 'node:crypto'
import Settings from '@overleaf/settings'

/**
 * Storage and encryption for upstream Overleaf Cloud session credentials.
 * Implements AES-256-GCM encryption with HKDF key derivation.
 * Format: v2:<ivHex>:<authTagHex>:<ciphertextHex>
 */

const FALLBACK_SECRET = 'overleaf-ce-template-gallery-fallback-secret'
const CREDENTIAL_DOC_ID = 'credentials'

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
 * Encrypt a plaintext cookie value using AES-256-GCM.
 * Output format: v2:<ivHex>:<authTagHex>:<ciphertextHex>
 */
export function encryptCookie(plaintext, secret = null) {
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
 * Decrypt an encrypted cookie payload.
 */
export function decryptCookie(payload, secret = null) {
  if (typeof payload !== 'string' || !payload) {
    throw new Error('Payload must be a non-empty string')
  }

  const parts = payload.split(':')
  if (parts.length !== 4 || parts[0] !== 'v2') {
    throw new Error(`Invalid encrypted credential format: expected v2:... but got ${payload.slice(0, 10)}`)
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
    throw new Error(`Failed to decrypt credential payload: authentication tag mismatch or corrupted secret (${err.message})`)
  }
}

/**
 * Save encrypted session cookie into MongoDB templateGalleryConfig collection.
 */
export async function saveSessionCredential(collection, cookieValue, userId = null) {
  if (!collection) throw new Error('MongoDB collection required')
  const encrypted = encryptCookie(cookieValue)
  const now = new Date()

  await collection.updateOne(
    { _id: CREDENTIAL_DOC_ID },
    {
      $set: {
        encryptedCookie: encrypted,
        status: 'VALID',
        updatedBy: userId,
        updatedAt: now,
        invalidatedAt: null,
        invalidReason: null,
      },
      $setOnInsert: {
        createdAt: now,
      },
    },
    { upsert: true }
  )

  return { status: 'VALID', updatedAt: now }
}

/**
 * Retrieve and decrypt session cookie from MongoDB.
 * Returns null if no credential exists or if marked invalid.
 */
export async function getDecryptedSessionCredential(collection) {
  if (!collection) throw new Error('MongoDB collection required')
  const doc = await collection.findOne({ _id: CREDENTIAL_DOC_ID })
  if (!doc || !doc.encryptedCookie) return null
  if (doc.status === 'INVALID') return null

  const cookie = decryptCookie(doc.encryptedCookie)
  return {
    cookie,
    status: doc.status,
    updatedAt: doc.updatedAt,
    updatedBy: doc.updatedBy,
  }
}

/**
 * Read the credential status without decrypting it. Returns null when no
 * usable (VALID) credential is stored.
 */
export async function getSessionCredentialState(collection) {
  if (!collection) throw new Error('MongoDB collection required')
  const doc = await collection.findOne(
    { _id: CREDENTIAL_DOC_ID },
    { projection: { status: 1, updatedAt: 1, encryptedCookie: 1 } }
  )
  if (!doc?.encryptedCookie || doc.status === 'INVALID') return null
  return { status: doc.status, updatedAt: doc.updatedAt || null }
}

/**
 * Mark active session credential invalid due to 401/403/captcha.
 */
export async function markSessionInvalid(collection, reason = 'auth_failed') {
  if (!collection) throw new Error('MongoDB collection required')
  await collection.updateOne(
    { _id: CREDENTIAL_DOC_ID },
    {
      $set: {
        status: 'INVALID',
        invalidatedAt: new Date(),
        invalidReason: reason,
      },
    }
  )
}

/**
 * Clear session credential completely from MongoDB.
 */
export async function clearSessionCredential(collection) {
  if (!collection) throw new Error('MongoDB collection required')
  await collection.deleteOne({ _id: CREDENTIAL_DOC_ID })
}

export default {
  encryptCookie,
  decryptCookie,
  saveSessionCredential,
  getDecryptedSessionCredential,
  getSessionCredentialState,
  markSessionInvalid,
  clearSessionCredential,
}
