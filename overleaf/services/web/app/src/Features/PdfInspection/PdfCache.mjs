// A bounded least-recently-used map for the PDF inspector. Entries are dropped
// from the old end once there are more than `maxEntries`, or once the entries
// (measured by `sizeOf`) add up to more than `maxBytes`. The inspector keeps
// rendered images as Buffers here, so the byte budget is what stops a busy
// process from holding tens of megabytes of pictures nobody will ask for again.
//
// Pure: no timers, no I/O.

export class BoundedLru {
  /**
   * @param {{ maxEntries?: number, maxBytes?: number, sizeOf?: (value: any) => number }} [options]
   */
  constructor({
    maxEntries = Infinity,
    maxBytes = Infinity,
    sizeOf = () => 0,
  } = {}) {
    this.maxEntries = maxEntries
    this.maxBytes = maxBytes
    this.sizeOf = sizeOf
    this.entries = new Map()
    this.bytes = 0
  }

  get size() {
    return this.entries.size
  }

  has(key) {
    return this.entries.has(key)
  }

  /** The value for `key`, marked as the most recently used; undefined if absent. */
  get(key) {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key, value) {
    this.delete(key)
    const size = this.sizeOf(value)
    this.entries.set(key, { value, size })
    this.bytes += size
    while (
      this.entries.size > this.maxEntries ||
      (this.bytes > this.maxBytes && this.entries.size > 0)
    ) {
      const oldest = this.entries.keys().next().value
      this.delete(oldest)
    }
    return this
  }

  delete(key) {
    const entry = this.entries.get(key)
    if (!entry) return false
    this.entries.delete(key)
    this.bytes -= entry.size
    return true
  }

  clear() {
    this.entries.clear()
    this.bytes = 0
  }
}
