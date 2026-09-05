import Settings from '@overleaf/settings'

/**
 * Process-wide token bucket pacing all Google Drive API requests.
 *
 * Every worker (polling, outbound flush) and every user-triggered sync shares
 * this bucket, so no combination of triggers can exceed the configured rate.
 * Note this is per-process: a multi-instance deployment gets
 * `maxRps * instanceCount` in aggregate, so operators should divide the
 * configured value by their replica count.
 */

let tokens = null
let lastRefillMs = Date.now()

function _maxRps() {
  const configured = Settings.googleDrive?.maxRps
  return typeof configured === 'number' ? configured : 8
}

function _burst() {
  return _maxRps() * 2
}

function _refill() {
  const now = Date.now()
  const elapsedSeconds = (now - lastRefillMs) / 1000
  lastRefillMs = now
  if (tokens === null) {
    tokens = _burst()
    return
  }
  tokens = Math.min(_burst(), tokens + elapsedSeconds * _maxRps())
}

const GoogleDriveRateLimiter = {
  /**
   * Resolves once a request token is available. Callers await this
   * immediately before issuing a Drive API request.
   *
   * @returns {Promise<void>}
   */
  async acquire() {
    const rps = _maxRps()
    if (!rps || rps <= 0) {
      // Limiting disabled.
      return
    }

    // Loop rather than a single wait: several callers can be parked at once,
    // and the first to wake may take the only token that refilled.
    for (;;) {
      _refill()
      if (tokens >= 1) {
        tokens -= 1
        return
      }
      const deficit = 1 - tokens
      const waitMs = Math.ceil((deficit / rps) * 1000)
      await new Promise(resolve => setTimeout(resolve, Math.max(1, waitMs)))
    }
  },

  /**
   * Refills the bucket. Intended for tests.
   */
  reset() {
    tokens = _burst()
    lastRefillMs = Date.now()
  },
}

export default GoogleDriveRateLimiter
export { GoogleDriveRateLimiter }
