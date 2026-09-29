import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import defaultStore, { TERMINAL_STATUSES } from './AiAssistRunStore.mjs'
import defaultControl from './AiAssistRunControl.mjs'

// The sweep interval (30s) must be shorter than the orphan grace (300s),
// or a run can sit abandoned for grace + interval before anyone notices.
const SWEEP_INTERVAL_MS = 30_000

export class AiAssistRunReaper {
  constructor({ store = defaultStore, control = defaultControl } = {}) {
    this.store = store
    this.control = control
    this._timer = null
  }

  start() {
    if (this._timer) return
    this._timer = setInterval(() => {
      this.sweepOnce().catch(err => {
        logger.warn({ err }, 'error in ai-assist orphan reaper sweep')
      })
    }, SWEEP_INTERVAL_MS)
    this._timer.unref?.()
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  }

  async sweepOnce() {
    const graceMs = (Settings.aiAssist?.orphanGraceSeconds ?? 300) * 1000
    if (graceMs <= 0) return [] // reaping disabled
    const heartbeatStaleMs = (Settings.aiAssist?.heartbeatStaleSeconds ?? 1800) * 1000

    const cancelled = []
    for (const runId of await this.store.getActiveRuns()) {
      const run = await this.store.getRun(runId)
      if (!run) continue
      if (TERMINAL_STATUSES.includes(run.status)) continue

      const watchers = Number(run.watchers || 0)
      if (watchers > 0) {
        if (run.zeroSince) await this.store.clearZeroSince(runId)
        continue
      }

      const zeroSince = Number(run.zeroSince || 0)
      if (!zeroSince) {
        // First time we have seen it unwatched: stamp it, do not act yet.
        await this.store.setZeroSince(runId, Date.now())
        continue
      }
      if (Date.now() - zeroSince < graceMs) continue

      // Re-read immediately before acting: a watcher may have reconnected
      // while this sweep was walking the index.
      const fresh = await this.store.getRun(runId)
      if (!fresh || Number(fresh.watchers || 0) > 0) continue
      if (TERMINAL_STATUSES.includes(fresh.status)) continue

      await this.control.publish(runId, { action: 'stop' })
      cancelled.push(runId)
    }

    // Separate concern: runs whose driving process is gone.
    await this.store.reconcileStaleRuns({ heartbeatStaleMs })
    return cancelled
  }
}

export default new AiAssistRunReaper()
