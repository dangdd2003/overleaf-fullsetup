// overleaf/services/web/modules/template-gallery/app/src/jobs/SyncRun.mjs
import crypto from 'node:crypto'
import { configCol } from '../persistence/Collections.mjs'

// One sync run at a time, stored in the config collection (not part of the
// volume snapshot, so frequent progress writes never trigger an export).
// The document holds the current run, or the last one once it has finished,
// so a restart resumes a running run from its stored phase and counters.
//
// A run walks its phases in order:
//   catalogue  template list (Algolia)
//   new        featured blocks + newest gallery pages
//   rescan     full gallery listing walk (only when asked for)
//   details    detail page + PDF of every missing or outdated template
//   tags       tag pages
const DOC_ID = 'syncRun'
export const PHASES = Object.freeze([
  'catalogue',
  'new',
  'rescan',
  'details',
  'tags',
])
// A leader that stopped writing for this long is gone: its in-flight list is
// no longer shown as syncing.
const LIVE_MS = 30_000

function newPhase(name, skipped) {
  return {
    name,
    state: skipped ? 'skipped' : 'pending',
    done: 0,
    failed: 0,
    total: null,
    startedAt: null,
    finishedAt: null,
    error: null,
  }
}

/**
 * The stored run (current or last), or null when none ever ran.
 */
export async function read() {
  const col = await configCol()
  return col.findOne({ _id: DOC_ID })
}

/**
 * The running run, or null.
 */
export async function current() {
  const run = await read()
  return run?.state === 'running' ? run : null
}

/**
 * Starts a run unless one is running. Throws code 'run_active' otherwise.
 *
 * @param {{ trigger: 'manual'|'auto', requestedBy?: string|null, rescan?: boolean, refetchMs: number }} opts
 */
export async function start({ trigger, requestedBy = null, rescan, refetchMs }) {
  const now = new Date()
  const run = {
    id: crypto.randomBytes(8).toString('hex'),
    state: 'running',
    trigger,
    requestedBy,
    rescan: Boolean(rescan),
    // Templates synced before this are fetched again; fixed for the whole run
    refetchBefore: new Date(now.getTime() - refetchMs),
    phases: PHASES.map(name => newPhase(name, name === 'rescan' && !rescan)),
    inFlight: [],
    cancelRequested: false,
    waitingUntil: null,
    error: null,
    startedAt: now,
    finishedAt: null,
    updatedAt: now,
  }
  const col = await configCol()
  try {
    await col.updateOne(
      { _id: DOC_ID, state: { $ne: 'running' } },
      { $set: run },
      { upsert: true }
    )
  } catch (err) {
    // The upsert collides with the existing running run
    if (err?.code === 11000) throw runActiveError()
    throw err
  }
  const stored = await read()
  if (stored?.id !== run.id) throw runActiveError()
  return stored
}

function runActiveError() {
  const err = new Error('a sync is already running')
  err.code = 'run_active'
  return err
}

/**
 * Asks the running run to stop. Throws code 'not_running' when none runs.
 */
export async function requestStop() {
  const col = await configCol()
  const res = await col.updateOne(
    { _id: DOC_ID, state: 'running' },
    { $set: { cancelRequested: true, updatedAt: new Date() } }
  )
  if (!res?.matchedCount) {
    const err = new Error('no sync is running')
    err.code = 'not_running'
    throw err
  }
}

/**
 * Updates fields of the running run with this id. Phase fields use the
 * phase name: { phase: 'details', fields: { done: 3 } }.
 */
export async function update(runId, { fields = {}, phase, phaseFields = {} } = {}) {
  const set = { ...fields, updatedAt: new Date() }
  if (phase) {
    const index = PHASES.indexOf(phase)
    for (const [key, value] of Object.entries(phaseFields)) {
      set[`phases.${index}.${key}`] = value
    }
  }
  const col = await configCol()
  await col.updateOne({ _id: DOC_ID, id: runId, state: 'running' }, { $set: set })
}

export async function finish(runId, state, error = null) {
  const col = await configCol()
  const now = new Date()
  await col.updateOne(
    { _id: DOC_ID, id: runId, state: 'running' },
    {
      $set: {
        state,
        error,
        inFlight: [],
        waitingUntil: null,
        finishedAt: now,
        updatedAt: now,
      },
    }
  )
}

/**
 * Tokens being fetched right now.
 *
 * @returns {Promise<Set<string>>}
 */
export async function syncingTokens() {
  const run = await read()
  const live =
    run?.state === 'running' &&
    run.updatedAt &&
    Date.now() - new Date(run.updatedAt).getTime() < LIVE_MS
  return new Set(live && Array.isArray(run.inFlight) ? run.inFlight : [])
}

/**
 * Admin view of the run; null when none ever ran.
 */
export function view(run) {
  if (!run) return null
  const iso = value => (value ? new Date(value).toISOString() : null)
  return {
    id: run.id,
    state: run.state,
    trigger: run.trigger,
    rescan: Boolean(run.rescan),
    stopping: Boolean(run.cancelRequested) && run.state === 'running',
    waitingUntil: iso(run.waitingUntil),
    error: run.error || null,
    startedAt: iso(run.startedAt),
    finishedAt: iso(run.finishedAt),
    phases: (run.phases || []).map(phase => ({
      name: phase.name,
      state: phase.state,
      done: phase.done || 0,
      failed: phase.failed || 0,
      total: phase.total ?? null,
    })),
  }
}

export default {
  PHASES,
  read,
  current,
  start,
  requestStop,
  update,
  finish,
  syncingTokens,
  view,
}
