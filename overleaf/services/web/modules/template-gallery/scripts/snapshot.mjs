// overleaf/services/web/modules/template-gallery/scripts/snapshot.mjs
//
// Inspect, export or import the template gallery volume snapshot.
// Run from services/web inside the web container:
//   node modules/template-gallery/scripts/snapshot.mjs status
//   node modules/template-gallery/scripts/snapshot.mjs export
//   node modules/template-gallery/scripts/snapshot.mjs import

import { scriptRunner } from '../../../scripts/lib/ScriptRunner.mjs'
import * as CatalogSnapshot from '../app/src/storage/CatalogSnapshot.mjs'
import * as CatalogSync from '../app/src/storage/CatalogSync.mjs'

const USAGE = `Usage: node modules/template-gallery/scripts/snapshot.mjs <command>

Commands:
  status   Show the current snapshot on the volume (no database access)
  export   Write a new snapshot generation from MongoDB (needs the snapshot lease)
  import   Restore into empty MongoDB, or resume an interrupted restore. Refuses live catalogs.
`

/**
 * @param {import('../app/src/storage/CatalogSnapshot.mjs').SnapshotManifest} manifest
 */
function summarize(manifest) {
  return {
    storeId: manifest.storeId,
    generation: manifest.generation,
    createdAt: manifest.createdAt,
    reason: manifest.reason,
    collections: Object.fromEntries(
      Object.entries(manifest.collections).map(([name, info]) => [
        name,
        { count: info.count, bytes: info.bytes },
      ])
    ),
  }
}

async function main(trackProgress) {
  const command = process.argv[2]
  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE)
    return
  }

  switch (command) {
    case 'status': {
      const manifest = await CatalogSnapshot.readCurrentManifest()
      console.log(
        manifest
          ? JSON.stringify(summarize(manifest), null, 2)
          : 'No catalog snapshot on the volume.'
      )
      return
    }
    case 'export': {
      await trackProgress('Exporting template gallery snapshot')
      const manifest = await CatalogSync.exportNow('cli')
      if (!manifest) {
        console.log(
          'Another process holds the snapshot lease. Nothing exported, retry later.'
        )
        process.exitCode = 2
        return
      }
      console.log(JSON.stringify(summarize(manifest), null, 2))
      return
    }
    case 'import': {
      await trackProgress('Importing template gallery snapshot')
      const result = await CatalogSync.restoreIfNeeded({})
      if (result.action !== 'restored' && result.action !== 'waited') {
        throw new Error(
          'Refusing to import: no restore is needed or no usable snapshot exists. Import requires an empty database or an interrupted restore marker.'
        )
      }
      console.log(JSON.stringify(result, null, 2))
      return
    }
    default:
      throw new Error(`Unknown command: ${command}\n\n${USAGE}`)
  }
}

try {
  await scriptRunner(main)
  process.exit(process.exitCode ?? 0)
} catch (error) {
  console.error(error)
  process.exit(1)
}
