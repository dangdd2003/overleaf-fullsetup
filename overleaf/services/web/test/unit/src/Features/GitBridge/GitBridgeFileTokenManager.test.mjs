import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import Settings from '@overleaf/settings'
import GitBridgeFileTokenManager from '../../../../../app/src/Features/GitBridge/GitBridgeFileTokenManager.mjs'

describe('GitBridgeFileTokenManager', function () {
  const projectId = 'proj-123'
  const fileId = 'file-456'
  let origSecurity

  beforeEach(function () {
    origSecurity = Settings.security
    Settings.security = { sessionSecret: 'test-secret-12345' }
  })

  afterEach(function () {
    Settings.security = origSecurity
  })

  describe('createFileToken', function () {
    it('creates a valid signed file token', function () {
      const token = GitBridgeFileTokenManager.createFileToken(projectId, fileId)
      expect(typeof token).toBe('string')
      expect(token).toContain('.')
      const parts = token.split('.')
      expect(parts.length).toBe(2)
      const expiresAt = parseInt(parts[0], 10)
      expect(expiresAt).toBeGreaterThan(Date.now())
      expect(parts[1].length).toBeGreaterThan(0)
    })

    it('returns null if sessionSecret is not configured', function () {
      Settings.security = {}
      const token = GitBridgeFileTokenManager.createFileToken(projectId, fileId)
      expect(token).toBeNull()
    })

    it('returns null if projectId is missing', function () {
      const token = GitBridgeFileTokenManager.createFileToken(null, fileId)
      expect(token).toBeNull()
    })

    it('returns null if fileId is missing', function () {
      const token = GitBridgeFileTokenManager.createFileToken(projectId, null)
      expect(token).toBeNull()
    })

    it('respects custom ttlMs', function () {
      const before = Date.now()
      const token = GitBridgeFileTokenManager.createFileToken(
        projectId,
        fileId,
        10000
      )
      const parts = token.split('.')
      const expiresAt = parseInt(parts[0], 10)
      expect(expiresAt).toBeGreaterThan(before)
      expect(expiresAt).toBeGreaterThan(before + 9000)
    })
  })

  describe('verifyFileToken', function () {
    it('returns true for a valid token', function () {
      const token = GitBridgeFileTokenManager.createFileToken(projectId, fileId)
      const valid = GitBridgeFileTokenManager.verifyFileToken(
        token,
        projectId,
        fileId
      )
      expect(valid).toBe(true)
    })

    it('returns false for a token created with different projectId', function () {
      const token = GitBridgeFileTokenManager.createFileToken(
        'other-proj',
        fileId
      )
      const valid = GitBridgeFileTokenManager.verifyFileToken(
        token,
        projectId,
        fileId
      )
      expect(valid).toBe(false)
    })

    it('returns false for a token created with different fileId', function () {
      const token = GitBridgeFileTokenManager.createFileToken(
        projectId,
        'other-file'
      )
      const valid = GitBridgeFileTokenManager.verifyFileToken(
        token,
        projectId,
        fileId
      )
      expect(valid).toBe(false)
    })

    it('returns false for an expired token', function () {
      const token = GitBridgeFileTokenManager.createFileToken(
        projectId,
        fileId,
        -1000
      )
      const valid = GitBridgeFileTokenManager.verifyFileToken(
        token,
        projectId,
        fileId
      )
      expect(valid).toBe(false)
    })

    it('returns false for a tampered HMAC', function () {
      const token = GitBridgeFileTokenManager.createFileToken(projectId, fileId)
      const parts = token.split('.')
      parts[1] = 'tampered-signature-value-here'
      const valid = GitBridgeFileTokenManager.verifyFileToken(
        parts.join('.'),
        projectId,
        fileId
      )
      expect(valid).toBe(false)
    })

    it('returns false for malformed tokens', function () {
      expect(
        GitBridgeFileTokenManager.verifyFileToken('not-a-token', projectId, fileId)
      ).toBe(false)
      expect(
        GitBridgeFileTokenManager.verifyFileToken(
          'notanumber.signature',
          projectId,
          fileId
        )
      ).toBe(false)
      expect(
        GitBridgeFileTokenManager.verifyFileToken(
          '12345.67.signature',
          projectId,
          fileId
        )
      ).toBe(false)
      expect(
        GitBridgeFileTokenManager.verifyFileToken(
          ' 12345 .signature',
          projectId,
          fileId
        )
      ).toBe(false)
      expect(
        GitBridgeFileTokenManager.verifyFileToken(['token-array'], projectId, fileId)
      ).toBe(false)
      expect(
        GitBridgeFileTokenManager.verifyFileToken(null, projectId, fileId)
      ).toBe(false)
    })

    it('returns false if sessionSecret is not configured', function () {
      const token = GitBridgeFileTokenManager.createFileToken(projectId, fileId)
      Settings.security = {}
      const valid = GitBridgeFileTokenManager.verifyFileToken(
        token,
        projectId,
        fileId
      )
      expect(valid).toBe(false)
    })
  })
})
