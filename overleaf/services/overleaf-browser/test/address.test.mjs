import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPublicAddress, resolvePublic } from '../address.mjs'

test('only globally routable addresses are public', () => {
  assert.equal(isPublicAddress('8.8.8.8'), true)
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true)
  for (const address of [
    '127.0.0.1',
    '10.0.0.5',
    '172.18.0.3',
    '192.168.1.1',
    '169.254.169.254',
    '::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '::7f00:1', // ::127.0.0.1, IPv4-compatible
    '::ffff:0:7f00:1', // ::ffff:0:127.0.0.1, IPv4-translated
    '3fff::1',
    '5f00::1',
    'nonsense',
  ]) {
    assert.equal(isPublicAddress(address), false, address)
  }
})

test('refuses a name that resolves to a private address', async () => {
  await assert.rejects(
    resolvePublic('mongo', {
      lookup: async () => [{ address: '172.18.0.3', family: 4 }],
    }),
    /not a public address/
  )
  await assert.rejects(resolvePublic('127.0.0.1'), /not a public address/)
})
