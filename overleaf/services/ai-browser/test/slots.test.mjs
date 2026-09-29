import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Slots } from '../slots.mjs'

test('Slots grants up to its size at once and queues the rest in order', async () => {
  const slots = new Slots(1)
  const release1 = await slots.acquire({ waitMs: 1000 })
  assert.equal(slots.busy, 1)
  const order = []
  const second = slots.acquire({ waitMs: 1000 }).then(release => {
    order.push('second')
    return release
  })
  const third = slots.acquire({ waitMs: 1000 }).then(release => {
    order.push('third')
    return release
  })
  release1()
  const release2 = await second
  assert.equal(slots.busy, 1)
  release2()
  const release3 = await third
  release3()
  assert.deepEqual(order, ['second', 'third'])
  assert.equal(slots.busy, 0)
})

test('Slots refuses with 429 when no page frees up in time', async () => {
  const slots = new Slots(1)
  const release = await slots.acquire()
  await assert.rejects(
    slots.acquire({ waitMs: 20 }),
    err =>
      err.status === 429 &&
      err.retryAfter === 5 &&
      err.message === 'The browser is busy'
  )
  release()
  assert.equal(slots.busy, 0)
})

test('Slots drops a waiting request when its signal aborts', async () => {
  const slots = new Slots(1)
  const release = await slots.acquire()
  const controller = new AbortController()
  const waiting = slots.acquire({ signal: controller.signal, waitMs: 1000 })
  controller.abort()
  await assert.rejects(waiting, err => err.code === 'aborted')
  release()
  assert.equal(slots.busy, 0)
})

test('Slots release is idempotent', async () => {
  const slots = new Slots(2)
  const release = await slots.acquire()
  release()
  release()
  assert.equal(slots.busy, 0)
})
