import { ConnectorCredentialModel, ConnectorModel } from './ConnectorModel.mjs'
import {
  seal,
  open,
  isStale,
  ConnectorSecretUnavailableError,
} from './ConnectorCrypto.mjs'

// The secrets of one connector, sealed per field and bound to the connector
// they belong to (see ConnectorCrypto). Nothing here is ever sent to the
// browser: the views carry only header names and `has…` flags.

const FIELDS = ['headers', 'clientSecret', 'tokens']

function contextFor(connectorId, field) {
  return `aiAssistConnectorCredentials:${connectorId}:${field}`
}

/**
 * `{ headers, clientSecret, tokens }` for a connector, each null when unset.
 * A field sealed under a secret the instance no longer has comes back null
 * and is listed in `lost`, so the caller can ask the user to sign in again.
 */
export async function loadCredentials(connectorId) {
  const doc = await ConnectorCredentialModel.findOne({
    connector_id: connectorId,
  })
    .lean()
    .exec()
  const result = { headers: null, clientSecret: null, tokens: null, lost: [] }
  if (!doc) return result
  const resealed = {}
  for (const field of FIELDS) {
    if (!doc[field]) continue
    try {
      result[field] = open(doc[field], contextFor(connectorId, field))
      if (isStale(doc[field])) {
        resealed[field] = seal(result[field], contextFor(connectorId, field))
      }
    } catch (err) {
      if (!(err instanceof ConnectorSecretUnavailableError)) throw err
      result.lost.push(field)
    }
  }
  // Reseal what a rotated session secret still opened, so the old secret can
  // be retired; drop what nothing opens any more, and tell the user why the
  // connector needs them again.
  const unset = Object.fromEntries(result.lost.map(field => [field, '']))
  if (result.lost.length) {
    await ConnectorModel.updateOne(
      { _id: connectorId },
      {
        $set: {
          status: 'needs_auth',
          lastError: {
            message: new ConnectorSecretUnavailableError().message,
            code: 'SECRET_UNAVAILABLE',
            at: new Date(),
          },
          ...(result.lost.includes('tokens')
            ? { 'oauth.hasRefreshToken': false, 'oauth.expiresAt': null }
            : {}),
          ...(result.lost.includes('headers') ? { headerNames: [] } : {}),
        },
      }
    ).exec()
  }
  if (Object.keys(resealed).length || result.lost.length) {
    await ConnectorCredentialModel.updateOne(
      { connector_id: connectorId },
      {
        ...(Object.keys(resealed).length ? { $set: resealed } : {}),
        ...(result.lost.length ? { $unset: unset } : {}),
      }
    ).exec()
  }
  return result
}

/**
 * Writes the given fields; `null` clears one, a field left out is kept.
 */
export async function saveCredentials(connectorId, userId, fields) {
  const $set = {}
  const $unset = {}
  for (const field of FIELDS) {
    if (!(field in fields)) continue
    const value = fields[field]
    const empty =
      value === null ||
      value === undefined ||
      (typeof value === 'object' && Object.keys(value).length === 0)
    if (empty) $unset[field] = ''
    else $set[field] = seal(value, contextFor(connectorId, field))
  }
  if (!Object.keys($set).length && !Object.keys($unset).length) return
  await ConnectorCredentialModel.updateOne(
    { connector_id: connectorId },
    {
      $set: { ...$set, user_id: userId },
      ...(Object.keys($unset).length ? { $unset } : {}),
    },
    { upsert: true }
  ).exec()
}

export async function deleteCredentials(connectorId) {
  await ConnectorCredentialModel.deleteOne({ connector_id: connectorId }).exec()
}

export default { loadCredentials, saveCredentials, deleteCredentials }
