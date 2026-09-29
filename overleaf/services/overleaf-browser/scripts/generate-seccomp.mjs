import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

/**
 * Docker's default seccomp profile (moby v28.5.1 profiles/seccomp/default.json)
 * compressed with gzip and base64 encoded to guarantee reproducible, offline generation.
 */
const MOBY_SECCOMP_GZIP_B64 =
  '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'

export function generateSeccompProfile() {
  const raw = zlib
    .gunzipSync(Buffer.from(MOBY_SECCOMP_GZIP_B64, 'base64'))
    .toString('utf8')
  const profile = JSON.parse(raw)

  for (const sc of profile.syscalls) {
    if (
      sc.includes?.caps?.includes('CAP_SYS_ADMIN') &&
      sc.names.includes('unshare')
    ) {
      sc.names = sc.names.filter(
        n => !['clone', 'clone3', 'setns', 'unshare'].includes(n)
      )
    }
    if (
      sc.includes?.caps?.includes('CAP_SYS_CHROOT') &&
      sc.names.includes('chroot')
    ) {
      sc.names = sc.names.filter(n => n !== 'chroot')
    }
  }

  profile.syscalls = profile.syscalls.filter(
    sc =>
      !(
        sc.names?.length === 1 &&
        sc.names[0] === 'clone3' &&
        sc.action === 'SCMP_ACT_ERRNO'
      )
  )
  profile.syscalls = profile.syscalls.filter(
    sc =>
      !(
        sc.names?.length === 1 &&
        sc.names[0] === 'clone' &&
        sc.args?.length > 0
      )
  )

  profile.syscalls.push({
    names: ['clone', 'clone3', 'setns', 'unshare', 'chroot'],
    action: 'SCMP_ACT_ALLOW',
    args: [],
    comment:
      'Allow user namespaces and chroot for Chromium sandbox without CAP_SYS_ADMIN or CAP_SYS_CHROOT',
  })

  return JSON.stringify(profile, null, 2) + '\n'
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dest = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../seccomp.json'
  )
  fs.writeFileSync(dest, generateSeccompProfile(), 'utf8')
  console.log(`Generated ${dest}`)
}
