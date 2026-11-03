import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BlobStore from '../../../app/src/storage/BlobStore.mjs'
import Paths from '../../../app/src/storage/Paths.mjs'
import * as VolumeAudit from '../../../app/src/storage/VolumeAudit.mjs'

const HOUR = 3600_000
const DAY = 24 * HOUR

async function ageFile(file, ageMs) {
  const when = new Date(Date.now() - ageMs)
  await fs.promises.utimes(file, when, when)
}

async function write(file, text = 'x') {
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  await fs.promises.writeFile(file, text)
  return file
}

describe('S-P7 VolumeAudit', () => {
  let dir

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 's-p7-volume-'))
  })

  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true })
  })

  it('counts files and bytes per area, including strays and catalog generations', async () => {
    const { sha256 } = await BlobStore.putBuffer(Buffer.from('blob'), { storageDir: dir })
    await write(path.join(dir, 'blobs', 'sha256', 'zz', 'not-a-sha'), 'stray!')
    await write(path.join(dir, 'catalog', 'gen-20250101T000000000-aaaaaa', 'manifest.json'), '{}')
    await write(path.join(dir, '.probe-1234'), 'p')
    const audit = await VolumeAudit.auditVolume(dir)
    expect(audit.areas.blobs.files).toBe(1)
    expect(audit.areas.strayBlobs).toMatchObject({ files: 1, bytes: 6 })
    expect(audit.areas.probes.files).toBe(1)
    expect(audit.areas.catalog.files).toBe(1)
    expect(audit.generations).toEqual([
      { generation: '20250101T000000000-aaaaaa', files: 1, bytes: 2 },
    ])
    expect(audit.total.files).toBe(4)
    expect(fs.existsSync(Paths.blobPath(dir, sha256))).toBe(true)
  })

  it('dry run reports stray, probe and empty-dir removals but changes nothing', async () => {
    const stray = await write(path.join(dir, 'blobs', 'sha256', 'ab', 'partial.tmp'), 'half')
    await ageFile(stray, 2 * HOUR)
    const probe = await write(path.join(dir, '.probe-old'), 'p')
    await ageFile(probe, 2 * HOUR)
    const emptyPrefix = path.join(dir, 'blobs', 'sha256', 'cd')
    await fs.promises.mkdir(emptyPrefix, { recursive: true })
    await ageFile(emptyPrefix, 2 * HOUR)

    const res = await VolumeAudit.cleanVolume(dir, { dryRun: true, now: Date.now(), verifyBudgetBytes: 1e9 })

    expect(res.dryRun).toBe(true)
    expect(res.freed.strays.files).toBe(1)
    expect(res.freed.probes.files).toBe(1)
    expect(res.freed.emptyDirs.files).toBe(1)
    expect(res.verify.skipped).toBe('dry_run')
    expect(fs.existsSync(stray)).toBe(true)
    expect(fs.existsSync(probe)).toBe(true)
    expect(fs.existsSync(path.join(dir, 'blobs', 'sha256', 'cd'))).toBe(true)
  })

  it('removes aged strays, probes, empty prefix dirs and old scratch trees, and keeps young files', async () => {
    const stray = await write(path.join(dir, 'blobs', 'sha256', 'ab', 'partial'), 'half')
    await ageFile(stray, 2 * HOUR)
    const youngStray = await write(path.join(dir, 'blobs', 'sha256', 'ab', 'fresh'), 'x')
    const probe = await write(path.join(dir, '.probe-old'), 'p')
    await ageFile(probe, 2 * HOUR)
    const emptyPrefix = path.join(dir, 'blobs', 'sha256', 'cd')
    await fs.promises.mkdir(emptyPrefix, { recursive: true })
    await ageFile(emptyPrefix, 2 * HOUR)
    const freshPrefix = path.join(dir, 'blobs', 'sha256', 'ef')
    await fs.promises.mkdir(freshPrefix, { recursive: true })
    const oldScratch = await write(path.join(dir, 'scratch', 'old-run', 'work.zip'), 'zzz')
    await ageFile(oldScratch, 8 * HOUR)
    await ageFile(path.join(dir, 'scratch', 'old-run'), 8 * HOUR)
    const liveScratch = await write(path.join(dir, 'scratch', 'live-run', 'work.zip'), 'zzz')

    const res = await VolumeAudit.cleanVolume(dir, { now: Date.now(), verifyBudgetBytes: 0 })

    expect(res.freed.strays.files).toBe(1)
    expect(res.freed.probes.files).toBe(1)
    expect(res.freed.emptyDirs.files).toBe(1)
    expect(res.freed.scratch.files).toBe(1)
    expect(fs.existsSync(stray)).toBe(false)
    expect(fs.existsSync(probe)).toBe(false)
    expect(fs.existsSync(path.join(dir, 'blobs', 'sha256', 'cd'))).toBe(false)
    // a just-created prefix directory may be about to receive a blob: kept
    expect(fs.existsSync(freshPrefix)).toBe(true)
    expect(fs.existsSync(path.join(dir, 'scratch', 'old-run'))).toBe(false)
    expect(fs.existsSync(youngStray)).toBe(true)
    expect(fs.existsSync(liveScratch)).toBe(true)
  })

  it('re-hashes blobs within the budget, quarantines a mismatch and resumes from the cursor', async () => {
    const shas = []
    for (const text of ['one', 'two', 'three']) {
      shas.push((await BlobStore.putBuffer(Buffer.from(text), { storageDir: dir })).sha256)
    }
    const sorted = [...shas].sort()
    // corrupt the middle one (in sorted order) so the scan hits it
    const corruptSha = sorted[1]
    await fs.promises.writeFile(Paths.blobPath(dir, corruptSha), 'tampered')

    // budget of one blob: the first call checks one file and stops
    const first = await VolumeAudit.cleanVolume(dir, { now: Date.now(), verifyBudgetBytes: 1 })
    expect(first.verify.checked).toBe(1)
    expect(first.verify.complete).toBe(false)
    expect(first.verify.cursor).toBe(sorted[0])

    const second = await VolumeAudit.cleanVolume(dir, {
      now: Date.now(),
      verifyBudgetBytes: 1e9,
      verifyCursor: first.verify.cursor,
    })
    expect(second.verify.checked).toBe(2)
    expect(second.verify.quarantined).toBe(1)
    expect(second.verify.complete).toBe(true)
    expect(second.verify.cursor).toBeNull()
    expect(fs.existsSync(Paths.blobPath(dir, corruptSha))).toBe(false)
    expect(fs.readdirSync(path.join(dir, 'quarantine')).some(name => name.startsWith(corruptSha))).toBe(true)
    expect(fs.existsSync(Paths.blobPath(dir, sorted[0]))).toBe(true)
    expect(fs.existsSync(Paths.blobPath(dir, sorted[2]))).toBe(true)
  })
})
