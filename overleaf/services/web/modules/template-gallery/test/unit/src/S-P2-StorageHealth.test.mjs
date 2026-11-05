import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import StorageHealth from '../../../app/src/storage/StorageHealth.mjs'
import { layoutDirs, LAYOUT_SUBDIRS } from '../../../app/src/storage/Paths.mjs'
import { DEFAULTS } from '../../../app/src/TemplateGalleryDefaults.mjs'

describe('S-P2 StorageHealth (single volume, no mount gate)', () => {
  let root

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 's-p2-health-'))
  })

  afterEach(async () => {
    await fs.promises.rm(root, { recursive: true, force: true })
  })

  it('is ok for a plain sub-folder of a volume (no dedicated mount required)', async () => {
    const storageDir = path.join(root, 'data', 'template-gallery')

    const res = await StorageHealth.probe({ storageDir })

    expect(res.ok).toBe(true)
    expect(res.code).toBe('healthy')
    expect(res.storageDir).toBe(storageDir)
  })

  it('creates the full layout including catalog/ with mode 0750 and leaves no probe file behind', async () => {
    const storageDir = path.join(root, 'template-gallery')

    await StorageHealth.probe({ storageDir })

    for (const sub of LAYOUT_SUBDIRS) {
      const stat = fs.statSync(path.join(storageDir, sub))
      expect(stat.isDirectory()).toBe(true)
      expect(stat.mode & 0o777).toBe(0o750)
    }
    expect(fs.existsSync(path.join(storageDir, 'catalog'))).toBe(true)
    expect(
      fs.readdirSync(storageDir).filter(name => name.startsWith('.probe'))
    ).toEqual([])
  })

  it('reports free and total bytes from statfs', async () => {
    const storageDir = path.join(root, 'tg')

    const res = await StorageHealth.probe({ storageDir })

    expect(typeof res.freeBytes).toBe('number')
    expect(res.freeBytes).toBeGreaterThanOrEqual(0)
    expect(res.totalBytes).toBeGreaterThanOrEqual(res.freeBytes)
  })

  it('has no free-space threshold: a probe never fails or warns on space', async () => {
    const res = await StorageHealth.probe({ storageDir: path.join(root, 'tg') })

    expect(res.ok).toBe(true)
    expect(res).not.toHaveProperty('lowSpace')
    expect(res).not.toHaveProperty('minFreeBytes')
  })

  it('returns storage-unavailable when the directory cannot be created', async () => {
    const blocker = path.join(root, 'not-a-dir')
    await fs.promises.writeFile(blocker, 'x')

    const res = await StorageHealth.probe({
      storageDir: path.join(blocker, 'template-gallery'),
    })

    expect(res.ok).toBe(false)
    expect(res.code).toBe('storage-unavailable')
  })

  it('uses the module defaults when no storage config is given', async () => {
    const storageDir = path.join(root, 'defaults')
    const res = await StorageHealth.probe({ storageDir })
    expect(res.ok).toBe(true)
  })

  it('layoutDirs lists the same directories the init script creates', () => {
    const storageDir = path.join(root, 'layout')
    const dirs = layoutDirs(storageDir).map(dir =>
      path.relative(storageDir, dir)
    )
    expect(dirs).toEqual([
      path.join('blobs', 'sha256'),
      'tmp',
      'scratch',
      'quarantine',
      'catalog',
    ])
  })

  it('carries no storage limits or mount settings in the defaults', () => {
    expect(DEFAULTS.storageDir).toBe('/var/lib/template-gallery')
    expect(DEFAULTS).not.toHaveProperty('storage')
  })
})
