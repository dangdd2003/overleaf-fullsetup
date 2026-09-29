import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HostPacer } from '../pacer.mjs'
import { isChallenge } from '../quality.mjs'

test('HostPacer serializes requests to the same host', async () => {
  let clock = 10_000
  const pacer = new HostPacer({
    minIntervalMs: 2_000,
    now: () => clock,
  })

  const release1 = await pacer.acquire('example.com')
  assert.equal(typeof release1, 'function')

  // A second acquire for the same host while first is active must queue
  let acquired2 = false
  const p2 = pacer.acquire('example.com').then(rel => {
    acquired2 = true
    return rel
  })

  assert.equal(acquired2, false)
  release1()

  // Advance clock by 2s so the queued acquire can proceed
  clock += 2_000
  const release2 = await p2
  assert.equal(acquired2, true)
  release2()
})

test('HostPacer enforces 10-minute cooldown on challenge failure and respects Retry-After', async () => {
  let clock = 1_000
  const pacer = new HostPacer({
    maxCooldownMs: 600_000,
    now: () => clock,
  })

  // Set 10-minute cooldown (600s)
  pacer.setCooldown('bot-site.com', 600)
  assert.equal(pacer.getCooldown('bot-site.com'), 600)

  let error = null
  try {
    await pacer.acquire('bot-site.com')
  } catch (err) {
    error = err
  }
  assert.ok(error)
  assert.equal(error.status, 429)
  assert.equal(error.retryAfter, 600)
  assert.equal(error.kind, 'http')

  // Clock advances past cooldown
  clock += 601_000
  assert.equal(pacer.getCooldown('bot-site.com'), 0)
  const release = await pacer.acquire('bot-site.com')
  assert.equal(typeof release, 'function')
  release()
})

test('HostPacer cancels pending acquire on AbortSignal', async () => {
  let clock = 10_000
  const pacer = new HostPacer({ minIntervalMs: 2_000, now: () => clock })
  const release1 = await pacer.acquire('example.com')

  const controller = new AbortController()
  const p2 = pacer.acquire('example.com', { signal: controller.signal })
  controller.abort()

  await assert.rejects(p2, /cancelled/i)
  release1()
})

test('isChallenge detects bot checks in HTML and text', () => {
  assert.equal(isChallenge('<title>Just a moment...</title>', ''), true)
  assert.equal(
    isChallenge('<div>checking if the site connection is secure</div>', ''),
    true
  )
  assert.equal(isChallenge('', 'Attention Required! | Cloudflare'), true)
  assert.equal(
    isChallenge(
      '<html><body><h1>Real LaTeX Article</h1><p>' +
        'word '.repeat(500) +
        '</p></body></html>',
      'Real Article ' + 'word '.repeat(500)
    ),
    false
  )
})
