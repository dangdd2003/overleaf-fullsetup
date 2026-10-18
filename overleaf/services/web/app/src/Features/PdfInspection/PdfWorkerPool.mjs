// A small pool of worker threads that parse untrusted PDFs with pdf.js, so the
// parser never runs on the web process's main thread. A job that overruns is
// terminated; a worker that crashes fails only its own job and is replaced on
// demand. Workers start lazily: nothing is spawned until a PDF is read.

import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'

const WORKER_SCRIPT = fileURLToPath(new URL('./PdfWorker.mjs', import.meta.url))
/** Workers in the pool. Two reads can run at once; more would multiply memory. */
export const PDF_WORKER_COUNT = 2
/** Heap cap for each worker. A PDF that needs more fails in its worker alone. */
export const PDF_WORKER_HEAP_MB = 512
/** Wall-clock budget for a read, plus JOB_TIME_PER_MB_MS per megabyte of PDF. */
export const PDF_JOB_TIMEOUT_MS = 30_000
export const PDF_JOB_TIME_PER_MB_MS = 1_000
/**
 * Reads waiting for a worker. Each holds its PDF bytes, so the bound is small:
 * past it a read is refused rather than queued.
 */
export const PDF_MAX_QUEUED_JOBS = 4

const MB = 1024 * 1024

export class PdfWorkerError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'PdfWorkerError'
    this.code = code
  }
}

/** How long a job may run, growing with the bytes it carries. */
export function jobTimeoutFor(byteLength, base = PDF_JOB_TIMEOUT_MS) {
  return base + Math.floor(byteLength / MB) * PDF_JOB_TIME_PER_MB_MS
}

export class PdfWorkerPool {
  constructor({
    workerCount = PDF_WORKER_COUNT,
    jobTimeoutMs = PDF_JOB_TIMEOUT_MS,
    maxQueued = PDF_MAX_QUEUED_JOBS,
    maxOldGenerationSizeMb = PDF_WORKER_HEAP_MB,
    workerScript = WORKER_SCRIPT,
  } = {}) {
    // Never zero: with no worker a PDF would be parsed on the web thread.
    this.workerCount =
      Number.isInteger(workerCount) && workerCount >= 1
        ? workerCount
        : PDF_WORKER_COUNT
    this.jobTimeoutMs = jobTimeoutMs
    this.maxQueued = maxQueued
    this.maxOldGenerationSizeMb = maxOldGenerationSizeMb
    this.workerScript = workerScript
    this.workers = []
    this.idleWorkers = []
    this.queue = []
    this.activeJobs = new Map() // worker -> { id, timer, resolve, reject }
    this.nextJobId = 1
    this.closed = false
  }

  /**
   * Runs one job on a worker and resolves with its result. `payload` is posted
   * to the worker; each ArrayBuffer in `transfer` moves to it rather than being
   * copied, and their total size sets the job's timeout.
   */
  run(payload, transfer = []) {
    if (this.closed) {
      return Promise.reject(new PdfWorkerError('stopped', 'The PDF reader has stopped.'))
    }
    if (this.queue.length >= this.maxQueued) {
      return Promise.reject(
        new PdfWorkerError(
          'busy',
          'Too many PDFs are being read at the same time. Try again in a moment.'
        )
      )
    }
    return new Promise((resolve, reject) => {
      const byteLength = transfer.reduce((n, buf) => n + buf.byteLength, 0)
      this.queue.push({
        id: this.nextJobId++,
        payload,
        transfer,
        timeoutMs: jobTimeoutFor(byteLength, this.jobTimeoutMs),
        resolve,
        reject,
      })
      this._drainQueue()
    })
  }

  _spawnWorker() {
    const worker = new Worker(this.workerScript, {
      resourceLimits: { maxOldGenerationSizeMb: this.maxOldGenerationSizeMb },
    })
    worker.on('message', msg => this._onMessage(worker, msg))
    worker.on('error', err => {
      this._failActive(worker, 'crashed', `The PDF reader crashed: ${err.message}`)
      this._retire(worker)
    })
    worker.on('exit', () => {
      this._failActive(worker, 'crashed', 'The PDF reader stopped while reading the PDF.')
      this._retire(worker)
    })
    this.workers.push(worker)
    this.idleWorkers.push(worker)
  }

  _drainQueue() {
    while (!this.closed && this.queue.length > 0) {
      if (this.idleWorkers.length === 0) {
        if (this.workers.length >= this.workerCount) return
        this._spawnWorker()
      }
      this._dispatch(this.idleWorkers.pop(), this.queue.shift())
    }
  }

  _dispatch(worker, job) {
    const timer = setTimeout(() => {
      this._failActive(worker, 'timeout', 'The PDF could not be read in time.')
      this._retire(worker)
    }, job.timeoutMs)
    this.activeJobs.set(worker, {
      id: job.id,
      timer,
      resolve: job.resolve,
      reject: job.reject,
    })
    try {
      worker.postMessage({ id: job.id, ...job.payload }, job.transfer)
    } catch (err) {
      this._takeActive(worker)
      this.idleWorkers.push(worker)
      job.reject(err)
    }
  }

  _onMessage(worker, msg) {
    const active = this.activeJobs.get(worker)
    if (!active || active.id !== msg.id) return
    this._takeActive(worker)
    if (msg.success) {
      active.resolve(msg.result)
    } else {
      active.reject(
        new PdfWorkerError(
          msg.error?.code ?? 'failed',
          msg.error?.message ?? 'The PDF could not be read.'
        )
      )
    }
    this.idleWorkers.push(worker)
    this._drainQueue()
  }

  _takeActive(worker) {
    const active = this.activeJobs.get(worker)
    if (active) {
      clearTimeout(active.timer)
      this.activeJobs.delete(worker)
    }
    return active
  }

  _failActive(worker, code, message) {
    this._takeActive(worker)?.reject(new PdfWorkerError(code, message))
  }

  /** Drops a worker that failed or overran; its replacement starts when a job needs one. */
  _retire(worker) {
    this._takeActive(worker)
    const w = this.workers.indexOf(worker)
    if (w !== -1) this.workers.splice(w, 1)
    const i = this.idleWorkers.indexOf(worker)
    if (i !== -1) this.idleWorkers.splice(i, 1)
    worker.terminate().catch(() => {})
    this._drainQueue()
  }

  async destroy() {
    this.closed = true
    for (const active of this.activeJobs.values()) {
      clearTimeout(active.timer)
      active.reject(new PdfWorkerError('stopped', 'The PDF reader has stopped.'))
    }
    this.activeJobs.clear()
    for (const job of this.queue) {
      job.reject(new PdfWorkerError('stopped', 'The PDF reader has stopped.'))
    }
    this.queue = []
    const workers = this.workers
    this.workers = []
    this.idleWorkers = []
    await Promise.all(workers.map(w => w.terminate()))
  }
}

/** The pool PDF reads share. Creating it spawns no worker. */
export const defaultPdfWorkerPool = new PdfWorkerPool()
