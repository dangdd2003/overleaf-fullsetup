import Settings from '@overleaf/settings'
import { DEFAULTS } from './TemplateGalleryDefaults.mjs'
import * as Migrations from './persistence/Migrations.mjs'
import * as Indexes from './persistence/Indexes.mjs'
import * as StorageHealth from './storage/StorageHealth.mjs'
import Runner from './jobs/Runner.mjs'
import Scheduler from './jobs/Scheduler.mjs'
import { logInfo, logWarn, logError } from './observability/Log.mjs'

let ready = false
let readinessState = {
  ready: false,
  indexesOk: false,
  storageOk: false,
  migrationOk: false,
  error: null,
  lastCheckedAt: null,
}

/**
 * Returns whether template gallery is fully initialized and ready.
 */
export function isReady() {
  return ready
}

/**
 * Returns detailed readiness diagnostics.
 */
export function getReadinessState() {
  return { ...readinessState }
}

/**
 * Allows test suites to explicitly force the readiness state.
 */
export function setReadyForTests(bool) {
  ready = Boolean(bool)
  readinessState.ready = ready
}

/**
 * Idempotently injects the template gallery navigation link into Settings.templateLinks,
 * pointing to '/latex/templates'.
 */
export function installNavigation(cfg = Settings.templateGallery || DEFAULTS) {
  if (!Array.isArray(Settings.templateLinks)) {
    Settings.templateLinks = []
  }

  const linkDef = {
    name: 'view_all',
    url: '/latex/templates',
    trackingKey: 'template-gallery-view-all',
  }

  const existingIndex = Settings.templateLinks.findIndex(
    link => link.name === linkDef.name || link.url === '/templates' || link.url === linkDef.url
  )

  if (existingIndex !== -1) {
    Settings.templateLinks[existingIndex] = {
      ...Settings.templateLinks[existingIndex],
      ...linkDef,
    }
  } else {
    Settings.templateLinks.push(linkDef)
  }
}

/**
 * Starts lifecycle initialization. Never throws.
 * Runs migrations, ensures indexes, probes storage health, installs navigation if ready, and starts runner/scheduler.
 */
export async function start(cfg = Settings.templateGallery || DEFAULTS) {
  readinessState.lastCheckedAt = new Date()

  try {
    // 1. Ensure all database indexes (which runs Migrations.migrateItems())
    const indexRes = await Indexes.ensureAll()
    readinessState.indexesOk = Boolean(indexRes?.essentialOk ?? true)
    readinessState.migrationOk = !indexRes?.migration?.error
    readinessState.migration = indexRes?.migration

    // 2. Storage health check
    const storageRes = await StorageHealth.probe(cfg)
    readinessState.storageOk = Boolean(storageRes?.ok)

    if (readinessState.indexesOk && readinessState.storageOk) {
      ready = true
      readinessState.ready = true
      readinessState.error = null

      // 3. Install navigation link idempotently
      installNavigation(cfg)

      // 4. Start background runner (which drives Scheduler)
      Runner.start(cfg)
      logInfo('lifecycle_started', { ready: true })
    } else {
      ready = false
      readinessState.ready = false
      readinessState.error = storageRes?.code || 'readiness-checks-failed'
      logWarn('lifecycle_storage_or_indexes_failed', { readinessState, storageRes })
    }
  } catch (err) {
    ready = false
    readinessState.ready = false
    readinessState.error = err.message
    logError('lifecycle_start_error', err)
  }

  return readinessState
}

/**
 * Stops runner and scheduler and resets lifecycle state.
 */
export async function stop() {
  await Runner.stop()
  ready = false
  readinessState.ready = false
}

export { Scheduler, Runner, Migrations, Indexes }

export default {
  isReady,
  getReadinessState,
  setReadyForTests,
  installNavigation,
  start,
  stop,
  Scheduler,
  Runner,
  Migrations,
  Indexes,
}
