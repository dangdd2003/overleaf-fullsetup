import { itemsCol, jobsCol, auditCol } from '../persistence/Collections.mjs'

/**
 * Handles cleanup when a user is deleted or expired from Overleaf CE.
 * Nulls user references across template gallery items, nulls userId in audit logs,
 * and cancels queued jobs requested by the deleted user.
 *
 * @param {string | number} userId
 * @returns {Promise<void>}
 */
export async function onUserRemoved(userId) {
  if (!userId) return

  const uidStr = String(userId)

  try {
    const items = await itemsCol()
    // Null out user references in templateGalleryItems
    await items.updateMany(
      {
        $or: [
          { createdBy: uidStr },
          { updatedBy: uidStr },
          { publishedBy: uidStr },
          { 'zip.uploadedBy': uidStr },
          { 'licence.ack.by': uidStr },
          { 'provenance.attestedBy': uidStr },
          { 'provenance.rightsAttestedBy': uidStr },
        ],
      },
      {
        $set: {
          updatedAt: new Date(),
        },
        $unset: {
          // MongoDB update unset or null fields matching userId
        },
      }
    )

    // Using explicit $set: null for user references
    await items.updateMany(
      { createdBy: uidStr },
      { $set: { createdBy: null, updatedAt: new Date() } }
    )
    await items.updateMany(
      { updatedBy: uidStr },
      { $set: { updatedBy: null, updatedAt: new Date() } }
    )
    await items.updateMany(
      { publishedBy: uidStr },
      { $set: { publishedBy: null, updatedAt: new Date() } }
    )
    await items.updateMany(
      { 'zip.uploadedBy': uidStr },
      { $set: { 'zip.uploadedBy': null, updatedAt: new Date() } }
    )
    await items.updateMany(
      { 'licence.ack.by': uidStr },
      { $set: { 'licence.ack.by': null, updatedAt: new Date() } }
    )
    await items.updateMany(
      { 'provenance.attestedBy': uidStr },
      { $set: { 'provenance.attestedBy': null, updatedAt: new Date() } }
    )
    await items.updateMany(
      { 'provenance.rightsAttestedBy': uidStr },
      { $set: { 'provenance.rightsAttestedBy': null, updatedAt: new Date() } }
    )
  } catch (_err) {
    // Continue cleanup for other collections
  }

  try {
    const audit = await auditCol()
    // Null out userId in templateGalleryAudit
    await audit.updateMany(
      { userId: uidStr },
      { $set: { userId: null } }
    )
  } catch (_err) {
    // Best-effort
  }

  try {
    const jobs = await jobsCol()
    // Cancel queued jobs requested by this user
    await jobs.updateMany(
      {
        state: 'queued',
        requestedBy: uidStr,
      },
      {
        $set: {
          state: 'cancelled',
          finishedAt: new Date(),
          'result.cancelledReason': 'user_deleted',
        },
        $unset: {
          dedupeKey: '',
        },
      }
    )
  } catch (_err) {
    // Best-effort
  }
}

export default {
  onUserRemoved,
}
