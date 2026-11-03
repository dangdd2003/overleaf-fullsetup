import { crawlerStateCol, listingsCol } from '../persistence/Collections.mjs'
import TemplateCrawlerService from '../services/TemplateCrawlerService.mjs'
import * as RateGate from '../transport/RateGate.mjs'
import JobStore from './JobStore.mjs'
import Lock from './Lock.mjs'
import SyncRun from './SyncRun.mjs'
import SyncSettings from './SyncSettings.mjs'
import { logInfo, logWarn, logError } from '../observability/Log.mjs'

// Drives the overleaf.com mirror from the process holding the 'crawler'
// lease (see Runner). Nothing is fetched from overleaf.com unless a sync run
// is active: an admin starts one with "Sync now", or, only when automatic
// sync is turned on in the settings, one starts every refetchDays days.
//
// A run (jobs/SyncRun.mjs) walks its phases in order, one step at a time:
//   catalogue  template list from Algolia
//   new        featured blocks + gallery recent pages 1..3
//   rescan     full gallery listing walk, in chunks (only when asked for)
//   details    detail page + PDF of every missing or outdated template, with
//              three workers per outbound route (transport/RateGate.mjs)
//   tags       tag pages
// Every route (each proxy, or direct) sends to overleaf.com at a fixed pace.
// A route that overleaf.com blocks pauses on its own until the block resets
// (about 5 minutes) while the other routes keep fetching; a refused item just
// stays due. The run only waits when every route is blocked or resting, and
// nothing is marked failed for that.
// The run, its phase and its counters are stored in Mongo, so a restart or a
// new leader resumes it where it stopped. Leadership is checked before every
// step and inside the pool, so a lost lease stops work at once.

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export const RECENT_HEAD_PAGES = 3
export const RECENT_FULL_CHUNK_PAGES = 10
// Parallel detail workers per outbound route, and the overall cap
const WORKERS_PER_ROUTE = 3
const MAX_WORKERS = 150
const SYNC_BATCH = 200
const PROGRESS_WRITE_MS = 1_000
// How often a running step looks for a stop request (read from Mongo), and
// how often the details pool asks
const STOP_CHECK_MS = 2_000
const STOP_WATCH_MS = 1_000
const TAG_BATCH = 50
const IDLE_SLEEP_MS = 15_000
const MIN_WAIT_MS = 5_000
const DEFAULT_WAIT_MS = 30_000
const MAX_WAIT_MS = 10 * MINUTE
const ERROR_SLEEP_MS = MINUTE

const SCHEDULER_DOC_ID = 'scheduler'
const RECENT_SCAN_ID = 'scan:gallery-recent'
const PAUSE_LOCK_ID = 'crawler'
export const REQUEST_ACTIONS = Object.freeze(['sync'])

let leaderUntil = 0
let loop = null
let stopping = false
let wake = null
let currentStep = null
let migrated = false
let deps = null

// MirrorService is loaded on first use so the catalogue keeps working even
// if the mirror cannot load.
async function getDeps() {
  if (!deps) {
    deps = { crawler: TemplateCrawlerService, jobs: JobStore }
  }
  if (!deps.mirror) {
    const mod = await import('../services/mirror/MirrorService.mjs')
    deps.mirror = mod.default || mod
  }
  return deps
}

function crawler() {
  return deps?.crawler || TemplateCrawlerService
}

function runs() {
  return deps?.runs || SyncRun
}

function settingsStore() {
  return deps?.settings || SyncSettings
}

function limiter() {
  return deps?.limiter || RateGate
}

/**
 * Replaces collaborators ({ crawler, mirror, jobs, runs, settings, limiter })
 * in tests.
 */
export function setDependenciesForTests(overrides) {
  deps = overrides
  migrated = true
}

function olderThan(date, ms, now) {
  return !date || now - new Date(date).getTime() >= ms
}

async function readState() {
  const col = await crawlerStateCol()
  return (
    (await col.findOne({ _id: SCHEDULER_DOC_ID })) || { _id: SCHEDULER_DOC_ID }
  )
}

async function updateState(update) {
  const col = await crawlerStateCol()
  await col.updateOne({ _id: SCHEDULER_DOC_ID }, update, { upsert: true })
}

async function readRecentScan() {
  const col = await listingsCol()
  return col.findOne({ _id: RECENT_SCAN_ID })
}

// Clears the state of the old always-on scheduler once per process: its
// request flags and timers, the pause flag and its progress document.
async function migrateOnce() {
  if (migrated) return
  migrated = true
  try {
    await updateState({
      $unset: {
        requests: '',
        recentHeadAt: '',
        catalogueAttemptAt: '',
        nextCatalogueAt: '',
        nextFullScanAt: '',
      },
    })
    await Lock.resume(PAUSE_LOCK_ID)
    const { configCol } = await import('../persistence/Collections.mjs')
    await (await configCol()).deleteOne({ _id: 'syncProgress' })
  } catch (err) {
    logWarn('mirror_scheduler_migration_failed', { message: err?.message })
  }
}

/**
 * Starts a sync run now. Refused with code 'invalid_action' for an unknown
 * action and 'run_active' while a run is active. Failed items are made due
 * again, so the run retries them.
 *
 * @param {'sync'} action
 * @param {string|null} [requestedBy]
 * @param {{ rescan?: boolean, trigger?: 'manual'|'auto' }} [opts]
 */
export async function requestRun(action, requestedBy = null, opts = {}) {
  if (!REQUEST_ACTIONS.includes(action)) {
    const err = new Error(`unknown scheduler action: ${action}`)
    err.code = 'invalid_action'
    throw err
  }
  if (await runs().current()) {
    const err = new Error('a sync is already running')
    err.code = 'run_active'
    throw err
  }
  const { mirror } = await getDeps()
  await mirror.retryFailedNow()
  const run = await runs().start({
    trigger: opts.trigger || 'manual',
    requestedBy,
    rescan: opts.rescan === true,
    refetchMs: await settingsStore().refetchIntervalMs(),
  })
  wake?.()
  return { queued: true, action, runId: run.id }
}

/**
 * Asks the running sync to stop after the requests in flight.
 */
export async function requestStop() {
  await runs().requestStop()
  wake?.()
}

// Leadership is checked at every step boundary: a lease lost mid-step stops
// the loop before the next upstream request instead of finishing the step.
async function assertLeading(shouldStop) {
  if (shouldStop && (await shouldStop())) {
    const err = new Error('mirror scheduler is no longer the leader')
    err.code = 'scheduler_stopped'
    throw err
  }
}

// True once leadership is lost or a stop was requested. The stop request is
// read from Mongo at most every STOP_CHECK_MS.
function stopChecker(runId, shouldStop) {
  let checkAt = 0
  let stop = false
  return async () => {
    if (stop) return true
    if (shouldStop && (await shouldStop())) return (stop = true)
    if (Date.now() >= checkAt) {
      checkAt = Date.now() + STOP_CHECK_MS
      const run = await runs().current()
      if (!run || run.id !== runId || run.cancelRequested) stop = true
    }
    return stop
  }
}

async function autoRunDue() {
  const settings = await settingsStore().get()
  if (!settings.autoSync) return false
  const last = await runs().read()
  return olderThan(last?.startedAt, settings.refetchDays * DAY, Date.now())
}

// How long to wait when the host refuses every lane
function waitForLanesMs() {
  const readyAt = limiter().earliestReadyAt?.('overleaf')
  if (!readyAt) return DEFAULT_WAIT_MS
  return Math.min(
    MAX_WAIT_MS,
    Math.max(MIN_WAIT_MS, new Date(readyAt).getTime() - Date.now())
  )
}

// Why the run waits: overleaf.com blocks every route ('throttled'), or the
// routes fail for another reason (proxy errors, network)
function waitReason() {
  return limiter().isThrottling?.('overleaf') === true
    ? 'throttled'
    : 'unavailable'
}

function errorText(err) {
  if (!err) return null
  const status = err.status ? `HTTP ${err.status}: ` : ''
  const code = err.code && !String(err.message).includes(err.code) ? `${err.code}: ` : ''
  return `${status}${code}${err.message || err}`.slice(0, 300)
}

// What the admin sees while the run waits: how many routes are down and the
// latest upstream error, e.g. "50/50 routes blocked by overleaf.com. Last
// error: HTTP 403: ..."
function waitError(err) {
  const routes = limiter().getHostStatus?.().overleaf?.routes || []
  const now = Date.now()
  const blocked = routes.filter(r => r.blockedUntil && new Date(r.blockedUntil) > now).length
  const resting = routes.filter(r => r.restUntil && new Date(r.restUntil) > now).length
  const parts = []
  if (blocked) parts.push(`${blocked}/${routes.length} routes blocked by overleaf.com`)
  if (resting) parts.push(`${resting}/${routes.length} routes failing (proxy or network)`)
  // Prefer the error of a route that is down right now
  const down = r =>
    (r.blockedUntil && new Date(r.blockedUntil) > now) ||
    (r.restUntil && new Date(r.restUntil) > now)
  const latest =
    routes.find(r => r.lastError && down(r)) || routes.find(r => r.lastError)
  const last = errorText(err) || latest?.lastError
  if (last) parts.push(`Last error: ${last}`)
  return parts.join('. ') || 'Upstream refused the request'
}

function isHostRefusal(err, mirror) {
  return (
    mirror.isHostRejection?.(err) ||
    RateGate.isTransientCode(err?.code) ||
    err?.hostThrottled === true
  )
}

// ---------------------------------------------------------------------------
// phases: each returns { complete, waitMs?, error? }

async function runCataloguePhase(run, phase, { cfg, isStopped }) {
  const result = await crawler().runCatalogue({ cfg, shouldStop: isStopped })
  const total = Number(result?.total) || 0
  await runs().update(run.id, {
    phase: phase.name,
    phaseFields: { total, done: total },
  })
  return { complete: true }
}

async function runNewPhase(run, phase, { shouldStop }) {
  const { mirror } = await getDeps()
  await mirror.scanFeatured()
  await assertLeading(shouldStop)
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
  await runs().update(run.id, {
    phase: phase.name,
    phaseFields: { done: Number(recent?.items) || 0 },
  })
  return { complete: true }
}

async function runRescanPhase(run, phase, { shouldStop }) {
  const mode = phase.done > 0 ? 'resume' : 'start'
  const res = await runRecentFullChunk(mode, shouldStop)
  await runs().update(run.id, {
    phase: phase.name,
    phaseFields: { done: (phase.done || 0) + (Number(res?.pages) || 0) },
  })
  return { complete: Boolean(res?.done) }
}

async function runTagsPhase(run, phase, { isStopped }) {
  const { mirror } = await getDeps()
  const res = await mirror.runTagBatch({
    limit: TAG_BATCH,
    shouldStop: isStopped,
  })
  const processed = Number(res?.processed) || 0
  await runs().update(run.id, {
    phase: phase.name,
    phaseFields: {
      done: (phase.done || 0) + processed - (Number(res?.failed) || 0),
      failed: (phase.failed || 0) + (Number(res?.failed) || 0),
    },
  })
  if (res?.hostRejected) return { complete: false, waitMs: waitForLanesMs() }
  if (await isStopped()) return { complete: false }
  return { complete: processed === 0 }
}

/**
 * Fetches every template missing its detail or PDF, or synced before the
 * run's refetchBefore, with WORKERS_PER_ROUTE workers per outbound route; the
 * routes pace the requests. An item refused because its routes are blocked is
 * skipped for this step and stays due. Ends when nothing is left, the run is
 * stopped, leadership is lost, or every route is blocked (then the run waits
 * for the first route to come back and the step is retried).
 */
async function runDetailsPhase(run, phase, { isStopped }) {
  const { mirror } = await getDeps()
  const before = new Date(run.refetchBefore)
  let total = phase.total
  if (total == null) {
    total = await mirror.countSyncable({ before })
    await runs().update(run.id, { phase: phase.name, phaseFields: { total } })
  }
  const counters = { done: phase.done || 0, failed: phase.failed || 0 }
  let lastItemError = phase.lastError || null
  let lastRefusal = null
  const routeTotal = Number(limiter().routeCount?.('overleaf')) || 1
  const workers = Math.min(
    MAX_WORKERS,
    Math.max(1, routeTotal * WORKERS_PER_ROUTE)
  )
  const taken = new Set()
  const inFlight = new Set()
  let queue = []
  let exhausted = false
  let refill = null
  let noRoute = false

  async function nextToken() {
    while (queue.length === 0 && !exhausted) {
      refill ??= mirror
        .nextSyncBatch({ limit: SYNC_BATCH, exclude: [...taken], before })
        .then(tokens => {
          queue = tokens.filter(token => !taken.has(token))
          if (queue.length === 0) exhausted = true
        })
        .finally(() => {
          refill = null
        })
      await refill
    }
    return queue.shift() ?? null
  }

  // Every route is blocked or resting: wait instead of refusing every item
  const allRoutesDown = () => limiter().freeRoutes?.('overleaf') === 0

  async function worker() {
    while (!noRoute && !(await isStopped())) {
      if (allRoutesDown()) {
        noRoute = true
        return
      }
      const token = await nextToken()
      if (!token) return
      taken.add(token)
      inFlight.add(token)
      try {
        await mirror.syncItem(token, { before })
        counters.done++
      } catch (err) {
        // A refusal says nothing about the item: it stays due for a later step
        if (isHostRefusal(err, mirror)) {
          lastRefusal = err
        } else {
          counters.failed++
          lastItemError = `${token}: ${errorText(err)}`
        }
      } finally {
        inFlight.delete(token)
      }
    }
  }

  const writeProgress = () =>
    runs().update(run.id, {
      fields: { inFlight: [...inFlight] },
      phase: phase.name,
      phaseFields: {
        done: counters.done,
        failed: counters.failed,
        lastError: lastItemError,
        // Templates found during the run (e.g. by the catalogue) raise the total
        total: Math.max(total, counters.done + counters.failed + queue.length),
      },
    })

  let writing = false
  const timer = setInterval(() => {
    if (writing) return
    writing = true
    writeProgress()
      .catch(err =>
        logWarn('mirror_sync_progress_failed', { message: err?.message })
      )
      .finally(() => {
        writing = false
      })
  }, PROGRESS_WRITE_MS)
  timer.unref?.()
  // A stop request ends the step at once; requests already sent finish in
  // the background and their results are still stored on the items
  let finished = false
  let stopped = false
  const watchStop = async () => {
    while (!finished) {
      if (await isStopped()) {
        stopped = true
        return
      }
      await new Promise(resolve => setTimeout(resolve, STOP_WATCH_MS))
    }
  }
  try {
    await Promise.race([
      Promise.all(Array.from({ length: workers }, worker)),
      watchStop(),
    ])
  } finally {
    finished = true
    clearInterval(timer)
  }
  inFlight.clear()
  await writeProgress()
  if (stopped) return { complete: false }
  if (noRoute) {
    return { complete: false, waitMs: waitForLanesMs(), refusal: lastRefusal }
  }
  // Items skipped after a refusal are still due: run the step again
  if (!exhausted || queue.length > 0) return { complete: false }
  return { complete: (await mirror.countSyncable({ before })) === 0 }
}

const PHASE_HANDLERS = {
  catalogue: runCataloguePhase,
  new: runNewPhase,
  rescan: runRescanPhase,
  details: runDetailsPhase,
  tags: runTagsPhase,
}

/**
 * Performs the next piece of the active sync run, starting an automatic run
 * first when automatic sync is on and one is due.
 *
 * @param {{ cfg: object, shouldStop?: () => Promise<boolean> }} ctx
 * @returns {Promise<{ step: string, sleepMs: number, result?: any }>}
 */
export async function runStep({ cfg, shouldStop }) {
  await assertLeading(shouldStop)
  await migrateOnce()

  let run = await runs().current()
  if (!run) {
    if (!(await autoRunDue())) return { step: 'idle', sleepMs: IDLE_SLEEP_MS }
    try {
      await requestRun('sync', null, { trigger: 'auto' })
    } catch (err) {
      if (err?.code !== 'run_active') throw err
    }
    run = await runs().current()
    if (!run) return { step: 'idle', sleepMs: IDLE_SLEEP_MS }
  }

  if (run.cancelRequested) {
    await runs().finish(run.id, 'cancelled')
    logInfo('mirror_sync_cancelled', { runId: run.id })
    return { step: 'cancelled', sleepMs: 0 }
  }

  const phase = run.phases.find(
    p => p.state === 'pending' || p.state === 'running'
  )
  if (!phase) {
    await runs().finish(run.id, 'done')
    logInfo('mirror_sync_done', { runId: run.id })
    return { step: 'done', sleepMs: 0 }
  }
  if (phase.state === 'pending') {
    await runs().update(run.id, {
      phase: phase.name,
      phaseFields: { state: 'running', startedAt: new Date() },
    })
  }

  if (run.waitingUntil) {
    await runs().update(run.id, {
      fields: { waitingUntil: null, waitReason: null, waitError: null },
    })
  }
  await assertLeading(shouldStop)
  const isStopped = stopChecker(run.id, shouldStop)
  const { mirror } = await getDeps()
  let outcome
  try {
    outcome = await PHASE_HANDLERS[phase.name](run, phase, {
      cfg,
      shouldStop,
      isStopped,
    })
  } catch (err) {
    if (err?.code === 'scheduler_stopped') throw err
    if (err?.code === 'catalogue_stopped') {
      outcome = { complete: false }
    } else if (isHostRefusal(err, mirror)) {
      outcome = { complete: false, waitMs: waitForLanesMs(), refusal: err }
    } else {
      // The phase cannot be done; the run goes on with the next one
      logError('mirror_sync_phase_failed', err, { phase: phase.name })
      outcome = { complete: true, error: String(err?.message || err) }
    }
  }
  await assertLeading(shouldStop)

  const waitingUntil = outcome.waitMs
    ? new Date(Date.now() + outcome.waitMs)
    : null
  await runs().update(run.id, {
    fields: {
      waitingUntil,
      waitReason: waitingUntil ? waitReason() : null,
      waitError: waitingUntil ? waitError(outcome.refusal) : null,
    },
    phase: phase.name,
    phaseFields: outcome.complete
      ? {
          state: outcome.error ? 'failed' : 'done',
          finishedAt: new Date(),
          error: outcome.error ?? null,
        }
      : {},
  })
  return { step: phase.name, sleepMs: outcome.waitMs || 0, result: outcome }
}

async function runRecentFullChunk(mode, shouldStop) {
  const { mirror } = await getDeps()
  const col = await listingsCol()
  if (mode === 'start') {
    await col.updateOne(
      { _id: RECENT_SCAN_ID },
      { $set: { nextPage: 1, startedAt: new Date(), finishedAt: null } },
      { upsert: true }
    )
  }
  const scan = await readRecentScan()
  const fromPage = Math.max(1, Number(scan?.nextPage) || 1)
  const toPage = fromPage + RECENT_FULL_CHUNK_PAGES - 1
  await assertLeading(shouldStop)
  const res = await mirror.scanGalleryRecent({
    fromPage,
    toPage,
    priority: 'background',
  })
  if (res?.error) {
    const err = new Error(
      `recent full scan failed at page ${fromPage}: ${res.error}`
    )
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
 * while it holds the 'crawler' lease.
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
    await jobs.enqueue({
      kind,
      dedupeKey: `maintenance:${kind}`,
      maxAttempts: 1,
    })
    await updateState({ $set: { [field]: new Date(now) } })
    queued.push(kind)
  }
  const lastSync = await lastFinishedSyncAt()
  if (dedupDue(state, runner, now, lastSync)) {
    await jobs.enqueue({
      kind: 'dedup',
      dedupeKey: 'maintenance:dedup',
      maxAttempts: 1,
    })
    const $set = { dedupAt: new Date(now) }
    if (lastSync) $set.dedupSyncSeenAt = lastSync
    await updateState({ $set })
    queued.push('dedup')
  }
  return queued
}

// The dedup pass runs after every sync run that finished since the last pass,
// and at least every dedupEveryMs (daily by default) otherwise.
function dedupDue(state, runner, now, lastSync) {
  if (lastSync && (!state.dedupSyncSeenAt || new Date(lastSync) > new Date(state.dedupSyncSeenAt))) {
    return true
  }
  return !state.dedupAt || olderThan(state.dedupAt, runner.dedupEveryMs || DAY, now)
}

// Finish time of the latest sync run that is no longer running, or null.
async function lastFinishedSyncAt() {
  try {
    const run = await runs().read()
    if (!run || run.state === 'running' || !run.finishedAt) return null
    return new Date(run.finishedAt)
  } catch {
    return null
  }
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
      if (err.code === 'scheduler_stopped') {
        currentStep = { step: 'standby', at: new Date() }
        sleepMs = 0
      } else {
        currentStep = { step: 'error', at: new Date(), error: err.message }
        if (err.code === 'host_backoff' || err.code === 'catalogue_stopped') {
          logWarn('mirror_scheduler_step_stopped', { code: err.code })
        } else {
          logError('mirror_scheduler_step_failed', err)
        }
        sleepMs = ERROR_SLEEP_MS
      }
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
  const state = await readState()
  return {
    leader: isLeader(),
    running: Boolean(loop),
    currentStep,
    gcAt: state.gcAt || null,
    integrityAt: state.integrityAt || null,
  }
}

export default {
  REQUEST_ACTIONS,
  requestRun,
  requestStop,
  enqueueMaintenanceIfDue,
  runStep,
  lead,
  yieldLeadership,
  stop,
  getStatus,
  setDependenciesForTests,
}
