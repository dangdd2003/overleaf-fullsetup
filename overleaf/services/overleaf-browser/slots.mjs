/**
 * A fixed number of browser pages at once. A read over the limit waits for a
 * free page up to waitMs, then is refused with 429 so the caller moves on.
 * Never 503: the web side reads 503 as "the whole sidecar is down".
 */
export class Slots {
  constructor(size = 2) {
    this.size = Math.max(1, Math.floor(Number(size)) || 1)
    this.used = 0
    this.waiting = []
  }

  get busy() {
    return this.used
  }

  acquire({ signal, waitMs = 10_000 } = {}) {
    if (signal?.aborted) return Promise.reject(abortedError())
    if (this.used < this.size) {
      this.used++
      return Promise.resolve(this._releaser())
    }
    return new Promise((resolve, reject) => {
      const entry = {
        grant: () => {
          cleanup()
          this.used++
          resolve(this._releaser())
        },
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(busyError())
      }, waitMs)
      const onAbort = () => {
        cleanup()
        reject(abortedError())
      }
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        const index = this.waiting.indexOf(entry)
        if (index !== -1) this.waiting.splice(index, 1)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiting.push(entry)
    })
  }

  _releaser() {
    let released = false
    return () => {
      if (released) return
      released = true
      this.used--
      const next = this.waiting[0]
      if (next) next.grant()
    }
  }
}

function busyError() {
  const err = new Error('The browser is busy')
  err.status = 429
  err.retryAfter = 5
  err.kind = 'http'
  return err
}

function abortedError() {
  const err = new Error('Request was cancelled')
  err.code = 'aborted'
  return err
}
