import { describe, it, afterEach } from 'vitest'
import { expect } from 'chai'
import {
  ExtractWorkerPool,
  runExtractJob,
} from '../../../../app/src/web-fetch/extract/pool.mjs'
import { makePdf } from './helpers/makePdf.mjs'

describe('ExtractWorkerPool', function () {
  let pool = null

  afterEach(async function () {
    if (pool) {
      await pool.destroy()
      pool = null
    }
  })

  it('runs inline when worker count is 0', async function () {
    pool = new ExtractWorkerPool({ workerCount: 0 })
    const res = await pool.runJob({
      kind: 'html',
      html: '<html><head><title>Hello inline</title></head><body><h1>Hello inline</h1><p>Test paragraph content here.</p></body></html>',
      url: 'https://example.com/inline',
    })
    expect(res.markdown).to.include('Hello inline')
    expect(res.title).to.include('Hello inline')
  })

  it('refuses to parse a PDF on the calling thread', async function () {
    pool = new ExtractWorkerPool({ workerCount: 0 })
    let err
    try {
      await pool.runJob({ kind: 'pdf', body: makePdf(['Hello']), url: 'https://x.org/a.pdf' })
    } catch (e) {
      err = e
    }
    expect(err?.kind).to.equal('content')
    expect(err.message).to.match(/worker thread/)
  })

  it('parses a PDF in a worker thread', async function () {
    pool = new ExtractWorkerPool({ workerCount: 1 })
    const workerBefore = pool.workers[0]
    const res = await pool.runJob({
      kind: 'pdf',
      body: makePdf(['Parsed in a worker. '.repeat(8)], 'Worker PDF'),
      url: 'https://x.org/a.pdf',
    })
    expect(res.text).to.include('Parsed in a worker')
    expect(res.title).to.equal('Worker PDF')
    // The job ran on a pool worker, not in this thread
    expect(pool.workers).to.include(workerBefore)
  })

  it('runs jobs through worker threads when worker count > 0', async function () {
    pool = new ExtractWorkerPool({ workerCount: 1 })
    const res = await pool.runJob({
      kind: 'html',
      html: '<html><head><title>Worker Title</title></head><body><main><h1>Worker Title</h1><p>Some body text in worker.</p></main></body></html>',
      url: 'https://example.com/worker',
    })
    expect(res.markdown).to.include('Worker Title')
    expect(res.title).to.equal('Worker Title')
  })

  it('terminates worker on timeout and rejects with content webError', async function () {
    pool = new ExtractWorkerPool({
      workerCount: 1,
      jobTimeoutMs: 50,
      workerScript: new URL('./helpers/slow-worker.mjs', import.meta.url)
        .pathname,
    })

    let error = null
    try {
      await pool.runJob({
        kind: 'hang',
      })
    } catch (err) {
      error = err
    }

    expect(error).to.exist
    expect(error.kind).to.equal('content')
    expect(error.message).to.include('could not be parsed in time')
  })

  it('refuses a job past the queue bound instead of queuing it', async function () {
    pool = new ExtractWorkerPool({
      workerCount: 1,
      maxQueued: 1,
      jobTimeoutMs: 60_000,
      workerScript: new URL('./helpers/slow-worker.mjs', import.meta.url)
        .pathname,
    })
    // One job runs, one waits; the third is refused at once
    const running = pool.runJob({ kind: 'hang' }).catch(() => {})
    const queued = pool.runJob({ kind: 'hang' }).catch(() => {})
    let error = null
    try {
      await pool.runJob({ kind: 'hang' })
    } catch (err) {
      error = err
    }
    expect(error?.kind).to.equal('network')
    expect(error.message).to.include('Too many pages')
    expect(pool.queue.length).to.equal(1)
    await pool.destroy()
    await Promise.all([running, queued])
  })

  it('settles the jobs still queued when the pool is destroyed', async function () {
    pool = new ExtractWorkerPool({
      workerCount: 1,
      jobTimeoutMs: 60_000,
      workerScript: new URL('./helpers/slow-worker.mjs', import.meta.url)
        .pathname,
    })
    pool.runJob({ kind: 'hang' }).catch(() => {})
    // Handled from the start: destroy() settles it before the test awaits
    const queued = pool.runJob({ kind: 'hang' }).catch(err => err)
    await pool.destroy()
    expect((await queued).message).to.include('Worker pool stopped')
  })

  it('runs a queued job on a new worker after the worker running another job crashes', async function () {
    pool = new ExtractWorkerPool({
      workerCount: 1,
      jobTimeoutMs: 10_000,
      workerScript: new URL('./helpers/crash-worker.mjs', import.meta.url)
        .pathname,
    })
    const crashed = pool.runJob({ kind: 'crash' }).catch(err => err)
    const next = pool.runJob({ kind: 'ok' })
    expect((await crashed).kind).to.equal('content')
    const res = await next
    expect(res).to.deep.equal({ ok: true })
  })
})
