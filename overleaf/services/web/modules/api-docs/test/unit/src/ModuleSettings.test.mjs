import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('ModuleSettings', function () {
  const originalEnv = { ...process.env }
  let mockSettings

  beforeEach(function () {
    mockSettings = {}
    vi.resetModules()
    vi.doMock('@overleaf/settings', () => ({
      default: mockSettings,
      __esModule: true,
    }))
  })

  afterEach(function () {
    process.env = { ...originalEnv }
    vi.restoreAllMocks()
  })

  it('enables the feature when API_DOCS_ENABLED=true', async function () {
    process.env.API_DOCS_ENABLED = 'true'
    await import('../../../app/src/ModuleSettings.mjs')
    expect(mockSettings.enableApiDocs).to.equal(true)
  })

  it('disables the feature when API_DOCS_ENABLED is unset', async function () {
    delete process.env.API_DOCS_ENABLED
    await import('../../../app/src/ModuleSettings.mjs')
    expect(mockSettings.enableApiDocs).to.equal(false)
  })

  it('preserves an existing value instead of overwriting it', async function () {
    mockSettings.enableApiDocs = true
    process.env.API_DOCS_ENABLED = 'false'
    await import('../../../app/src/ModuleSettings.mjs')
    expect(mockSettings.enableApiDocs).to.equal(true)
  })
})
