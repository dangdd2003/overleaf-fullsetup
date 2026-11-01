import { logWarn } from '../observability/Log.mjs'
import {
  decryptSecret,
  encryptSecret,
  hasConfiguredSecret,
} from './SecretBox.mjs'

/**
 * Storage and encryption for upstream Overleaf Cloud session credentials.
 * Implements AES-256-GCM encryption with HKDF key derivation.
 * Format: v2:<ivHex>:<authTagHex>:<ciphertextHex>
 */

const CREDENTIAL_DOC_ID = 'credentials'

/**
 * Warns once at startup when credentials would be encrypted with the built-in
 * fallback secret, whose value is public. Encryption is unchanged; the
 * operator fix is to set security.sessionSecret.
 *
 * @returns {boolean} true when the warning was logged
 */
export function warnIfFallbackSecret() {
  if (hasConfiguredSecret()) return false
  logWarn('template_gallery_fallback_secret_in_use', {
    hint: 'security.sessionSecret is not set; template gallery credentials use a public fallback key',
  })
  return true
}

warnIfFallbackSecret()

// The cipher lives in SecretBox; these names are kept for existing callers.
export const encryptCookie = encryptSecret
export const decryptCookie = decryptSecret

/**
 * Save encrypted session cookie into MongoDB templateGalleryConfig collection.
 */
export async function saveSessionCredential(collection, cookieValue) {
  if (!collection) throw new Error('MongoDB collection required')
  const encrypted = encryptSecret(cookieValue)
  const now = new Date()

  await collection.updateOne(
    { _id: CREDENTIAL_DOC_ID },
    {
      $set: {
        encryptedCookie: encrypted,
        status: 'VALID',
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
 * Returns null if no credential exists, if marked invalid, or if the stored
 * cookie cannot be decrypted (it is then marked invalid).
 * `encryptedCookie` is the stored ciphertext; pass it to markSessionInvalid so
 * a cookie re-saved in the meantime is not invalidated. Never log or return it.
 */
export async function getDecryptedSessionCredential(collection) {
  if (!collection) throw new Error('MongoDB collection required')
  const doc = await collection.findOne({ _id: CREDENTIAL_DOC_ID })
  if (!doc || !doc.encryptedCookie) return null
  if (doc.status === 'INVALID') return null

  let cookie
  try {
    cookie = decryptSecret(doc.encryptedCookie)
  } catch (err) {
    // Unreadable after a SESSION_SECRET rotation or damaged ciphertext: mark it
    // INVALID so callers fall through to the next source instead of throwing.
    // The filter leaves alone a cookie that was re-saved in the meantime.
    try {
      await collection.updateOne(
        { _id: CREDENTIAL_DOC_ID, encryptedCookie: doc.encryptedCookie },
        {
          $set: {
            status: 'INVALID',
            invalidatedAt: new Date(),
            invalidReason: 'decrypt_failed',
          },
        }
      )
    } catch (markErr) {
      logWarn('template_gallery_session_mark_invalid_failed', {
        err: markErr.message,
      })
    }
    logWarn('template_gallery_session_undecryptable', { err: err.message })
    return null
  }
  return {
    cookie,
    encryptedCookie: doc.encryptedCookie,
    status: doc.status,
    updatedAt: doc.updatedAt,
  }
}

/**
 * Admin view of the stored session cookie. Never returns the cookie itself.
 *
 * @returns {Promise<{ configured: boolean, updatedAt: string|null, invalid: boolean }>}
 */
export async function getStatus(collection) {
  if (!collection) throw new Error('MongoDB collection required')
  const doc = await collection.findOne(
    { _id: CREDENTIAL_DOC_ID },
    { projection: { status: 1, updatedAt: 1, encryptedCookie: 1 } }
  )
  const configured = Boolean(doc?.encryptedCookie)
  return {
    configured,
    updatedAt:
      configured && doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
    invalid: configured && doc.status === 'INVALID',
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
 * Optional encryptedCookie filter prevents invalidating credentials updated
 * by an admin while an acquisition attempt was in-flight.
 */
export async function markSessionInvalid(
  collection,
  reason = 'auth_failed',
  encryptedCookie = null
) {
  if (!collection) throw new Error('MongoDB collection required')
  const filter = { _id: CREDENTIAL_DOC_ID }
  if (encryptedCookie) filter.encryptedCookie = encryptedCookie
  await collection.updateOne(filter, {
    $set: {
      status: 'INVALID',
      invalidatedAt: new Date(),
      invalidReason: reason,
    },
  })
}

/**
 * Clear session credential completely from MongoDB.
 */
export async function clearSessionCredential(collection) {
  if (!collection) throw new Error('MongoDB collection required')
  await collection.deleteOne({ _id: CREDENTIAL_DOC_ID })
}

export default {
  warnIfFallbackSecret,
  encryptCookie,
  decryptCookie,
  saveSessionCredential,
  getDecryptedSessionCredential,
  getSessionCredentialState,
  getStatus,
  markSessionInvalid,
  clearSessionCredential,
}
