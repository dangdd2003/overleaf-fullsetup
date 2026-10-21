import { Worker } from 'node:worker_threads'

// `eval: true` workers are CommonJS scripts, so require() is available.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const { query, flags, docs, limit } = workerData
const re = new RegExp(query, flags)
const hits = []
search: for (let d = 0; d < docs.length; d++) {
  const lines = docs[d]
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i] || '')) {
      hits.push({ doc: d, line: i })
      if (hits.length >= limit) break search
    }
  }
}
parentPort.postMessage(hits)
`

// A search that runs longer than this is stopped. Each search holds a worker
// thread and a copy of the project text, so an unbounded search would let one
// catastrophic pattern tie up resources until the client gave up.
export const REGEX_SEARCH_TIMEOUT_MS = 10 * 1000

// Searches that may hold a worker thread at once in this process. A search
// beyond this is refused (SearchBusyError) rather than queued, so a burst of
// requests cannot start unbounded threads.
export const MAX_CONCURRENT_SEARCHES = 4
let activeSearches = 0

/**
 * Line-by-line regex search over document lines, off the main thread.
 *
 * The pattern comes from an MCP client. JavaScript regexes cannot be
 * interrupted, so a catastrophic pattern such as (a+)+$ would freeze the web
 * process for every user; the search runs in a worker instead. The worker is
 * terminated when `signal` aborts (the client disconnected) or when the search
 * runs past `timeoutMs`, which rejects with a RegexTimeoutError.
 *
 * @param {object} options
 * @param {string} options.query the pattern, already checked to compile
 * @param {boolean} options.caseSensitive
 * @param {string[][]} options.docs each document's lines
 * @param {number} options.limit stop after this many matching lines
 * @param {AbortSignal} [options.signal] stops the search when aborted
 * @param {number} [options.timeoutMs]
 * @returns {Promise<Array<{doc: number, line: number}>>} zero-based indexes
 */
export function regexSearchLines({
  query,
  caseSensitive,
  docs,
  limit,
  signal,
  timeoutMs = REGEX_SEARCH_TIMEOUT_MS,
}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(abortError())
    }
    if (activeSearches >= MAX_CONCURRENT_SEARCHES) {
      const err = new Error('too many regular expression searches are running')
      err.name = 'SearchBusyError'
      return reject(err)
    }
    let settled = false
    let timer
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { query, flags: caseSensitive ? '' : 'i', docs, limit },
    })
    activeSearches++
    const finish = (err, hits) => {
      if (settled) return
      settled = true
      activeSearches--
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      void worker.terminate()
      if (err) reject(err)
      else resolve(hits)
    }
    const onAbort = () => finish(abortError())
    timer = setTimeout(() => {
      const err = new Error('regular expression search timed out')
      err.name = 'RegexTimeoutError'
      finish(err)
    }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    worker.once('message', hits => finish(null, hits))
    worker.once('error', err => finish(err))
    worker.once('exit', code => {
      if (!settled) finish(new Error(`regex worker exited with code ${code}`))
    })
  })
}

function abortError() {
  const err = new Error('regular expression search was cancelled')
  err.name = 'AbortError'
  return err
}

export default { regexSearchLines }
