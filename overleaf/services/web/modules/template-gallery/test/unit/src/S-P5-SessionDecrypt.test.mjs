import os from 'node:os'
import fsp from 'node:fs/promises'
import Path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../../../../../app/src/infrastructure/RedisWrapper.mjs', () => ({
  default: {
    client: () => ({
      on: () => {},
      once: () => {},
      disconnect: async () => {},
      quit: async () => {},
      defineCommand: () => {},
    }),
    cleanupTestRedis: async () => {},
  },
}))

import { DEFAULTS } from '../../../app/src/TemplateGalleryDefaults.mjs'
import { mergePlain } from './support/mergePlain.mjs'
import { setCollectionOverrideForTests } from '../../../app/src/persistence/Collections.mjs'
import {
  encryptCookie,
  decryptCookie,
  getDecryptedSessionCredential,
} from '../../../app/src/crypto/SessionCredentialStore.mjs'
import { acquireViaCloudSession } from '../../../app/src/services/tiers/Tier1SessionAcquisition.mjs'
import TemplateSourceAcquisitionService from '../../../app/src/services/TemplateSourceAcquisitionService.mjs'
import BlobStore from '../../../app/src/storage/BlobStore.mjs'

// A cookie sealed under a secret that is no longer configured (SESSION_SECRET rotated).
const ROTATED_SECRET = 'rotated-away-session-secret-value-0001'
const MAIN_TEX = '\\documentclass{article}\\begin{document}Hello\\end{document}'

function undecryptableDoc() {
  return {
    _id: 'credentials',
    encryptedCookie: encryptCookie(
      'overleaf_session2=old-session',
      ROTATED_SECRET
    ),
    status: 'VALID',
    updatedAt: new Date('2025-12-01T00:00:00.000Z'),
  }
}

describe('S-P5 stored session cookie after a secret rotation', () => {
  let tmpDir
  let configCol
  let itemsCol

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(Path.join(os.tmpdir(), 'tg-p5-decrypt-'))
    configCol = {
      findOne: vi.fn(async () => undecryptableDoc()),
      updateOne: vi.fn(async () => ({ matchedCount: 1 })),
    }
    itemsCol = { updateOne: vi.fn(async () => ({ matchedCount: 1 })) }
    setCollectionOverrideForTests({
      templateGalleryConfig: configCol,
      templateGalleryItems: itemsCol,
    })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    setCollectionOverrideForTests(null)
    await fsp.rm(tmpDir, { recursive: true, force: true })
  })

  it('a cookie sealed under another secret does not decrypt with the current one', () => {
    const sealed = encryptCookie('overleaf_session2=abc', ROTATED_SECRET)
    expect(() => decryptCookie(sealed)).toThrow(/Failed to decrypt/)
  })

  it('decrypts a cookie sealed with the current secret', async () => {
    const doc = {
      _id: 'credentials',
      encryptedCookie: encryptCookie('overleaf_session2=ok'),
      status: 'VALID',
    }
    const credential = await getDecryptedSessionCredential({
      findOne: async () => doc,
      updateOne: vi.fn(),
    })
    expect(credential).toMatchObject({
      cookie: 'overleaf_session2=ok',
      encryptedCookie: doc.encryptedCookie,
      status: 'VALID',
    })
  })

  it('marks an undecryptable cookie INVALID and reads as absent instead of throwing', async () => {
    const doc = undecryptableDoc()
    const collection = {
      findOne: async () => doc,
      updateOne: vi.fn(async () => ({})),
    }

    const credential = await getDecryptedSessionCredential(collection)

    expect(credential).toBeNull()
    expect(collection.updateOne).toHaveBeenCalledTimes(1)
    expect(collection.updateOne).toHaveBeenCalledWith(
      { _id: 'credentials', encryptedCookie: doc.encryptedCookie },
      {
        $set: {
          status: 'INVALID',
          invalidatedAt: expect.any(Date),
          invalidReason: 'decrypt_failed',
        },
      }
    )
  })

  it('does not try to decrypt again once the cookie is INVALID', async () => {
    const doc = { ...undecryptableDoc(), status: 'INVALID' }
    const collection = { findOne: async () => doc, updateOne: vi.fn() }
    expect(await getDecryptedSessionCredential(collection)).toBeNull()
    expect(collection.updateOne).not.toHaveBeenCalled()
  })

  it('still returns null when marking the cookie fails', async () => {
    const collection = {
      findOne: async () => undecryptableDoc(),
      updateOne: vi.fn(async () => {
        throw new Error('mongo unavailable')
      }),
    }
    expect(await getDecryptedSessionCredential(collection)).toBeNull()
  })

  it('Tier 1 reports no usable cookie instead of throwing', async () => {
    const item = { _id: 'item-1', publishedId: 123, objectID: 456 }
    const result = await acquireViaCloudSession(item, DEFAULTS)
    expect(result).toEqual({ acquired: false, reason: 'no_session_cookie' })
    expect(configCol.updateOne).toHaveBeenCalledWith(
      { _id: 'credentials', encryptedCookie: expect.any(String) },
      {
        $set: expect.objectContaining({
          status: 'INVALID',
          invalidReason: 'decrypt_failed',
        }),
      }
    )
  })

  it('acquisition falls through to the next tier after the cookie is found unreadable', async () => {
    // the blob store is not written here; the commit itself is covered by its own tests
    vi.spyOn(BlobStore, 'commitFile').mockResolvedValue({
      sha256: 'd'.repeat(64),
      sizeBytes: 10,
    })
    const cfg = mergePlain(DEFAULTS, { storageDir: tmpDir })
    const item = {
      _id: 'item-2',
      publishedId: 123,
      objectID: 456,
      mainFile: 'main.tex',
      mainText: MAIN_TEX,
    }
    const result = await TemplateSourceAcquisitionService.acquire(item, { cfg })
    expect(result).toMatchObject({ acquired: true, tier: 3 })
    expect(configCol.updateOne).toHaveBeenCalled()
  })
})
