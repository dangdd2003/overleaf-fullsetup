import os from 'node:os'
import fs from 'node:fs'
import Path from 'node:path'
import { Readable } from 'node:stream'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { isPublicAddress, validateAllowedHost, guardedLookup } from '../../../app/src/transport/GuardedHttps.mjs'
import Paths from '../../../app/src/storage/Paths.mjs'
import StorageHealth from '../../../app/src/storage/StorageHealth.mjs'
import BlobStore from '../../../app/src/storage/BlobStore.mjs'

describe('GuardedHttps SSRF & Host Allow-List Protection', () => {
  it('blocks loopback, RFC1918, link-local, CGNAT, multicast, and IPv6 local addresses', () => {
    for (const blockedIp of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.5.4',
      '192.168.1.10',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fe80::1',
      'fc00::1234',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPublicAddress(blockedIp)).toBe(false)
    }
  })

  it('allows public IPv4 and IPv6 addresses', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true)
    expect(isPublicAddress('1.1.1.1')).toBe(true)
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true)
  })

  it('validates allowed hosts and rejects unauthorized hosts, ports, and URL credentials', () => {
    expect(() => validateAllowedHost('https://www.overleaf.com/latex/templates')).not.toThrow()
    expect(() => validateAllowedHost('https://SK53GL4JLY-dsn.algolia.net/1/indexes/gallery-production/query')).not.toThrow()
    expect(() => validateAllowedHost('https://codeload.github.com/owner/repo/zip/refs/heads/main')).not.toThrow()

    expect(() => validateAllowedHost('https://evil.example.com/test')).toThrow()
    expect(() => validateAllowedHost('https://www.overleaf.com:8443/latex/templates')).toThrow()
    expect(() => validateAllowedHost('https://user:pass@www.overleaf.com/latex/templates')).toThrow()
  })

  it('guardedLookup rejects hostnames resolving to private IPs', async () => {
    await new Promise((resolve, reject) => {
      guardedLookup('localhost', {}, err => {
        try {
          expect(err).toBeTruthy()
          expect(err.code).toBe('EADDRBLOCKED')
          resolve()
        } catch (e) {
          reject(e)
        }
      })
    })
  })
})

describe('StorageHealth Mount Gate & Content-Addressed BlobStore', () => {
  let tmpDir

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(Path.join(os.tmpdir(), 'tg-blob-test-'))
  })

  afterEach(async () => {
    if (tmpDir) {
      await fs.promises.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('decodes mountinfo escapes and enforces dedicated mount vs acceptedParentMounts', () => {
    const mountinfo = [
      '36 25 0:31 / / rw,relatime - overlay overlay rw',
      '37 36 8:1 /data /var/lib/overleaf rw,relatime - ext4 /dev/sda1 rw',
      '38 37 8:2 /tg /var/lib/overleaf/data/template-gallery\\040test rw - ext4 /dev/sda2 rw',
    ].join('\n')

    const parsed = StorageHealth.parseMountinfo(mountinfo)
    expect(parsed).toContain('/var/lib/overleaf')
    expect(parsed).toContain('/var/lib/overleaf/data/template-gallery test')

    const denied = StorageHealth.checkMountPolicy(
      '/var/lib/overleaf/data/template-gallery',
      parsed,
      { requireDedicatedMount: true, acceptedParentMounts: [] }
    )
    expect(denied.ok).toBe(false)

    const acceptedParent = StorageHealth.checkMountPolicy(
      '/var/lib/overleaf/data/template-gallery',
      parsed,
      { requireDedicatedMount: false, acceptedParentMounts: ['/var/lib/overleaf'] }
    )
    expect(acceptedParent.ok).toBe(true)
  })

  it('enforces sha256 format and path containment in Paths', () => {
    expect(Paths.isValidSha256('a'.repeat(64))).toBe(true)
    expect(Paths.isValidSha256('xyz')).toBe(false)
    expect(() => Paths.blobPath(tmpDir, '../etc/passwd')).toThrow()
    expect(() => Paths.assertContained(tmpDir, '/etc/passwd')).toThrow()
  })

  it('stores, verifies, copies, and quarantines tampered blobs in BlobStore', async () => {
    const pdfBuf = Buffer.from('%PDF-1.5\nHello template preview PDF\n%%EOF', 'utf8')
    const res = await BlobStore.putBuffer(pdfBuf, {
      maxBytes: 1024 * 1024,
      magic: '%PDF-',
      storageDir: tmpDir,
    })
    expect(res.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(await BlobStore.exists(res.sha256, tmpDir)).toBe(true)

    const verifyOk = await BlobStore.verify(res.sha256, tmpDir)
    expect(verifyOk.ok).toBe(true)

    const scratchDest = Paths.scratchPath(tmpDir, undefined, '.pdf')
    await BlobStore.copyVerified(res.sha256, scratchDest, tmpDir)
    const copied = await fs.promises.readFile(scratchDest)
    expect(copied.equals(pdfBuf)).toBe(true)

    // Corrupt blob on disk and verify copyVerified quarantines it
    const blobFile = Paths.blobPath(tmpDir, res.sha256)
    await fs.promises.chmod(blobFile, 0o640)
    await fs.promises.writeFile(blobFile, 'corrupted-bytes')
    const scratchDest2 = Paths.scratchPath(tmpDir, undefined, '.pdf')
    let caughtErr = null
    try {
      await BlobStore.copyVerified(res.sha256, scratchDest2, tmpDir)
    } catch (err) {
      caughtErr = err
    }
    expect(caughtErr).toBeTruthy()
    expect(caughtErr.code).toBe('BLOB_INTEGRITY_ERROR')
    expect(await BlobStore.exists(res.sha256, tmpDir)).toBe(false)
  })

  it('rejects streams with invalid magic bytes or exceeding maxBytes', async () => {
    let magicErr = null
    try {
      await BlobStore.putStream(Readable.from([Buffer.from('NOT_A_PDF')]), {
        maxBytes: 1024,
        magic: '%PDF-',
        storageDir: tmpDir,
      })
    } catch (err) {
      magicErr = err
    }
    expect(magicErr).toBeTruthy()

    let sizeErr = null
    try {
      await BlobStore.putStream(Readable.from([Buffer.alloc(2048, 0x41)]), {
        maxBytes: 512,
        storageDir: tmpDir,
      })
    } catch (err) {
      sizeErr = err
    }
    expect(sizeErr).toBeTruthy()
    expect(sizeErr.code).toBe('BLOB_TOO_LARGE')
  })
})
