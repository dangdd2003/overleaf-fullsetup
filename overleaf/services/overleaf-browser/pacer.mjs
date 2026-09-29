/**
 * Per-host pacing to protect the sidecar's egress IP:
 * - 1 concurrent request per hostname
 * - At least minIntervalMs (default 2000 ms) between request starts
 * - Cooldown tracking (429 Retry-After, or 10 min for uncleared bot challenges)
 */
export class HostPacer {
  constructor({
    minIntervalMs = 2_000,
    maxCooldownMs = 600_000,
    now = () => Date.now(),
  } = {}) {
    this.minIntervalMs = minIntervalMs
    this.maxCooldownMs = maxCooldownMs
    this.now = now
    this.cooldowns = new Map() // host -> expire timestamp
    this.lastStart = new Map() // host -> start timestamp
    this.active = new Set() // host
    this.waiting = new Map() // host -> array of { resolve, reject, signal, timer }
  }

  getCooldown(host) {
    const expires = this.cooldowns.get(host)
    if (!expires) return 0
    const remaining = expires - this.now()
    if (remaining <= 0) {
      this.cooldowns.delete(host)
      return 0
    }
    return Math.ceil(remaining / 1000)
  }

  setCooldown(host, seconds) {
    const sec = Math.min(
      Math.max(1, Number(seconds) || 60),
      Math.floor(this.maxCooldownMs / 1000)
    )
    this.cooldowns.set(host, this.now() + sec * 1000)
  }

  async acquire(host, { signal } = {}) {
    const retrySec = this.getCooldown(host)
    if (retrySec > 0) {
      const err = new Error(`Host ${host} is cooling down`)
      err.status = 429
      err.retryAfter = retrySec
      err.kind = 'http'
      throw err
    }

    if (signal?.aborted) {
      const err = new Error('Request was cancelled')
      err.code = 'aborted'
      throw err
    }

    if (!this.active.has(host)) {
      const last = this.lastStart.get(host) || 0
      const elapsed = this.now() - last
      if (elapsed >= this.minIntervalMs) {
        this.active.add(host)
        this.lastStart.set(host, this.now())
        return () => this.release(host)
      }
    }

    return new Promise((resolve, reject) => {
      let queue = this.waiting.get(host)
      if (!queue) {
        queue = []
        this.waiting.set(host, queue)
      }
      const item = { resolve, reject, signal, timer: null }
      queue.push(item)

      const onAbort = () => {
        if (item.timer) clearTimeout(item.timer)
        const idx = queue.indexOf(item)
        if (idx !== -1) {
          queue.splice(idx, 1)
          if (queue.length === 0) this.waiting.delete(host)
          const err = new Error('Request was cancelled')
          err.code = 'aborted'
          reject(err)
        }
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      this._pump(host)
    })
  }

  release(host) {
    this.active.delete(host)
    this._pump(host)
  }

  _pump(host) {
    if (this.active.has(host)) return
    const queue = this.waiting.get(host)
    if (!queue || queue.length === 0) return

    const last = this.lastStart.get(host) || 0
    const delay = Math.max(0, this.minIntervalMs - (this.now() - last))

    if (delay === 0) {
      const next = queue.shift()
      if (queue.length === 0) this.waiting.delete(host)
      if (next.timer) clearTimeout(next.timer)
      this.active.add(host)
      this.lastStart.set(host, this.now())
      next.resolve(() => this.release(host))
    } else {
      const next = queue[0]
      if (!next.timer) {
        next.timer = setTimeout(() => {
          next.timer = null
          this._pump(host)
        }, delay)
      }
    }
  }
}
