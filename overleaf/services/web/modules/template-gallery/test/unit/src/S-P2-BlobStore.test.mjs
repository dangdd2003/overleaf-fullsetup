import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import BlobStore, {
} from '../../../app/src/storage/BlobStore.mjs'
import Paths from '../../../app/src/storage/Paths.mjs'

const PDF = Buffer.from('%PDF-1.5\nbody\n%%EOF', 'utf8')

// The bootstrap installs chai-as-promised, whose expect().rejects handlers attach too late
// for stream failures. Awaiting directly keeps the handler attached from the start.
async function rejectionOf(promise) {
  try {
    await promise
  } catch (err) {
    return err
  }
  throw new Error('expected the promise to reject')
}

describe('S-P2 BlobStore write errors and durability', () => {
  let tmpDir

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 's-p2-blob-'))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  })

  function failingWritable(code) {
    return new Writable({
      write(_chunk, _encoding, callback) {
        const err = new Error(`${code}: simulated write-stream failure`)
        err.code = code
        callback(err)
      },
    })
  }

  it('rejects a single-chunk putStream with STORAGE_FULL when the write stream fails with ENOSPC', async () => {
    vi.spyOn(fs, 'createWriteStream').mockImplementation(() =>
      failingWritable('ENOSPC')
    )

    const err = await rejectionOf(
      BlobStore.putBuffer(Buffer.alloc(4096, 0x41), {
        storageDir: tmpDir,
      })
    )

    expect(err.code).toBe('STORAGE_FULL')
    expect(await fs.promises.readdir(path.join(tmpDir, 'tmp'))).toEqual([])
  })

  it('rejects a multi-chunk putStream (drain path) with STORAGE_FULL instead of hanging or crashing', async () => {
    vi.spyOn(fs, 'createWriteStream').mockImplementation(() =>
      failingWritable('ENOSPC')
    )
    const chunks = Array.from({ length: 4 }, () =>
      Buffer.alloc(1024 * 1024, 0x42)
    )

    const err = await rejectionOf(
      BlobStore.putStream(Readable.from(chunks), {
        storageDir: tmpDir,
      })
    )

    expect(err.code).toBe('STORAGE_FULL')
  })

  it('rejects copyVerified with STORAGE_FULL when the destination write fails with ENOSPC', async () => {
    const { sha256 } = await BlobStore.putBuffer(PDF, {
      storageDir: tmpDir,
      magic: '%PDF-',
    })
    vi.spyOn(fs, 'createWriteStream').mockImplementation(() =>
      failingWritable('ENOSPC')
    )
    const dest = Paths.scratchPath(tmpDir, undefined, '.pdf')

    const err = await rejectionOf(BlobStore.copyVerified(sha256, dest, tmpDir))

    expect(err.code).toBe('STORAGE_FULL')
    expect(fs.existsSync(dest)).toBe(false)
  })

  it('keeps non-space write errors under their original code', async () => {
    vi.spyOn(fs, 'createWriteStream').mockImplementation(() =>
      failingWritable('EIO')
    )

    const err = await rejectionOf(
      BlobStore.putBuffer(Buffer.from('%PDF-x'), {
        storageDir: tmpDir,
        magic: '%PDF-',
      })
    )

    expect(err.code).toBe('EIO')
  })

  it('fsyncs the staged file before renaming it into place', async () => {
    const events = []
    const realFsync = fs.fsync
    const realRename = fs.promises.rename
    vi.spyOn(fs, 'fsync').mockImplementation((fd, callback) => {
      events.push('sync')
      return realFsync(fd, callback)
    })
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      events.push('rename')
      return realRename(from, to)
    })

    const { sha256 } = await BlobStore.putBuffer(PDF, {
      storageDir: tmpDir,
      magic: '%PDF-',
    })

    expect(events).toEqual(['sync', 'rename'])
    expect(await BlobStore.exists(sha256, tmpDir)).toBe(true)
  })

  it('treats an unsupported fsync (ENOSYS / "Method not implemented") as best-effort', async () => {
    vi.spyOn(fs, 'fsync').mockImplementation((_fd, callback) => {
      const err = new Error('Method not implemented.')
      err.code = 'ENOSYS'
      callback(err)
    })

    const { sha256 } = await BlobStore.putBuffer(PDF, {
      storageDir: tmpDir,
      magic: '%PDF-',
    })

    expect(await BlobStore.exists(sha256, tmpDir)).toBe(true)
  })

  it('treats a failing fsync (EIO) as best-effort and still stores the blob', async () => {
    vi.spyOn(fs, 'fsync').mockImplementation((_fd, callback) => {
      const err = new Error('EIO: i/o error')
      err.code = 'EIO'
      callback(err)
    })

    const { sha256 } = await BlobStore.putBuffer(PDF, {
      storageDir: tmpDir,
      magic: '%PDF-',
    })

    expect(await BlobStore.exists(sha256, tmpDir)).toBe(true)
    expect(await BlobStore.exists(sha256, tmpDir)).toBe(true)
  })

  it('checks the magic prefix across chunk boundaries', async () => {
    const res = await BlobStore.putStream(
      Readable.from([Buffer.from('%P'), Buffer.from('DF-1.5\n%%EOF')]),
      { storageDir: tmpDir, magic: '%PDF-', maxBytes: 1024 }
    )
    expect(res.sha256).toMatch(/^[0-9a-f]{64}$/)

    const err = await rejectionOf(
      BlobStore.putStream(
        Readable.from([Buffer.from('%P'), Buffer.from('XX-1.5')]),
        {
          storageDir: tmpDir,
          magic: '%PDF-',
        }
      )
    )
    expect(err.message).toMatch(/Magic header verification failed/)
    expect(await fs.promises.readdir(path.join(tmpDir, 'tmp'))).toEqual([])
  })

  it('does not let a leading empty chunk skip the magic check', async () => {
    const err = await rejectionOf(
      BlobStore.putStream(
        Readable.from([Buffer.alloc(0), Buffer.from('NOT_A_PDF')]),
        {
          storageDir: tmpDir,
          magic: '%PDF-',
        }
      )
    )
    expect(err.message).toMatch(/Magic header verification failed/)
  })

  it('rejects an empty stream when a magic prefix is required', async () => {
    const fromNothing = await rejectionOf(
      BlobStore.putStream(Readable.from([]), {
        storageDir: tmpDir,
        magic: '%PDF-',
      })
    )
    expect(fromNothing.message).toMatch(/empty or truncated/)

    const fromEmptyChunk = await rejectionOf(
      BlobStore.putStream(Readable.from([Buffer.alloc(0)]), {
        storageDir: tmpDir,
        magic: '%PDF-',
      })
    )
    expect(fromEmptyChunk.message).toMatch(/empty or truncated/)
  })

  it('returns reason "missing" for an absent blob', async () => {
    const res = await BlobStore.verify('a'.repeat(64), tmpDir)
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('missing')
  })

  it('returns reason "io_error" for an unreadable blob and leaves it in place', async () => {
    const { sha256 } = await BlobStore.putBuffer(PDF, {
      storageDir: tmpDir,
      magic: '%PDF-',
    })
    vi.spyOn(fs, 'createReadStream').mockImplementation(
      () =>
        new Readable({
          read() {
            const err = new Error('EIO: i/o error')
            err.code = 'EIO'
            this.destroy(err)
          },
        })
    )

    const res = await BlobStore.verify(sha256, tmpDir)

    expect(res.ok).toBe(false)
    expect(res.reason).toBe('io_error')
    expect(fs.existsSync(Paths.blobPath(tmpDir, sha256))).toBe(true)
    const quarantineDir = path.join(tmpDir, 'quarantine')
    expect(
      fs.existsSync(quarantineDir) ? fs.readdirSync(quarantineDir) : []
    ).toEqual([])
  })

  it('maps only ENOENT to "missing": other read errnos stay "io_error" (EACCES)', async () => {
    const { sha256 } = await BlobStore.putBuffer(PDF, {
      storageDir: tmpDir,
      magic: '%PDF-',
    })
    vi.spyOn(fs, 'createReadStream').mockImplementation(
      () =>
        new Readable({
          read() {
            const err = new Error('EACCES: permission denied')
            err.code = 'EACCES'
            this.destroy(err)
          },
        })
    )

    const res = await BlobStore.verify(sha256, tmpDir)

    expect(res.reason).toBe('io_error')
    expect(fs.existsSync(Paths.blobPath(tmpDir, sha256))).toBe(true)
  })

  it('returns reason "corrupt" only for a real hash mismatch and quarantines the blob', async () => {
    const { sha256 } = await BlobStore.putBuffer(PDF, {
      storageDir: tmpDir,
      magic: '%PDF-',
    })
    const blobFile = Paths.blobPath(tmpDir, sha256)
    await fs.promises.writeFile(blobFile, 'tampered-bytes')

    const res = await BlobStore.verify(sha256, tmpDir)

    expect(res.ok).toBe(false)
    expect(res.reason).toBe('corrupt')
    expect(res.expected).toBe(sha256)
    expect(res.actual).not.toBe(sha256)
    expect(fs.existsSync(blobFile)).toBe(false)
    expect(fs.existsSync(res.quarantinedPath)).toBe(true)
  })

  it('verify returns ok for an intact blob', async () => {
    const { sha256 } = await BlobStore.putBuffer(PDF, {
      storageDir: tmpDir,
      magic: '%PDF-',
    })
    expect(await BlobStore.verify(sha256, tmpDir)).toEqual({ ok: true })
  })

  it('commitFile EXDEV fallback copies to sibling temp file, fsyncs, and renames atomically', async () => {
    const sourceFile = path.join(tmpDir, 'source-file.bin')
    const content = Buffer.from('exdev-test-content-123', 'utf8')
    await fs.promises.writeFile(sourceFile, content)

    const events = []
    const realRename = fs.promises.rename
    const realCopyFile = fs.promises.copyFile
    const realFsync = fs.fsync

    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (from === sourceFile) {
        const err = new Error('EXDEV: cross-device link not permitted')
        err.code = 'EXDEV'
        throw err
      }
      events.push(`rename:${path.basename(from)}->${path.basename(to)}`)
      return realRename(from, to)
    })

    vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (from, to) => {
      events.push(`copy:${path.basename(from)}->${path.basename(to)}`)
      return realCopyFile(from, to)
    })

    vi.spyOn(fs, 'fsync').mockImplementation((fd, cb) => {
      events.push('fsync')
      return realFsync(fd, cb)
    })

    const result = await BlobStore.commitFile(sourceFile, {
      storageDir: tmpDir,
    })

    expect(events.some(e => e.startsWith('copy:source-file.bin->.tmp-'))).toBe(
      true
    )
    expect(events.some(e => e.startsWith('rename:.tmp-'))).toBe(true)
    expect(fs.existsSync(sourceFile)).toBe(false)
    expect(fs.existsSync(result.path)).toBe(true)
    expect(await fs.promises.readFile(result.path)).toEqual(content)
  })

  it('commitFile EXDEV fallback unlinks source when destination already exists (dedup)', async () => {
    const content = Buffer.from('exdev-dedup-content', 'utf8')
    const { path: existingPath, sha256 } = await BlobStore.putBuffer(content, {
      storageDir: tmpDir,
    })
    expect(fs.existsSync(existingPath)).toBe(true)

    const sourceFile = path.join(tmpDir, 'duplicate-file.bin')
    await fs.promises.writeFile(sourceFile, content)

    const realRename = fs.promises.rename
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (from === sourceFile) {
        const err = new Error('EXDEV: cross-device link not permitted')
        err.code = 'EXDEV'
        throw err
      }
      return realRename(from, to)
    })
    const copySpy = vi.spyOn(fs.promises, 'copyFile')

    const result = await BlobStore.commitFile(sourceFile, {
      storageDir: tmpDir,
    })

    expect(result.sha256).toBe(sha256)
    expect(copySpy).not.toHaveBeenCalled()
    expect(fs.existsSync(sourceFile)).toBe(false)
    expect(fs.existsSync(result.path)).toBe(true)
  })
})
