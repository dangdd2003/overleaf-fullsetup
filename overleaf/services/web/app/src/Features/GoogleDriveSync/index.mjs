import Features from '../../infrastructure/Features.mjs'
import Modules from '../../infrastructure/Modules.mjs'
import GoogleDrivePollingWorker from './GoogleDrivePollingWorker.mjs'
import GoogleDriveOutboundWorker from './GoogleDriveOutboundWorker.mjs'
import GoogleDriveChannelRenewalWorker from './GoogleDriveChannelRenewalWorker.mjs'
import GoogleDriveHookHandler from './GoogleDriveHookHandler.mjs'

/**
 * Starts the Google Drive background jobs and attaches the entity hooks.
 *
 * Called once from app.mjs at boot, alongside the other background workers.
 * Route mounting (GoogleDriveRouter) deliberately has no side effects, so
 * importing the router does not start timers.
 *
 * Sync is asymmetric, mirroring Overleaf Cloud's Dropbox integration:
 *
 *   - Inbound (Drive -> Overleaf) runs on the polling worker's delta feed.
 *   - Outbound (Overleaf -> Drive) is queued per-file by the hook handler and
 *     flushed in batches by the outbound worker.
 *
 * Outbound is deliberately not immediate. An earlier implementation scheduled
 * a full syncProject a debounced 8s after every local edit; syncProject
 * re-lists and re-checksums every file in the project, so a single-file edit
 * cost a full pass over the whole tree, repeatedly, and ran into Drive API
 * rate limits. The hook handler now records only the paths that actually
 * changed, and the outbound worker pushes just those.
 */
function start() {
  if (!Features.hasFeature('google-drive-sync')) {
    return
  }

  Modules.hooks.attach('fileModified', GoogleDriveHookHandler.onFileModified)
  Modules.hooks.attach('entityDeleted', GoogleDriveHookHandler.onEntityDeleted)
  // docModified is an upstream Overleaf hook fired when document-updater
  // flushes a doc back to web. It is the only signal for doc *content* edits;
  // fileModified covers binary files only.
  Modules.hooks.attach('docModified', GoogleDriveHookHandler.onDocModified)

  GoogleDrivePollingWorker.start()
  GoogleDriveOutboundWorker.start()
  GoogleDriveChannelRenewalWorker.start()
}

export default { start }
export { start }
