import { Worker } from 'node:worker_threads'

// Runs in a separate thread. `eval: true` workers are CommonJS scripts, so
// require() is available. Verified on Node 24 on 2026-09-17.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const { query, flags, docs, limit } = workerData
const re = new RegExp(query, flags)
const hits = []
let total = 0
for (const doc of docs) {
  for (let i = 0; i < doc.lines.length; i++) {
    if (re.test(doc.lines[i])) {
      total++
      if (hits.length < limit) hits.push({ path: doc.path, line: i + 1 })
    }
  }
}
parentPort.postMessage({ hits, total })
`

/**
 * Searches run at once only this many to a process. Each one is a thread that
 * copies the project's text and may use a full core until it finishes or times
 * out, so a turn that asks for many at once must queue, not multiply.
 */
const MAX_CONCURRENT_SEARCHES = 2
let running = 0
const waiting = []

function acquireSlot(signal) {
  if (signal?.aborted) return Promise.reject(abortError())
  if (running < MAX_CONCURRENT_SEARCHES) {
    running++
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const entry = {
      resolve: () => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      },
      onAbort: null,
    }
    const onAbort = () => {
      const idx = waiting.indexOf(entry)
      if (idx !== -1) waiting.splice(idx, 1)
      reject(abortError())
    }
    entry.onAbort = onAbort
    signal?.addEventListener('abort', onAbort, { once: true })
    waiting.push(entry)
  })
}

function releaseSlot() {
  const next = waiting.shift()
  if (next) next.resolve()
  else running--
}

// Text copied into the worker per search, in characters. A large project is
// searched in its first documents, and the result says how many were skipped.
export const MAX_SEARCH_COPY_CHARS = 20 * 1024 * 1024

function capDocsForWorker(docs) {
  const kept = []
  let used = 0
  let skipped = 0
  for (const doc of docs) {
    const lines = doc.lines || []
    let size = 0
    for (const line of lines) size += line.length + 1
    if (used + size > MAX_SEARCH_COPY_CHARS) {
      skipped++
      continue
    }
    used += size
    kept.push(doc)
  }
  return { kept, skipped }
}

/**
 * Line-by-line regex search over project documents, off the main thread.
 *
 * The pattern comes from a model. JavaScript regexes cannot be interrupted, so
 * a catastrophic pattern such as (a+)+$ would freeze the web process for every
 * user. A worker can be terminated when it overruns, or when `signal` aborts.
 * Resolves with { hits, total, skippedDocs }.
 */
export async function regexSearch({
  query,
  caseSensitive,
  docs,
  limit,
  timeoutMs = 2000,
  signal,
}) {
  const flags = caseSensitive ? '' : 'i'
  // Compile once here so an invalid pattern fails fast, without a thread.
  // eslint-disable-next-line no-new
  new RegExp(query, flags)

  const { kept, skipped } = capDocsForWorker(docs)
  await acquireSlot(signal)
  try {
    if (signal?.aborted) throw abortError()
    const result = await runWorker({
      query,
      flags,
      docs: kept,
      limit,
      timeoutMs,
      signal,
    })
    return { ...result, skippedDocs: skipped }
  } finally {
    releaseSlot()
  }
}

function abortError() {
  const err = new Error('Search was cancelled.')
  err.code = 'aborted'
  return err
}

function runWorker({ query, flags, docs, limit, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    let settled = false
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        query,
        flags,
        docs: docs.map(doc => ({ path: doc.path, lines: doc.lines || [] })),
        limit,
      },
    })

    const finish = () => {
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const timer = setTimeout(() => {
      if (settled) return
      finish()
      void worker.terminate()
      const err = new Error(
        'The regular expression took too long to run. Simplify it or search for a plain string.'
      )
      err.code = 'regexTimeout'
      reject(err)
    }, timeoutMs)
    timer.unref?.()
    const onAbort = () => {
      if (settled) return
      finish()
      void worker.terminate()
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    worker.once('message', message => {
      if (settled) return
      finish()
      void worker.terminate()
      resolve(message)
    })
    worker.once('error', err => {
      if (settled) return
      finish()
      reject(err)
    })
    worker.once('exit', code => {
      if (settled) return
      finish()
      reject(new Error(`Search worker exited unexpectedly (code ${code})`))
    })
  })
}
