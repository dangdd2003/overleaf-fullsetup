import { webError } from './util.mjs'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/**
 * Bounds on the web reads one process does at once. A read holds its body in
 * this process's memory (and a PDF in a worker), so without these a few
 * users, or one user's parallel tool calls, could fill the heap.
 */

/** Reads one user may have in flight: a parallel batch of tool calls, no more */
export const PER_OWNER_READS = 3
/** Reads in flight across the whole process */
export const GLOBAL_READS = 12
/** How long a read waits for a place before it is refused as a tool error */
export const QUEUE_WAIT_MS = 30_000
/** Body bytes reserved at once across the process, as the sum of the page caps */
export const BYTE_BUDGET = 256 * 1024 * 1024
/** Below this much free budget a page waits; above it, the cap is cut to fit */
const MIN_CAP_BYTES = 4 * 1024 * 1024

function busyError() {
  return webError(
    'Too many pages are being read at the same time. Try again in a moment.',
    { kind: 'network' }
  )
}

function cancelled() {
  return webError('Request was cancelled', { kind: 'network' })
}

/**
 * A counting gate per owner and process, with an optional byte budget. `acquire`
 * waits (in arrival order) until the owner and the process both have a place
 * and, when a `cap` is asked for, the budget can hold at least MIN_CAP_BYTES.
 * It then reserves what is free up to that cap, so a busy process reads
 * smaller bodies instead of refusing them. Without a cap nothing is reserved.
 */
export class ReadLimiter {
  constructor({
    perOwner = PER_OWNER_READS,
    global = GLOBAL_READS,
    waitMs = QUEUE_WAIT_MS,
    budgetBytes = Infinity,
  } = {}) {
    this.perOwner = perOwner
    this.global = global
    this.waitMs = waitMs
    this.budgetBytes = budgetBytes
    this.active = 0
    this.byOwner = new Map()
    this.reservedBytes = 0
    this.waiting = []
  }

  _canStart(owner, cap) {
    return (
      this.active < this.global &&
      (this.byOwner.get(owner) || 0) < this.perOwner &&
      (!(cap > 0) ||
        this.budgetBytes - this.reservedBytes >= Math.min(cap, MIN_CAP_BYTES))
    )
  }

  _start(owner, cap) {
    const granted =
      cap > 0 ? Math.min(cap, this.budgetBytes - this.reservedBytes) : 0
    this.active++
    this.byOwner.set(owner, (this.byOwner.get(owner) || 0) + 1)
    this.reservedBytes += granted
    let released = false
    return {
      maxBytes: granted,
      release: () => {
        if (released) return
        released = true
        this.active--
        this.reservedBytes -= granted
        const left = (this.byOwner.get(owner) || 1) - 1
        if (left > 0) this.byOwner.set(owner, left)
        else this.byOwner.delete(owner)
        this._drain()
      },
    }
  }

  _removeWaiter(entry) {
    const idx = this.waiting.indexOf(entry)
    if (idx !== -1) this.waiting.splice(idx, 1)
  }

  _drain() {
    // First come, first served per owner and per scarce budget/global slot:
    // an owner's earlier blocked waiter blocks later waiters of that same
    // owner, while other owners with free capacity proceed without stalling.
    const blockedOwners = new Set()
    for (const entry of [...this.waiting]) {
      if (blockedOwners.has(entry.owner)) continue
      if (!this._canStart(entry.owner, entry.cap)) {
        blockedOwners.add(entry.owner)
        continue
      }
      this._removeWaiter(entry)
      clearTimeout(entry.timer)
      entry.signal?.removeEventListener?.('abort', entry.onAbort)
      entry.resolve(this._start(entry.owner, entry.cap))
    }
  }

  /** Resolves to { maxBytes, release } once the read may run. */
  acquire(owner = 'default', { cap = 0, signal } = {}) {
    const key = String(owner ?? 'default')
    if (signal?.aborted) return Promise.reject(cancelled())
    const hasOwnerWaiter = this.waiting.some(w => w.owner === key)
    if (!hasOwnerWaiter && this._canStart(key, cap)) {
      return Promise.resolve(this._start(key, cap))
    }
    return new Promise((resolve, reject) => {
      const entry = { owner: key, cap, signal, resolve }
      entry.timer = setTimeout(() => {
        this._removeWaiter(entry)
        signal?.removeEventListener?.('abort', entry.onAbort)
        this._drain()
        reject(busyError())
      }, this.waitMs)
      entry.timer.unref?.()
      entry.onAbort = () => {
        clearTimeout(entry.timer)
        this._removeWaiter(entry)
        this._drain()
        reject(cancelled())
      }
      signal?.addEventListener?.('abort', entry.onAbort, { once: true })
      this.waiting.push(entry)
    })
  }
}

/** Web reads in flight: per user and for the process. */
export const readLimiter = new ReadLimiter()
/** Body bytes held at once by page reads across the process. */
export const byteBudget = new ReadLimiter({
  perOwner: Infinity,
  global: Infinity,
  budgetBytes: BYTE_BUDGET,
})

/** Searches one user may run on the operator's keys, per hour and per day. */
export const SERVER_SEARCHES_PER_HOUR = 30
export const SERVER_SEARCHES_PER_DAY = 200

/**
 * In-process sliding-window counts of searches an owner ran on the instance's
 * own search keys. Each process keeps its own count; that is enough to stop
 * one account from spending the operator's keys.
 */
export class SearchQuota {
  constructor({
    perHour = SERVER_SEARCHES_PER_HOUR,
    perDay = SERVER_SEARCHES_PER_DAY,
    now = () => Date.now(),
  } = {}) {
    this.perHour = perHour
    this.perDay = perDay
    this.now = now
    this.stamps = new Map()
  }

  /** True and counted when the owner may search now; false when over quota. */
  take(owner) {
    const key = String(owner ?? 'default')
    const t = this.now()
    const recent = (this.stamps.get(key) || []).filter(at => t - at < DAY_MS)
    const inHour = recent.filter(at => t - at < HOUR_MS).length
    if (inHour >= this.perHour || recent.length >= this.perDay) {
      if (recent.length) this.stamps.set(key, recent)
      else this.stamps.delete(key)
      return false
    }
    recent.push(t)
    this.stamps.set(key, recent)
    return true
  }
}

export const serverSearchQuota = new SearchQuota()
