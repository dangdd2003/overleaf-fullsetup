import { describe, it, expect, beforeEach, vi } from 'vitest'

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

vi.mock(
  '../../../app/src/transport/GuardedHttps.mjs',
  async importOriginal => ({
    ...(await importOriginal()),
    requestRaw: vi.fn(),
  })
)

import { setCollectionOverrideForTests } from '../../../app/src/persistence/Collections.mjs'
import { requestRaw } from '../../../app/src/transport/GuardedHttps.mjs'
import {
  isTransientCode,
  isTransientError,
  TRANSIENT_ERROR_CODES,
} from '../../../app/src/transport/HostLimiter.mjs'
import { encryptCookie } from '../../../app/src/crypto/SessionCredentialStore.mjs'
import { acquireViaCloudSession } from '../../../app/src/services/tiers/Tier1SessionAcquisition.mjs'
import TemplateSourceAcquisitionService from '../../../app/src/services/TemplateSourceAcquisitionService.mjs'
import OpenService from '../../../app/src/services/OpenService.mjs'
import { errorFor } from '../../../app/src/controllers/OpenController.mjs'

describe('S-P6 Transient Transport Errors', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setCollectionOverrideForTests(null)
  })

  describe('isTransientCode and isTransientError', () => {
    it('recognizes all transient error codes', () => {
      for (const code of TRANSIENT_ERROR_CODES) {
        expect(isTransientCode(code)).toBe(true)
        expect(isTransientError({ code })).toBe(true)
      }
      expect(isTransientCode('host_busy')).toBe(true)
      expect(isTransientCode('host_task_timeout')).toBe(true)
      expect(isTransientCode('circuit_open')).toBe(true)
      expect(isTransientCode('EOUTBOUND_BLOCKED')).toBe(true)
      expect(isTransientCode('other_error')).toBe(false)
      expect(isTransientError(new Error('boom'))).toBe(false)
    })
  })

  describe('Tier1SessionAcquisition transient errors', () => {
    it('does not invalidate session credential on host_busy or circuit_open', async () => {
      let markInvalidCalled = false
      const fakeConfig = {
        findOne: async ({ _id }) => {
          if (_id === 'credentials') {
            return {
              _id: 'credentials',
              encryptedCookie: encryptCookie('sess=abc'),
              status: 'VALID',
            }
          }
          return null
        },
        updateOne: async () => {
          markInvalidCalled = true
        },
      }
      setCollectionOverrideForTests({
        templateGalleryConfig: fakeConfig,
      })

      const busyErr = new Error('host busy')
      busyErr.code = 'host_busy'
      requestRaw.mockRejectedValue(busyErr)

      const item = {
        token: 'abcdefghijkl',
        publishedId: 123,
        objectID: '456',
      }

      const res = await acquireViaCloudSession(item, {}, {})
      expect(res.acquired).toBe(false)
      expect(res.transient).toBe(true)
      expect(res.reason).toBe('upstream_busy')
      expect(res.code).toBe('host_busy')
      expect(markInvalidCalled).toBe(false)
    })
  })

  describe('TemplateSourceAcquisitionService transient errors', () => {
    it('does not write acquisitionBackoff on transient error when all tiers fail', async () => {
      let backoffWritten = false
      const fakeConfig = {
        findOne: async ({ _id }) => {
          if (_id === 'credentials') {
            return {
              _id: 'credentials',
              encryptedCookie: encryptCookie('sess=abc'),
              status: 'VALID',
            }
          }
          return null
        },
      }
      const fakeItems = {
        updateOne: async (filter, update) => {
          if (update?.$set?.acquisitionBackoff) {
            backoffWritten = true
          }
        },
      }
      setCollectionOverrideForTests({
        templateGalleryConfig: fakeConfig,
        templateGalleryItems: fakeItems,
      })

      const busyErr = new Error('host busy')
      busyErr.code = 'host_busy'
      requestRaw.mockRejectedValue(busyErr)

      const item = {
        _id: '507f1f77bcf86cd799439011',
        token: 'abcdefghijkl',
        publishedId: 123,
        objectID: '456',
        source: 'crawler',
      }

      const cfg = {
        sourceAcquisition: {
          tier1Enabled: true,
          tier3Enabled: false,
        },
      }

      const res = await TemplateSourceAcquisitionService.acquire(item, { cfg })
      expect(res.acquired).toBe(false)
      expect(res.transient).toBe(true)
      expect(res.reason).toBe('upstream_busy')
      expect(backoffWritten).toBe(false)
    })
  })

  describe('OpenService and OpenController error mapping', () => {
    it('OpenService openTemplate throws upstream_busy when acquisition is transient', async () => {
      const fakeConfig = {
        findOne: async ({ _id }) => {
          if (_id === 'credentials') {
            return {
              _id: 'credentials',
              encryptedCookie: encryptCookie('sess=abc'),
              status: 'VALID',
            }
          }
          return null
        },
      }
      const item = {
        _id: '507f1f77bcf86cd799439011',
        token: 'abcdefghijkl',
        state: 'published',
        publishedId: 123,
        objectID: '456',
      }
      const fakeItems = {
        findOne: async () => item,
      }
      setCollectionOverrideForTests({
        templateGalleryConfig: fakeConfig,
        templateGalleryItems: fakeItems,
      })

      const busyErr = new Error('host busy')
      busyErr.code = 'host_busy'
      requestRaw.mockRejectedValue(busyErr)

      const cfg = {
        sourceAcquisition: {
          tier1Enabled: true,
          tier3Enabled: false,
        },
      }

      let thrown = null
      try {
        await OpenService.openTemplate('abcdefghijkl', 'user-1', { cfg })
      } catch (err) {
        thrown = err
      }

      expect(thrown).not.toBeNull()
      expect(thrown.code).toBe('upstream_busy')
    })

    it('OpenController errorFor maps transient codes to 503 upstream_busy', () => {
      const codes = ['host_busy', 'host_task_timeout', 'circuit_open', 'EOUTBOUND_BLOCKED', 'upstream_busy']
      for (const code of codes) {
        const errInfo = errorFor(code)
        expect(errInfo.status).toBe(503)
        expect(errInfo.code).toBe('upstream_busy')
      }
    })
  })
})
