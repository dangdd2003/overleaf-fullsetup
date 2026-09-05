import logger from '@overleaf/logger'
import Features from '../../infrastructure/Features.mjs'
import { db, ObjectId } from '../../infrastructure/mongodb.mjs'
import GoogleDriveSyncManager from './GoogleDriveSyncManager.mjs'
import ProjectEntityHandler from '../Project/ProjectEntityHandler.mjs'

/**
 * Consumes Overleaf's entity-mutation hooks and records which paths need
 * pushing to Google Drive.
 *
 * This runs synchronously on the user's edit path, so it does no Drive I/O
 * and at most one indexed Mongo read plus one write. The actual upload happens
 * later, in GoogleDriveOutboundWorker.
 *
 * Three hooks are needed, because they cover disjoint ground:
 *
 *   - fileModified  - binary files added, replaced or uploaded
 *   - entityDeleted - any deletion
 *   - docModified   - doc *content* edits
 *
 * The third is easy to overlook and essential. Every fileModified fire site in
 * ProjectEntityUpdateHandler operates on a fileRef; editing main.tex in the
 * editor never reaches ProjectEntityUpdateHandler at all - the content flows
 * browser -> real-time -> document-updater -> Redis, and only reaches web when
 * document-updater flushes it back through the private API, which is where
 * docModified fires. Without it, ordinary doc edits would never sync.
 */

function _toObjectId(id) {
  if (!id) return null
  if (typeof id === 'object' && id._bsontype === 'ObjectID') return id
  if (typeof id === 'string' && ObjectId?.isValid?.(id)) {
    try {
      return new ObjectId(id)
    } catch {
      return id
    }
  }
  return id
}

/**
 * Records a single pending change, or returns early if this change should not
 * be synced at all.
 *
 * @param {string|ObjectId} projectId
 * @param {string} rawPath
 * @param {object} entry
 * @param {string} source
 * @returns {Promise<void>}
 */
async function _queueChange(projectId, rawPath, entry, source) {
  if (!Features.hasFeature('google-drive-sync')) {
    return
  }

  // Loop guard: without this, applying an inbound Drive change would
  // immediately queue an outbound push of the very same content.
  if (source === 'google-drive') {
    return
  }

  if (!projectId || !rawPath) {
    return
  }

  const cleanPath = GoogleDriveSyncManager.normalizePath(rawPath)
  if (!cleanPath || GoogleDriveSyncManager.isIgnoredFile(cleanPath)) {
    return
  }

  const projectObjectId = _toObjectId(projectId)
  const state = await db.googleDriveProjectStates.findOne(
    { projectId: projectObjectId },
    { projection: { _id: 1 } }
  )
  if (!state) {
    // Project isn't linked to Drive; nothing to track.
    return
  }

  const key = GoogleDriveSyncManager.encodePathKey(cleanPath)
  const now = new Date()

  await db.googleDriveProjectStates.updateOne(
    { projectId: projectObjectId },
    {
      $set: {
        [`pendingChanges.${key}`]: { ...entry, queuedAt: now, attempts: 0 },
        outboundDirtyAt: now,
      },
    }
  )
}

const GoogleDriveHookHandler = {
  /**
   * Hook: a doc or file was added, replaced, or upserted in Overleaf.
   *
   * @param {string|ObjectId} projectId
   * @param {string|ObjectId} entityId
   * @param {string} filePath
   * @param {string} source
   * @returns {Promise<void>}
   */
  async onFileModified(projectId, entityId, filePath, source) {
    try {
      await _queueChange(
        projectId,
        filePath,
        { op: 'upsert', entityId, entityType: 'file' },
        source
      )
    } catch (err) {
      // Never let sync bookkeeping fail the user's edit.
      logger.error(
        { err, projectId, filePath },
        'GoogleDriveSync: failed to queue outbound change'
      )
    }
  },

  /**
   * Hook: an entity was deleted from Overleaf.
   *
   * @param {string|ObjectId} projectId
   * @param {string} filePath
   * @param {string} entityType
   * @param {string} source
   * @returns {Promise<void>}
   */
  async onEntityDeleted(projectId, filePath, entityType, source) {
    try {
      await _queueChange(
        projectId,
        filePath,
        { op: 'delete', entityId: null, entityType },
        source
      )
    } catch (err) {
      logger.error(
        { err, projectId, filePath },
        'GoogleDriveSync: failed to queue outbound delete'
      )
    }
  },

  /**
   * Hook: document-updater flushed a doc's content back to web.
   *
   * Unlike the other two hooks this carries no `source`, so the loop guard
   * cannot apply: an inbound Drive apply eventually flushes and lands here
   * too. GoogleDriveOutboundWorker closes that loop by comparing the doc's
   * content hash against fileMap before pushing, and skipping when equal.
   *
   * @param {string|ObjectId} projectId
   * @param {string|ObjectId} docId
   * @param {object} ranges unused
   * @param {Date} lastUpdatedAt unused
   * @returns {Promise<void>}
   */
  async onDocModified(projectId, docId, ranges, lastUpdatedAt) {
    try {
      if (!Features.hasFeature('google-drive-sync') || !projectId || !docId) {
        return
      }

      // Check the project is linked *before* resolving the path: path
      // resolution loads the entire project document, which is far too
      // expensive to do on every doc flush for projects that aren't synced.
      const state = await db.googleDriveProjectStates.findOne(
        { projectId: _toObjectId(projectId) },
        { projection: { _id: 1 } }
      )
      if (!state) {
        return
      }

      const docPath =
        await ProjectEntityHandler.promises.getDocPathByProjectIdAndDocId(
          projectId,
          docId
        )

      await _queueChange(
        projectId,
        docPath,
        { op: 'upsert', entityId: docId, entityType: 'doc' },
        // No source available; the worker's content-hash check is the guard.
        'docupdater'
      )
    } catch (err) {
      logger.error(
        { err, projectId, docId },
        'GoogleDriveSync: failed to queue outbound doc change'
      )
    }
  },
}

export default GoogleDriveHookHandler
export { GoogleDriveHookHandler }
