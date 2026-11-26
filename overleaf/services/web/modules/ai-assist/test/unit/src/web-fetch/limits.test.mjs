import { describe, it } from 'vitest'
import { expect } from 'chai'
import {
  ReadLimiter,
  SearchQuota,
} from '../../../../app/src/web-fetch/limits.mjs'
import { cleanUpstreamDetail } from '../../../../app/src/web-fetch/api.mjs'

const MB = 1024 * 1024

describe('web read limits', function () {
  it('lets a user have only perOwner reads at once, and queues the next', async function () {
    const limiter = new ReadLimiter({ perOwner: 2, global: 10, waitMs: 1000 })
    const first = await limiter.acquire('alice')
    await limiter.acquire('alice')
    let started = false
    const third = limiter.acquire('alice').then(lease => {
      started = true
      return lease
    })
    await new Promise(r => setTimeout(r, 10))
    expect(started).to.be.false

    first.release()
    const lease = await third
    expect(started).to.be.true
    lease.release()
  })

  it('does not let one user take the places of another', async function () {
    const limiter = new ReadLimiter({ perOwner: 1, global: 10, waitMs: 1000 })
    const alice1 = await limiter.acquire('alice')
    const alice2 = limiter.acquire('alice')
    // Bob must start immediately even though Alice already has a queued waiter
    const bob1 = await limiter.acquire('bob')
    expect(limiter.active).to.equal(2)
    alice1.release()
    const a2 = await alice2
    a2.release()
    bob1.release()
  })

  it('aborts a queued waiter without corrupting other waiters', async function () {
    const limiter = new ReadLimiter({ perOwner: 1, global: 10, waitMs: 1000 })
    const a1 = await limiter.acquire('alice')
    const ac = new AbortController()
    const a2 = limiter.acquire('alice', { signal: ac.signal })
    const a3 = limiter.acquire('alice')
    ac.abort()
    const abortedErr = await a2.catch(e => e)
    expect(abortedErr.message).to.match(/cancelled/i)
    a1.release()
    const third = await a3
    third.release()
  })

  it('refuses a read that waits past the queue timeout, as a tool error', async function () {
    const limiter = new ReadLimiter({ perOwner: 1, global: 1, waitMs: 20 })
    await limiter.acquire('alice')
    const err = await limiter.acquire('bob').catch(e => e)
    expect(err.kind).to.equal('network')
    expect(err.message).to.match(/Too many pages/)
    expect(limiter.waiting).to.have.lengthOf(0)
  })

  it('cuts the byte cap to what the budget has left, instead of refusing', async function () {
    const budget = new ReadLimiter({
      perOwner: Infinity,
      global: Infinity,
      waitMs: 1000,
      budgetBytes: 100 * MB,
    })
    const big = await budget.acquire('pages', { cap: 64 * MB })
    expect(big.maxBytes).to.equal(64 * MB)

    const cut = await budget.acquire('pages', { cap: 64 * MB })
    expect(cut.maxBytes).to.equal(36 * MB)

    big.release()
    cut.release()
    expect(budget.reservedBytes).to.equal(0)
  })

  it('reserves nothing when no cap is asked for', async function () {
    const limiter = new ReadLimiter({ perOwner: 3, global: 3, budgetBytes: 1 })
    const lease = await limiter.acquire('alice')
    expect(lease.maxBytes).to.equal(0)
    expect(limiter.reservedBytes).to.equal(0)
    lease.release()
  })
})

describe('SearchQuota', function () {
  it('allows the hourly count, then refuses until an hour has passed', function () {
    let now = 0
    const quota = new SearchQuota({ perHour: 2, perDay: 10, now: () => now })
    expect(quota.take('alice')).to.be.true
    expect(quota.take('alice')).to.be.true
    expect(quota.take('alice')).to.be.false
    expect(quota.take('bob')).to.be.true

    now += 60 * 60 * 1000 + 1
    expect(quota.take('alice')).to.be.true
  })

  it('applies the daily count across hours', function () {
    let now = 0
    const quota = new SearchQuota({ perHour: 100, perDay: 2, now: () => now })
    expect(quota.take('alice')).to.be.true
    now += 2 * 60 * 60 * 1000
    expect(quota.take('alice')).to.be.true
    now += 2 * 60 * 60 * 1000
    expect(quota.take('alice')).to.be.false
  })
})

describe('cleanUpstreamDetail', function () {
  it('turns control characters into spaces and collapses them', function () {
    expect(cleanUpstreamDetail('bad\r\nkey\u0000\u001b[31m here')).to.equal(
      'bad key [31m here'
    )
  })

  it('cuts the text at 300 characters', function () {
    const cut = cleanUpstreamDetail('x'.repeat(1000))
    expect(cut.length).to.equal(300)
    expect(cut.endsWith('…')).to.be.true
  })
})
