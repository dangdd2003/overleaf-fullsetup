import os from 'node:os'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { runJobInline } from './jobs.mjs'
import { webError } from '../util.mjs'

const WORKER_SCRIPT = fileURLToPath(new URL('./worker.mjs', import.meta.url))
const DEFAULT_WORKER_COUNT = parseInt(
  process.env.AI_ASSIST_WEB_EXTRACT_WORKERS ?? '2',
  10
)
export const JOB_TIMEOUT_MS = 20_000
/** Extra time per million characters or bytes, so a large document is never cut off. */
const JOB_TIME_PER_MB_MS = 10_000
/**
 * A worker may use half the machine's memory: enough for any document the
 * machine can hold, while a runaway job still dies alone, not with the web
 * process.
 */
const WORKER_HEAP_MB = Math.max(
  512,
  Math.floor(os.totalmem() / 2 / 1024 / 1024)
)

/** How long a job may run: a stall guard that grows with the job's input. */
export function jobTimeoutFor(job, base = JOB_TIMEOUT_MS) {
  const size = job?.text?.length ?? job?.html?.length ?? job?.body?.length ?? 0
  return base + Math.floor(size / 1_000_000) * JOB_TIME_PER_MB_MS
}

export class ExtractWorkerPool {
  constructor({
    workerCount = DEFAULT_WORKER_COUNT,
    jobTimeoutMs = JOB_TIMEOUT_MS,
    workerScript = WORKER_SCRIPT,
  } = {}) {
    this.workerCount = workerCount
    this.jobTimeoutMs = jobTimeoutMs
    this.workerScript = workerScript
    this.workers = []
    this.idleWorkers = []
    this.queue = []
    this.nextJobId = 1
    this.activeJobs = new Map() // worker -> { jobId, timeout, resolve, reject, job }

    if (this.workerCount > 0) {
      for (let i = 0; i < this.workerCount; i++) {
        this._spawnWorker()
      }
    }
  }

  _spawnWorker() {
    const worker = new Worker(this.workerScript, {
      resourceLimits: {
        maxOldGenerationSizeMb: WORKER_HEAP_MB,
      },
    })

    worker.on('message', msg => {
      const active = this.activeJobs.get(worker)
      if (!active || active.jobId !== msg.id) return

      clearTimeout(active.timeout)
      this.activeJobs.delete(worker)

      if (msg.success) {
        active.resolve(msg.result)
      } else {
        active.reject(
          webError(msg.error?.message || 'Extraction failed', {
            kind: msg.error?.kind || 'content',
          })
        )
      }

      this.idleWorkers.push(worker)
      this._drainQueue()
    })

    worker.on('error', err => {
      const active = this.activeJobs.get(worker)
      if (active) {
        clearTimeout(active.timeout)
        this.activeJobs.delete(worker)
        active.reject(
          webError(
            `${active.job.url || 'Page'} could not be parsed: ${err.message}`,
            { kind: 'content' }
          )
        )
      }
      this._removeWorker(worker)
      if (this.workerCount > 0) this._spawnWorker()
    })

    worker.on('exit', () => {
      this._removeWorker(worker)
    })

    this.workers.push(worker)
    this.idleWorkers.push(worker)
  }

  _removeWorker(worker) {
    const wIdx = this.workers.indexOf(worker)
    if (wIdx !== -1) this.workers.splice(wIdx, 1)
    const iIdx = this.idleWorkers.indexOf(worker)
    if (iIdx !== -1) this.idleWorkers.splice(iIdx, 1)
  }

  _drainQueue() {
    if (this.idleWorkers.length === 0 || this.queue.length === 0) return
    const worker = this.idleWorkers.pop()
    const task = this.queue.shift()

    const timeout = setTimeout(
      () => {
        this.activeJobs.delete(worker)
        task.reject(
          webError(`${task.job.url || 'Page'} could not be parsed in time.`, {
            kind: 'content',
          })
        )
        worker.terminate()
        this._removeWorker(worker)
        if (this.workerCount > 0) {
          this._spawnWorker()
          this._drainQueue()
        }
      },
      jobTimeoutFor(task.job, this.jobTimeoutMs)
    )

    this.activeJobs.set(worker, {
      jobId: task.jobId,
      timeout,
      resolve: task.resolve,
      reject: task.reject,
      job: task.job,
    })

    worker.postMessage({ id: task.jobId, ...task.job })
  }

  async runJob(job) {
    if (this.workerCount <= 0) return runJobInline(job)

    return new Promise((resolve, reject) => {
      const jobId = this.nextJobId++
      this.queue.push({ jobId, job, resolve, reject })
      this._drainQueue()
    })
  }

  async destroy() {
    for (const [, active] of this.activeJobs) {
      clearTimeout(active.timeout)
      active.reject(webError('Worker pool stopped', { kind: 'content' }))
    }
    this.activeJobs.clear()
    this.queue = []
    await Promise.all(this.workers.map(w => w.terminate()))
    this.workers = []
    this.idleWorkers = []
  }
}

export const defaultExtractPool = new ExtractWorkerPool()

export function runExtractJob(job) {
  return defaultExtractPool.runJob(job)
}
