import { auditCol } from './Collections.mjs'

/**
 * Records an administrative audit trail event.
 * Never throws an error so audit logging failures cannot break calling workflows.
 *
 * @param {string} action
 * @param {{ itemId?: string | null, userId?: string | null, detail?: string }} [options]
 * @returns {Promise<void>}
 */
export async function record(action, { itemId = null, userId = null, detail = '' } = {}) {
  try {
    const col = await auditCol()
    const doc = {
      action: String(action),
      itemId: itemId ? String(itemId) : null,
      userId: userId ? String(userId) : null,
      detail: String(detail || '').slice(0, 500),
      at: new Date(),
    }
    await col.insertOne(doc)
  } catch (_err) {
    // Audit logging is best-effort and must never throw
  }
}

export default {
  record,
}
