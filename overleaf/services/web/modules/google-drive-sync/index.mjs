import './app/src/ModuleSettings.mjs'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import { addOptionalCleanupHandlerBeforeStoppingTraffic } from '../../app/src/infrastructure/GracefulShutdown.mjs'
import GoogleDriveRouter from './app/src/GoogleDriveRouter.mjs'

/**
 * @import { WebModule } from "../../types/web-module"
 */

// The module is always present in moduleImportSequence so that its frontend
// slot registrations resolve at webpack build time. Everything it does at
// runtime is gated here, so an instance with GOOGLE_DRIVE_ENABLED unset behaves
// exactly like upstream Overleaf CE: no routes, no hooks, no workers, no
// indexes and no database work.
function isEnabled() {
  return Boolean(Settings.enableGoogleDriveSync)
}

/**
 * Loads the background workers. Imported lazily so a disabled instance never
 * evaluates them.
 */
async function loadWorkers() {
  const [polling, outbound, channelRenewal, bulkSync, importer] =
    await Promise.all([
      import('./app/src/GoogleDrivePollingWorker.mjs'),
      import('./app/src/GoogleDriveOutboundWorker.mjs'),
      import('./app/src/GoogleDriveChannelRenewalWorker.mjs'),
      import('./app/src/GoogleDriveBulkSyncWorker.mjs'),
      import('./app/src/GoogleDriveImportWorker.mjs'),
    ])
  return [
    polling.default,
    outbound.default,
    channelRenewal.default,
    bulkSync.default,
    importer.default,
  ]
}

/** @type {WebModule} */
const GoogleDriveSyncModule = {
  name: 'google-drive-sync',
  router: {
    apply(webRouter, privateApiRouter, publicApiRouter) {
      if (!isEnabled()) return
      GoogleDriveRouter.apply(webRouter, privateApiRouter, publicApiRouter)
    },
  },
  async start() {
    if (!isEnabled()) return

    const workers = await loadWorkers()
    for (const worker of workers) {
      worker.start()
    }
    addOptionalCleanupHandlerBeforeStoppingTraffic(
      'google-drive-sync',
      () => {
        for (const worker of workers) {
          worker.stop()
        }
      }
    )

    // Mongoose autoIndex is off in this app, so the module creates its own
    // collection indexes, only when enabled.
    const { ensureJobIndexes, ensureProjectStateIndexes } = await import(
      './app/src/models/GoogleDriveSyncModels.mjs'
    )
    Promise.all([ensureJobIndexes(), ensureProjectStateIndexes()]).catch(
      err => {
        logger.error(
          { err },
          'google-drive-sync: could not create collection indexes'
        )
      }
    )
  },
  // A getter, so the hooks are read at attach time. When disabled, nothing is
  // registered and the entity-mutation path never reaches this module.
  get hooks() {
    if (!isEnabled()) return {}
    return {
      promises: {
        fileModified: async (projectId, entityId, filePath, source) => {
          const { default: GoogleDriveHookHandler } = await import(
            './app/src/GoogleDriveHookHandler.mjs'
          )
          await GoogleDriveHookHandler.onFileModified(
            projectId,
            entityId,
            filePath,
            source
          )
        },
        entityDeleted: async (projectId, filePath, entityType, source) => {
          const { default: GoogleDriveHookHandler } = await import(
            './app/src/GoogleDriveHookHandler.mjs'
          )
          await GoogleDriveHookHandler.onEntityDeleted(
            projectId,
            filePath,
            entityType,
            source
          )
        },
        docModified: async (projectId, docId, ranges, lastUpdatedAt) => {
          const { default: GoogleDriveHookHandler } = await import(
            './app/src/GoogleDriveHookHandler.mjs'
          )
          await GoogleDriveHookHandler.onDocModified(
            projectId,
            docId,
            ranges,
            lastUpdatedAt
          )
        },
        deleteUser: async userId => {
          const { default: GoogleDriveCleanup } = await import(
            './app/src/GoogleDriveCleanup.mjs'
          )
          await GoogleDriveCleanup.onUserDeleted(userId)
        },
        expireDeletedUser: async userId => {
          const { default: GoogleDriveCleanup } = await import(
            './app/src/GoogleDriveCleanup.mjs'
          )
          await GoogleDriveCleanup.onUserDeleted(userId)
        },
        projectExpired: async projectId => {
          const { default: GoogleDriveCleanup } = await import(
            './app/src/GoogleDriveCleanup.mjs'
          )
          await GoogleDriveCleanup.onProjectExpired(projectId)
        },
      },
    }
  },
}

export const start = GoogleDriveSyncModule.start
export { isEnabled }
export default GoogleDriveSyncModule
