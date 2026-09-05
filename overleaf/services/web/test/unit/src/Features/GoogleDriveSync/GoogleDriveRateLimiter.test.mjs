import { describe, it, beforeEach, vi, expect } from 'vitest'

const modulePath =
  '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveRateLimiter.mjs'

describe('GoogleDriveRateLimiter', () => {
  let GoogleDriveRateLimiter

  const Settings = {
    googleDrive: { maxRps: 4 },
  }

  vi.doMock('@overleaf/settings', () => ({ default: Settings }))

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.useRealTimers()
    Settings.googleDrive.maxRps = 4
    const mod = await import(modulePath)
    GoogleDriveRateLimiter = mod.default
    GoogleDriveRateLimiter.reset()
  })

  it('resolves immediately while burst capacity remains', async () => {
    // burst is 2 * maxRps = 8, so the first 8 acquires must not wait
    const start = Date.now()
    for (let i = 0; i < 8; i++) {
      await GoogleDriveRateLimiter.acquire()
    }
    expect(Date.now() - start).toBeLessThan(50)
  })

  it('delays once the burst is exhausted', async () => {
    for (let i = 0; i < 8; i++) {
      await GoogleDriveRateLimiter.acquire()
    }
    const start = Date.now()
    await GoogleDriveRateLimiter.acquire()
    // at 4 rps a token takes 250ms to refill; allow scheduler slack
    expect(Date.now() - start).toBeGreaterThanOrEqual(200)
  })

  it('refills over time so later calls are free again', async () => {
    for (let i = 0; i < 8; i++) {
      await GoogleDriveRateLimiter.acquire()
    }
    await new Promise(resolve => setTimeout(resolve, 600))
    const start = Date.now()
    await GoogleDriveRateLimiter.acquire()
    expect(Date.now() - start).toBeLessThan(50)
  })

  it('never blocks when maxRps is zero or negative', async () => {
    Settings.googleDrive.maxRps = 0
    GoogleDriveRateLimiter.reset()
    const start = Date.now()
    for (let i = 0; i < 50; i++) {
      await GoogleDriveRateLimiter.acquire()
    }
    expect(Date.now() - start).toBeLessThan(50)
  })
})
