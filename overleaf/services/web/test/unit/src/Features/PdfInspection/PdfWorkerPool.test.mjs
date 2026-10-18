import { describe, it, expect, afterEach } from 'vitest'
import {
  PdfWorkerPool,
  PdfWorkerError,
  jobTimeoutFor,
  PDF_JOB_TIMEOUT_MS,
  PDF_JOB_TIME_PER_MB_MS,
  PDF_WORKER_COUNT,
  defaultPdfWorkerPool,
} from '../../../../../app/src/Features/PdfInspection/PdfWorkerPool.mjs'
import { makePdf } from './helpers/makePdf.mjs'

// A transferable ArrayBuffer of exactly the buffer's bytes: a small Buffer shares
// a pooled slab, and transferring that would move the whole slab.
const exactArrayBuffer = buf => new Uint8Array(buf).buffer

const helper = name =>
  new URL(`./helpers/${name}`, import.meta.url).pathname

describe('PdfWorkerPool', function () {
  let pool = null

  afterEach(async function () {
    if (pool) {
      await pool.destroy()
      pool = null
    }
  })

  it('spawns no worker until a job is run', async function () {
    pool = new PdfWorkerPool({ workerScript: helper('crash-worker.mjs') })
    expect(pool.workers).toHaveLength(0)
    expect(pool.workerCount).toBe(PDF_WORKER_COUNT)
    const res = await pool.run({ kind: 'ok' })
    expect(res).toEqual({ ok: true })
    expect(pool.workers).toHaveLength(1)
  })

  it('does not spawn a worker when the shared pool is created', function () {
    expect(defaultPdfWorkerPool.workers).toHaveLength(0)
  })

  it('never falls back to zero workers', function () {
    pool = new PdfWorkerPool({ workerCount: 0 })
    expect(pool.workerCount).toBe(PDF_WORKER_COUNT)
  })

  it('terminates a worker that overruns the timeout and rejects with a timeout error', async function () {
    pool = new PdfWorkerPool({
      workerCount: 1,
      jobTimeoutMs: 50,
      workerScript: helper('hang-worker.mjs'),
    })
    let error = null
    try {
      await pool.run({ kind: 'hang' })
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(PdfWorkerError)
    expect(error.code).toBe('timeout')
    expect(error.message).toContain('could not be read in time')
    expect(pool.workers).toHaveLength(0)
  })

  it('grows the timeout with the bytes a job carries', function () {
    expect(jobTimeoutFor(0)).toBe(PDF_JOB_TIMEOUT_MS)
    expect(jobTimeoutFor(3 * 1024 * 1024)).toBe(
      PDF_JOB_TIMEOUT_MS + 3 * PDF_JOB_TIME_PER_MB_MS
    )
  })

  it('refuses a read past the queue bound instead of queuing it', async function () {
    pool = new PdfWorkerPool({
      workerCount: 1,
      maxQueued: 1,
      jobTimeoutMs: 60_000,
      workerScript: helper('hang-worker.mjs'),
    })
    // One read runs, one waits; the third is refused at once
    const running = pool.run({ kind: 'hang' }).catch(err => err)
    const queued = pool.run({ kind: 'hang' }).catch(err => err)
    let error = null
    try {
      await pool.run({ kind: 'hang' })
    } catch (err) {
      error = err
    }
    expect(error.code).toBe('busy')
    expect(error.message).toContain('Too many PDFs')
    expect(pool.queue).toHaveLength(1)
    await pool.destroy()
    expect((await running).code).toBe('stopped')
    expect((await queued).code).toBe('stopped')
  })

  it('fails only the job whose worker crashed, and runs the next on a new worker', async function () {
    pool = new PdfWorkerPool({
      workerCount: 1,
      jobTimeoutMs: 10_000,
      workerScript: helper('crash-worker.mjs'),
    })
    const crashed = pool.run({ kind: 'crash' }).catch(err => err)
    const next = pool.run({ kind: 'ok' })
    const error = await crashed
    expect(error).toBeInstanceOf(PdfWorkerError)
    expect(error.code).toBe('crashed')
    expect(await next).toEqual({ ok: true })
  })

  it('settles the jobs still queued when the pool is destroyed', async function () {
    pool = new PdfWorkerPool({
      workerCount: 1,
      jobTimeoutMs: 60_000,
      workerScript: helper('hang-worker.mjs'),
    })
    const running = pool.run({ kind: 'hang' }).catch(err => err)
    const queued = pool.run({ kind: 'hang' }).catch(err => err)
    await pool.destroy()
    expect((await running).code).toBe('stopped')
    expect((await queued).message).toContain('has stopped')
    expect(pool.workers).toHaveLength(0)
  })

  it('refuses jobs once destroyed', async function () {
    pool = new PdfWorkerPool({ workerScript: helper('crash-worker.mjs') })
    await pool.destroy()
    let error = null
    try {
      await pool.run({ kind: 'ok' })
    } catch (err) {
      error = err
    }
    expect(error.code).toBe('stopped')
  })

  describe('with the real PDF worker under Yarn PnP', function () {
    it('loads pdf.js in the worker and returns the page readings', async function () {
      pool = new PdfWorkerPool({ workerCount: 1 })
      const bytes = exactArrayBuffer(makePdf('Hello worker'))
      const result = await pool.run({ bytes }, [bytes])
      expect(result.pageCount).toBe(1)
      expect(result.pages).toHaveLength(1)
      const text = result.pages[0].items.map(item => item.s).join('')
      expect(text).toContain('Hello')
      expect(result.pages[0].width).toBe(612)
    })

    it('reports bytes that are not a PDF as not_a_pdf', async function () {
      pool = new PdfWorkerPool({ workerCount: 1 })
      const bytes = exactArrayBuffer(Buffer.from('plain text, not a PDF'))
      let error = null
      try {
        await pool.run({ bytes }, [bytes])
      } catch (err) {
        error = err
      }
      expect(error.code).toBe('not_a_pdf')
    })
  })
})
