import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const ENV_KEYS = ['LEGAL_PAGE_ENABLED']

describe('ModuleSettings (legal)', function () {
  const savedEnv = {}
  let mockSettings

  beforeEach(function () {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    mockSettings = {}
    vi.resetModules()
    vi.doMock('@overleaf/settings', () => ({
      default: mockSettings,
      __esModule: true,
    }))
  })

  afterEach(function () {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = savedEnv[key]
      }
    }
    vi.restoreAllMocks()
  })

  describe('enableLegalPage', function () {
    it('is enabled when LEGAL_PAGE_ENABLED=true', async function () {
      process.env.LEGAL_PAGE_ENABLED = 'true'
      await import('../../../app/src/ModuleSettings.mjs')
      expect(mockSettings.enableLegalPage).to.equal(true)
    })

    it('defaults to false when LEGAL_PAGE_ENABLED is unset', async function () {
      await import('../../../app/src/ModuleSettings.mjs')
      expect(mockSettings.enableLegalPage).to.equal(false)
    })

    it('preserves an existing value instead of overwriting it', async function () {
      mockSettings.enableLegalPage = false
      process.env.LEGAL_PAGE_ENABLED = 'true'
      await import('../../../app/src/ModuleSettings.mjs')
      expect(mockSettings.enableLegalPage).to.equal(false)
    })
  })

  describe('nav settings', function () {
    it('leaves nav.left_footer untouched when enabled', async function () {
      process.env.LEGAL_PAGE_ENABLED = 'true'
      const existing = [{ text: 'From D-Dev with love!', url: 'https://dangdd.me' }]
      mockSettings.nav = { left_footer: [...existing] }
      await import('../../../app/src/ModuleSettings.mjs')
      expect(mockSettings.nav.left_footer).to.deep.equal(existing)
    })

    it('leaves nav.left_footer untouched when disabled', async function () {
      const existing = [{ text: 'From D-Dev with love!', url: 'https://dangdd.me' }]
      mockSettings.nav = { left_footer: [...existing] }
      await import('../../../app/src/ModuleSettings.mjs')
      expect(mockSettings.nav.left_footer).to.deep.equal(existing)
    })

    it('does not mutate or require nav', async function () {
      process.env.LEGAL_PAGE_ENABLED = 'true'
      await import('../../../app/src/ModuleSettings.mjs')
      expect(mockSettings.nav).to.be.undefined
    })
  })
})
