import logger from '@overleaf/logger'
import Errors from './Errors.js'
import RequestParser from './RequestParser.js'
import Metrics from '@overleaf/metrics'
import Settings from '@overleaf/settings'

// The lock timeout should be higher than the maximum end-to-end compile time.
// Here, we use the maximum compile timeout plus 2 minutes.
const LOCK_TIMEOUT_MS = RequestParser.MAX_TIMEOUT * 1000 + 120000

const LOCKS = new Map()

/**
 * @param key
 * @return {Lock | undefined}
 */
function getExistingLock(key) {
  return LOCKS.get(key)
}

function acquire(key) {
  const currentLock = LOCKS.get(key)
  if (currentLock != null) {
    if (currentLock.isExpired()) {
      logger.warn({ key }, 'Compile lock expired')
      currentLock.release()
    } else {
      throw new Errors.AlreadyCompilingError('compile in progress')
    }
  }

  checkConcurrencyLimit()

  const lock = new Lock(key)
  LOCKS.set(key, lock)
  return lock
}

// A lock whose compile never finished is only replaced when the same key is
// compiled again, so expired locks of other projects would keep counting
// against the limit until every compile is rejected. Sandboxed compiles are
// killed at their deadline before the lock expires, so this is best effort
// only for work that is still unwinding.
function evictExpiredLocks() {
  for (const lock of LOCKS.values()) {
    if (lock.isExpired()) {
      logger.warn({ key: lock.key }, 'Compile lock expired')
      lock.release()
    }
  }
}

function checkConcurrencyLimit() {
  evictExpiredLocks()
  Metrics.gauge('concurrent_compile_requests', LOCKS.size)

  if (LOCKS.size <= Settings.compileConcurrencyLimit) {
    return
  }

  Metrics.inc('exceeded-compilier-concurrency-limit')

  throw new Errors.TooManyCompileRequestsError(
    'too many concurrent compile requests'
  )
}

class Lock {
  constructor(key) {
    this.key = key
    this.expiresAt = Date.now() + LOCK_TIMEOUT_MS
  }

  // keep the lock while known work is still bounded, e.g. after a deadline
  extend(ms) {
    this.expiresAt = Math.max(this.expiresAt, Date.now() + ms)
  }

  isExpired() {
    return Date.now() >= this.expiresAt
  }

  waitForRelease() {
    if (this.waitingForRelease) return this.waitingForRelease
    this.waitingForRelease = new Promise(resolve => {
      this.onRelease = resolve
    })
    return this.waitingForRelease
  }

  release() {
    if (this.onRelease) this.onRelease()
    if (LOCKS.get(this.key) === this) {
      LOCKS.delete(this.key)
    } else if (this.released && !this.isExpired()) {
      logger.error({ key: this.key }, 'Lock was released twice')
    }
    // else: expired and evicted, the key may already belong to a new lock
    this.released = true
    if (this.isExpired()) {
      Metrics.inc('compile_lock_expired_before_release')
    }
  }
}

export default { acquire, getExistingLock }
