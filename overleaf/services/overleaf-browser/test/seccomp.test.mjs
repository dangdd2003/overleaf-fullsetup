import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { generateSeccompProfile } from '../scripts/generate-seccomp.mjs'

test('seccomp profile allows clone, clone3 and unshare unconditionally, and setns only with CAP_SYS_ADMIN', () => {
  const profileJson = generateSeccompProfile()
  const profile = JSON.parse(profileJson)

  // Verify CAP_SYS_ADMIN rule no longer includes unshare/clone
  for (const sc of profile.syscalls) {
    if (sc.includes?.caps?.includes('CAP_SYS_ADMIN')) {
      for (const forbidden of ['clone', 'clone3', 'unshare']) {
        assert.equal(
          sc.names?.includes(forbidden),
          false,
          `${forbidden} must not be gated by CAP_SYS_ADMIN`
        )
      }
    }
  }

  // Verify unconditional allow rule exists
  const allowRule = profile.syscalls.find(
    sc =>
      sc.action === 'SCMP_ACT_ALLOW' &&
      sc.names?.includes('clone') &&
      sc.names?.includes('unshare') &&
      sc.names?.includes('clone3')
  )
  assert.ok(
    allowRule,
    'An unconditional allow rule for user namespaces must exist'
  )
  assert.equal(allowRule.includes, undefined)

  // Chrome's sandbox creates namespaces but never joins one: setns stays
  // behind CAP_SYS_ADMIN, which the container drops
  for (const sc of profile.syscalls) {
    if (sc.action === 'SCMP_ACT_ALLOW' && sc.names?.includes('setns')) {
      assert.ok(
        sc.includes?.caps?.includes('CAP_SYS_ADMIN'),
        'setns must only be allowed with CAP_SYS_ADMIN'
      )
    }
  }
})
