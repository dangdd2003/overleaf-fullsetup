import { describe, it, afterEach } from 'vitest'
import { expect } from 'chai'
import {
  ExtractWorkerPool,
  runExtractJob,
} from '../../../../app/src/web-fetch/extract/pool.mjs'

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
})
