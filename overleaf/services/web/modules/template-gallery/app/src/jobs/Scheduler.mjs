import {
  crawlerStateCol,
  itemsCol,
  listingsCol,
} from '../persistence/Collections.mjs'
import TemplateCrawlerService from '../services/TemplateCrawlerService.mjs'
import JobStore from './JobStore.mjs'
import { isHostIdle } from '../transport/HostLimiter.mjs'
import { logInfo, logWarn, logError } from '../observability/Log.mjs'

// Drives the overleaf.com mirror from the process holding the 'crawler'
// lease (see Runner). One loop, one step at a time, in priority order:
//
//   1. Algolia catalogue: on an empty mirror, then weekly
//   2. featured blocks + gallery recent pages 1..3: hourly
//   3. full gallery recent scan: first run, then weekly, resumable in chunks
//   4. detail / pdf / tag trickle, only while the overleaf host is idle
//
// Admin actions only record a request in the scheduler doc; the leader picks
// it up on its next step, so exactly one process talks to upstream.

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export const CATALOGUE_INTERVAL_MS = 7 * DAY
export const CATALOGUE_RETRY_MS = HOUR
export const RECENT_HEAD_INTERVAL_MS = HOUR
export const RECENT_HEAD_PAGES = 3
export const RECENT_FULL_INTERVAL_MS = 7 * DAY
export const RECENT_FULL_CHUNK_PAGES = 10
const TRICKLE_BATCH = 5
const TRICKLE_KINDS = ['detail', 'pdf', 'tag']
const IDLE_SLEEP_MS = 5 * MINUTE
const BUSY_SLEEP_MS = 2_000
const ERROR_SLEEP_MS = MINUTE

const SCHEDULER_DOC_ID = 'scheduler'
const RECENT_SCAN_ID = 'scan:gallery-recent'
export const REQUEST_ACTIONS = Object.freeze([
  'catalogue',
  'recent',
  'recent-full',
  'featured',
])

let leaderUntil = 0
let loop = null
let stopping = false
let wake = null
let currentStep = null
let trickleCursor = 0
let deps = null

// MirrorService is loaded on first use so the catalogue keeps working even
// if the mirror cannot load.
async function getDeps() {
  if (!deps) {
    deps = { crawler: TemplateCrawlerService, jobs: JobStore, isHostIdle }
  }
  if (deps && !deps.mirror) {
    const mod = await import('../services/mirror/MirrorService.mjs')
    if (deps) deps.mirror = mod.default || mod
  }
  return deps || { crawler: TemplateCrawlerService, jobs: JobStore, isHostIdle }
}

function crawler() {
  return deps?.crawler || TemplateCrawlerService
}

/**
 * Replaces collaborators ({ crawler, mirror, jobs, isHostIdle }) in tests.
 */
export function setDependenciesForTests(overrides) {
  deps = overrides
}

function olderThan(date, ms, now) {
  return !date || now - new Date(date).getTime() >= ms
}

async function readState() {
  const col = await crawlerStateCol()
  return (await col.findOne({ _id: SCHEDULER_DOC_ID })) || { _id: SCHEDULER_DOC_ID }
}

async function updateState(update) {
  const col = await crawlerStateCol()
  await col.updateOne({ _id: SCHEDULER_DOC_ID }, update, { upsert: true })
}

async function readRecentScan() {
  const col = await listingsCol()
  return col.findOne({ _id: RECENT_SCAN_ID })
}

/**
 * Records an admin request; the leader acts on it on its next step.
 *
 * @param {'catalogue'|'recent'|'recent-full'|'featured'} action
 */
export async function requestRun(action, requestedBy = null) {
  if (!REQUEST_ACTIONS.includes(action)) {
    const err = new Error(`unknown scheduler action: ${action}`)
    err.code = 'invalid_action'
    throw err
  }
  await updateState({
    $set: { [`requests.${action}`]: { at: new Date(), by: requestedBy } },
  })
  wake?.()
  return { queued: true, action }
}

async function clearRequest(action) {
  await updateState({ $unset: { [`requests.${action}`]: '' } })
}

async function catalogueDue(state, now) {
  if (state.requests?.catalogue) return true
  if (!olderThan(state.catalogueAttemptAt, CATALOGUE_RETRY_MS, now)) return false
  const catalogue = await crawler().getCatalogueState()
  if (olderThan(catalogue?.lastSuccessAt, CATALOGUE_INTERVAL_MS, now)) return true
  const items = await itemsCol()
  return (await items.estimatedDocumentCount()) === 0
}

function recentHeadDue(state, now) {
  return (
    Boolean(state.requests?.recent || state.requests?.featured) ||
    olderThan(state.recentHeadAt, RECENT_HEAD_INTERVAL_MS, now)
  )
}

function recentFullStatus(scan, state, now) {
  const inProgress =
    scan?.startedAt &&
    (!scan.finishedAt || new Date(scan.finishedAt) < new Date(scan.startedAt))
  if (inProgress) return 'resume'
  if (state.requests?.['recent-full']) return 'start'
  if (olderThan(scan?.finishedAt, RECENT_FULL_INTERVAL_MS, now)) return 'start'
  return null
}

async function runCatalogue(cfg, shouldStop) {
  await updateState({ $set: { catalogueAttemptAt: new Date() } })
  await clearRequest('catalogue')
  return crawler().runCatalogue({ cfg, shouldStop })
}

async function runRecentHead() {
  const { mirror } = await getDeps()
  await clearRequest('recent')
  await clearRequest('featured')
  const featured = await mirror.scanFeatured()
  const recent = await mirror.scanGalleryRecent({
    fromPage: 1,
    toPage: RECENT_HEAD_PAGES,
    priority: 'background',
  })
  if (recent?.error) {
    const err = new Error(`recent head scan failed: ${recent.error}`)
    err.code = typeof recent.error === 'string' ? recent.error : 'scan_failed'
    throw err
  }
  await updateState({ $set: { recentHeadAt: new Date() } })
  return { featured, recent }
}

async function runRecentFullChunk(mode) {
  const { mirror } = await getDeps()
  const col = await listingsCol()
  if (mode === 'start') {
    await clearRequest('recent-full')
    await col.updateOne(
      { _id: RECENT_SCAN_ID },
      { $set: { nextPage: 1, startedAt: new Date(), finishedAt: null } },
      { upsert: true }
    )
  }
  const scan = await readRecentScan()
  const fromPage = Math.max(1, Number(scan?.nextPage) || 1)
  const toPage = fromPage + RECENT_FULL_CHUNK_PAGES - 1
  const res = await mirror.scanGalleryRecent({
    fromPage,
    toPage,
    priority: 'background',
  })
  if (res?.error) {
    const err = new Error(`recent full scan failed at page ${fromPage}: ${res.error}`)
    err.code = typeof res.error === 'string' ? res.error : 'scan_failed'
    throw err
  }
  const update = res?.done
    ? { $set: { nextPage: 1, finishedAt: new Date() } }
    : { $max: { nextPage: fromPage + (Number(res?.pages) || 0) } }
  await col.updateOne({ _id: RECENT_SCAN_ID }, update, { upsert: true })
  return res
}

/**
 * Queues the periodic gc / integrity jobs when due. Called by the Runner
 * while it holds the validator lease, independent of the crawler switch.
 */
export async function enqueueMaintenanceIfDue(cfg, now = Date.now()) {
  const jobs = deps?.jobs || JobStore
  const state = await readState()
  const runner = cfg?.runner || {}
  const queued = []
  for (const [kind, field, interval] of [
    ['gc', 'gcAt', runner.gcIntervalMs || HOUR],
    ['integrity', 'integrityAt', runner.integrityEveryMs || DAY],
  ]) {
    if (!olderThan(state[field], interval, now)) continue
    await jobs.enqueue({ kind, dedupeKey: `maintenance:${kind}`, maxAttempts: 1 })
    await updateState({ $set: { [field]: new Date(now) } })
    queued.push(kind)
  }
  return queued
}

async function runTrickle() {
  const { mirror, isHostIdle: hostIdle } = await getDeps()
  if (!hostIdle('overleaf')) return { busy: true }
  let processed = 0
  for (let i = 0; i < TRICKLE_KINDS.length; i++) {
    const kind = TRICKLE_KINDS[trickleCursor]
    trickleCursor = (trickleCursor + 1) % TRICKLE_KINDS.length
    const batch =
      kind === 'detail'
        ? mirror.runDetailBatch
        : kind === 'pdf'
          ? mirror.runPdfBatch
          : mirror.runTagBatch
    const res = await batch({ limit: TRICKLE_BATCH })
    processed += Number(res?.processed) || 0
    if (processed > 0) return { kind, ...res }
  }
  return { idle: true }
}

/**
 * Performs the single most urgent piece of mirror work.
 *
 * @param {{ cfg: object, shouldStop?: () => Promise<boolean> }} ctx
 * @returns {Promise<{ step: string, sleepMs: number, result?: any }>}
 */
export async function runStep({ cfg, shouldStop }) {
  if (!cfg?.crawler?.enabled) return { step: 'disabled', sleepMs: IDLE_SLEEP_MS }
  if (await crawler().isPaused()) return { step: 'paused', sleepMs: MINUTE }

  const now = Date.now()
  const state = await readState()

  if (await catalogueDue(state, now)) {
    return { step: 'catalogue', sleepMs: 0, result: await runCatalogue(cfg, shouldStop) }
  }
  if (recentHeadDue(state, now)) {
    return { step: 'recent-head', sleepMs: 0, result: await runRecentHead() }
  }
  const fullMode = recentFullStatus(await readRecentScan(), state, now)
  if (fullMode) {
    return {
      step: 'recent-full',
      sleepMs: 0,
      result: await runRecentFullChunk(fullMode),
    }
  }
  const trickle = await runTrickle()
  if (trickle.busy) return { step: 'trickle', sleepMs: BUSY_SLEEP_MS, result: trickle }
  if (trickle.idle) return { step: 'idle', sleepMs: IDLE_SLEEP_MS, result: trickle }
  return { step: 'trickle', sleepMs: 0, result: trickle }
}

function isLeader() {
  return !stopping && Date.now() < leaderUntil
}

function sleep(ms) {
  if (ms <= 0) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(done, ms)
    timer.unref?.()
    function done() {
      clearTimeout(timer)
      wake = null
      resolve()
    }
    wake = done
  })
}

async function driveLoop(cfg) {
  const shouldStop = async () => !isLeader()
  logInfo('mirror_scheduler_started', {})
  while (isLeader()) {
    let sleepMs
    try {
      const res = await runStep({ cfg, shouldStop })
      currentStep = { step: res.step, at: new Date() }
      sleepMs = res.sleepMs
    } catch (err) {
      currentStep = { step: 'error', at: new Date(), error: err.message }
      if (err.code === 'circuit_open' || err.code === 'catalogue_stopped') {
        logWarn('mirror_scheduler_step_stopped', { code: err.code })
      } else {
        logError('mirror_scheduler_step_failed', err)
      }
      sleepMs = ERROR_SLEEP_MS
    }
    if (isLeader()) await sleep(sleepMs)
  }
  logInfo('mirror_scheduler_stopped', {})
}

/**
 * Called by the Runner after acquiring or renewing the 'crawler' lease.
 * Starts the loop if it is not running.
 */
export function lead(cfg, leaseMs) {
  leaderUntil = Date.now() + Math.floor(leaseMs * 0.9)
  stopping = false
  if (!loop) {
    loop = driveLoop(cfg).finally(() => {
      loop = null
    })
  }
}

/**
 * Called by the Runner when the lease is held by someone else.
 */
export function yieldLeadership() {
  leaderUntil = 0
  wake?.()
}

/**
 * Stops the loop and waits for the current step to finish.
 */
export async function stop() {
  stopping = true
  leaderUntil = 0
  wake?.()
  if (loop) await loop
}

/**
 * Snapshot for the admin status API.
 */
export async function getStatus() {
  const [state, recentScan] = await Promise.all([readState(), readRecentScan()])
  return {
    leader: isLeader(),
    running: Boolean(loop),
    currentStep,
    recentHeadAt: state.recentHeadAt || null,
    catalogueAttemptAt: state.catalogueAttemptAt || null,
    gcAt: state.gcAt || null,
    integrityAt: state.integrityAt || null,
    requests: state.requests || {},
    recentScan: recentScan || null,
  }
}

export default {
  REQUEST_ACTIONS,
  requestRun,
  enqueueMaintenanceIfDue,
  runStep,
  lead,
  yieldLeadership,
  stop,
  getStatus,
  setDependenciesForTests,
}
