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

function acquireSlot() {
  if (running < MAX_CONCURRENT_SEARCHES) {
    running++
    return Promise.resolve()
  }
  return new Promise(resolve => waiting.push(resolve))
}

function releaseSlot() {
  const next = waiting.shift()
  if (next) next()
  else running--
}

/**
 * Line-by-line regex search over project documents, off the main thread.
 *
 * The pattern comes from a model. JavaScript regexes cannot be interrupted, so
 * a catastrophic pattern such as (a+)+$ would freeze the web process for every
 * user. A worker can be terminated when it overruns.
 */
export async function regexSearch({ query, caseSensitive, docs, limit, timeoutMs = 2000 }) {
  const flags = caseSensitive ? '' : 'i'
  // Compile once here so an invalid pattern fails fast, without a thread.
  // eslint-disable-next-line no-new
  new RegExp(query, flags)

  await acquireSlot()
  try {
    return await runWorker({ query, flags, docs, limit, timeoutMs })
  } finally {
    releaseSlot()
  }
}

function runWorker({ query, flags, docs, limit, timeoutMs }) {
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

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      void worker.terminate()
      const err = new Error(
        'The regular expression took too long to run. Simplify it or search for a plain string.'
      )
      err.code = 'regexTimeout'
      reject(err)
    }, timeoutMs)
    timer.unref?.()

    worker.once('message', message => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      resolve(message)
    })
    worker.once('error', err => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
  })
}
