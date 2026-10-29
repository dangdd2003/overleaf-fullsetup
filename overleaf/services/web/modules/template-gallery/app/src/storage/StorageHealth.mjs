// overleaf/services/web/modules/template-gallery/app/src/storage/StorageHealth.mjs
import fs from 'node:fs'
import path from 'node:path'
import { probePath } from './Paths.mjs'

/**
 * Decodes octal mount escape sequences in /proc/self/mountinfo:
 * \040 -> space, \011 -> tab, \012 -> newline, \134 -> backslash
 */
export function decodeMountEscapes(str) {
  if (typeof str !== 'string') return ''
  return str.replace(/\\([0-7]{3})/g, (_match, octal) => {
    return String.fromCharCode(parseInt(octal, 8))
  })
}

/**
 * Parses /proc/self/mountinfo and returns an array of mountpoint strings (field index 4).
 * mountinfo format:
 * 36 35 98:0 /mnt1 /mnt2 rw,noatime master:1 - ext3 /dev/root rw,errors=continue
 * Fields:
 * 0: mount ID
 * 1: parent ID
 * 2: major:minor
 * 3: root
 * 4: mount point
 * 5: mount options
 * 6: optional fields...
 * separator '-'
 * filesystem type
 * mount source
 * super options
 */
export function parseMountinfo(content) {
  if (typeof content !== 'string') return []
  const mountpoints = []
  const lines = content.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(' ')
    if (parts.length >= 5) {
      mountpoints.push(decodeMountEscapes(parts[4]))
    }
  }
  return mountpoints
}

/**
 * Checks whether storageDir satisfies the storage mount policy.
 * Returns { ok, code, acceptedParent }
 */
export function checkMountPolicy(storageDir, mountpoints, storageCfg = {}) {
  const resolvedTarget = path.resolve(storageDir)
  const isDedicatedMount = mountpoints.some(
    mp => path.resolve(mp) === resolvedTarget
  )

  if (isDedicatedMount) {
    return { ok: true, code: 'dedicated-mount', acceptedParent: null }
  }

  if (storageCfg?.requireDedicatedMount === false) {
    return { ok: true, code: 'mount-not-required', acceptedParent: null }
  }

  // Check accepted parent mounts
  const acceptedParents = Array.isArray(storageCfg?.acceptedParentMounts)
    ? storageCfg.acceptedParentMounts
    : []

  for (const parent of acceptedParents) {
    const resolvedParent = path.resolve(parent)
    const isParentMount = mountpoints.some(
      mp => path.resolve(mp) === resolvedParent
    )
    if (isParentMount) {
      const parentWithSep = resolvedParent.endsWith(path.sep)
        ? resolvedParent
        : resolvedParent + path.sep
      if (
        resolvedTarget === resolvedParent ||
        resolvedTarget.startsWith(parentWithSep)
      ) {
        return {
          ok: true,
          code: 'accepted-parent-mount',
          acceptedParent: resolvedParent,
        }
      }
    }
  }

  return {
    ok: false,
    code: 'not-a-mountpoint',
    acceptedParent: null,
  }
}

/**
 * Probes the storage mount and verifies write/statfs capabilities.
 * Ensures subdirectories (tmp, scratch, blobs/sha256, quarantine) exist only AFTER mount check passes.
 */
export async function probe(cfg = {}, opts = {}) {
  const storageDir = cfg?.storageDir || '/var/lib/overleaf/data/template-gallery'
  const storageCfg = cfg?.storage || {}

  // 1. Mount check
  if (!opts.skipMountCheck) {
    let mountinfoContent = opts.mountinfoContent
    if (mountinfoContent === undefined) {
      try {
        mountinfoContent = await fs.promises.readFile('/proc/self/mountinfo', 'utf8')
      } catch (err) {
        return {
          ok: false,
          code: 'mountinfo-read-failed',
          error: err.message,
        }
      }
    }

    const mountpoints = parseMountinfo(mountinfoContent)
    const mountCheck = checkMountPolicy(storageDir, mountpoints, storageCfg)
    if (!mountCheck.ok) {
      return {
        ok: false,
        code: mountCheck.code,
        storageDir,
      }
    }
  }

  // 2. Ensure subdirectories exist only AFTER mount check passes
  const subdirs = [
    path.join(storageDir, 'tmp'),
    path.join(storageDir, 'scratch'),
    path.join(storageDir, 'blobs', 'sha256'),
    path.join(storageDir, 'quarantine'),
  ]

  for (const dir of subdirs) {
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o750 })
  }

  // 3. Write & unlink probe marker
  const probeFile = probePath(storageDir)
  const probeMarker = `probe-${Date.now()}-${Math.random().toString(36).slice(2)}\n`
  await fs.promises.writeFile(probeFile, probeMarker, { mode: 0o600 })
  await fs.promises.unlink(probeFile)

  // 4. statfs for freeBytes and totalBytes
  let freeBytes = 0
  let totalBytes = 0
  if (typeof fs.promises.statfs === 'function') {
    const stats = await fs.promises.statfs(storageDir)
    freeBytes = stats.bavail * stats.bsize
    totalBytes = stats.blocks * stats.bsize
  }

  return {
    ok: true,
    code: 'healthy',
    storageDir,
    freeBytes,
    totalBytes,
  }
}

export default {
  decodeMountEscapes,
  parseMountinfo,
  checkMountPolicy,
  probe,
}
