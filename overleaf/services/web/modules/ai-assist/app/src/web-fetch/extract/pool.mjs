import os from 'node:os'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { runJobInline } from './jobs.mjs'
import { webError } from '../util.mjs'

const WORKER_SCRIPT = fileURLToPath(new URL('./worker.mjs', import.meta.url))
const DEFAULT_WORKER_COUNT = 2
const JOB_TIMEOUT_MS = 20_000
/** Extra time per million characters or bytes, so a large document is never cut off. */
const JOB_TIME_PER_MB_MS = 10_000
/**
 * Jobs waiting for a worker. Past this a read is refused rather than queued:
 * a job whose read has already timed out would otherwise hold memory until it ran.
 */
const MAX_QUEUED_JOBS = 32
/**
 * Each worker may use a quarter of the machine's memory, so the default two
 * together stay within half of it, and a runaway job dies alone, not with the
 * web process.
 */
const WORKER_HEAP_MB = Math.max(
  512,
  Math.floor(os.totalmem() / 4 / 1024 / 1024)
)

/** How long a job may run: a stall guard that grows with the job's input. */
function jobTimeoutFor(job, base = JOB_TIMEOUT_MS) {
  const size = job?.text?.length ?? job?.html?.length ?? job?.body?.length ?? 0
  return base + Math.floor(size / 1_000_000) * JOB_TIME_PER_MB_MS
}

export class ExtractWorkerPool {
  constructor({
    workerCount = DEFAULT_WORKER_COUNT,
    jobTimeoutMs = JOB_TIMEOUT_MS,
    workerScript = WORKER_SCRIPT,
    maxQueued = MAX_QUEUED_JOBS,
  } = {}) {
    this.workerCount = workerCount
    this.jobTimeoutMs = jobTimeoutMs
    this.workerScript = workerScript
    this.maxQueued = maxQueued
    this.workers = []
    this.idleWorkers = []
    this.queue = []
    this.nextJobId = 1
    this.closed = false
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
      this._settleActive(worker, err.message)
      this._removeWorker(worker)
      // Jobs still queued must not wait for a worker that may never come
      this._drainQueue()
    })

    worker.on('exit', () => {
      // A worker that exits mid-job answers that job now, not at its timeout
      this._settleActive(worker, 'the worker stopped.')
      this._removeWorker(worker)
      this._drainQueue()
    })

    this.workers.push(worker)
    this.idleWorkers.push(worker)
  }

  /** Fails the job `worker` is running, if any, with a content error. */
  _settleActive(worker, detail) {
    const active = this.activeJobs.get(worker)
    if (!active) return
    clearTimeout(active.timeout)
    this.activeJobs.delete(worker)
    active.reject(
      webError(`${active.job.url || 'Page'} could not be parsed: ${detail}`, {
        kind: 'content',
      })
    )
  }

  _removeWorker(worker) {
    const wIdx = this.workers.indexOf(worker)
    if (wIdx !== -1) this.workers.splice(wIdx, 1)
    const iIdx = this.idleWorkers.indexOf(worker)
    if (iIdx !== -1) this.idleWorkers.splice(iIdx, 1)
  }

  _drainQueue() {
    if (this.closed || this.queue.length === 0) return
    if (this.idleWorkers.length === 0) {
      // A worker is replaced only when a job needs one: a worker script that
      // dies on start-up must not respawn in a loop
      if (this.workers.length >= this.workerCount) return
      this._spawnWorker()
    }
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
        this._drainQueue()
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
    if (this.workerCount <= 0) {
      // PDF bytes come from the web and pdf.js parses them: never on the web
      // process's own thread, which only a worker may do
      if (job.kind === 'pdf') {
        throw webError('PDFs are read in a worker thread, not in this process.', {
          kind: 'content',
        })
      }
      return runJobInline(job)
    }
    if (this.closed) {
      throw webError('Worker pool stopped', { kind: 'content' })
    }
    // Refused as a network fault: the read moves on, and the page can be read
    // again once the queue has drained
    if (this.queue.length >= this.maxQueued) {
      throw webError(
        'Too many pages are being read at the same time. Try again in a moment.',
        { kind: 'network' }
      )
    }

    return new Promise((resolve, reject) => {
      const jobId = this.nextJobId++
      this.queue.push({ jobId, job, resolve, reject })
      this._drainQueue()
    })
  }

  async destroy() {
    this.closed = true
    for (const [, active] of this.activeJobs) {
      clearTimeout(active.timeout)
      active.reject(webError('Worker pool stopped', { kind: 'content' }))
    }
    this.activeJobs.clear()
    // Queued jobs get the same answer: their callers are waiting on them
    for (const task of this.queue) {
      task.reject(webError('Worker pool stopped', { kind: 'content' }))
    }
    this.queue = []
    await Promise.all(this.workers.map(w => w.terminate()))
    this.workers = []
    this.idleWorkers = []
  }
}

const defaultExtractPool = new ExtractWorkerPool()

export function runExtractJob(job) {
  return defaultExtractPool.runJob(job)
}
