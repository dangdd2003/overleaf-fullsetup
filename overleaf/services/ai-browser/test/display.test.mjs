import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { startDisplay } from '../display.mjs'

function fakeChild() {
  const child = new EventEmitter()
  child.killed = false
  child.kill = () => {
    child.killed = true
  }
  return child
}

test('startDisplay starts Xvfb without TCP and waits for its socket', async () => {
  const calls = []
  const removed = []
  const child = fakeChild()
  let checks = 0
  const display = await startDisplay({
    spawnFn: (command, args) => {
      calls.push([command, args])
      return child
    },
    exists: () => ++checks >= 3,
    remove: file => removed.push(file),
    sleep: async () => {},
  })
  assert.deepEqual(calls, [
    ['Xvfb', [':99', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp']],
  ])
  assert.deepEqual(removed, ['/tmp/.X99-lock', '/tmp/.X11-unix/X99'])
  assert.equal(display.display, ':99')
  display.stop()
  assert.equal(child.killed, true)
})

test('startDisplay fails fast when Xvfb exits', async () => {
  const child = fakeChild()
  await assert.rejects(
    startDisplay({
      spawnFn: () => child,
      exists: () => false,
      remove: () => {},
      sleep: async () => {
        child.emit('exit', 1)
      },
    }),
    /Xvfb exited before it was ready \(1\)/
  )
})
