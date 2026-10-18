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

  it('sets default settings from environment variables', async function () {
    process.env.GOOGLE_DRIVE_ENABLED = 'true'
    process.env.GOOGLE_DRIVE_CLIENT_ID = 'test-client-id'
    process.env.GOOGLE_DRIVE_CLIENT_SECRET = 'test-client-secret'
    process.env.GOOGLE_DRIVE_TOKEN_ENCRYPTION_SECRET = 'test-token-secret'
    mockSettings.siteUrl = 'https://custom.site.com'

    const { default: googleDrive } = await import(
      '../../../app/src/ModuleSettings.mjs'
    )

    expect(mockSettings.enableGoogleDriveSync).to.equal(true)
    expect(mockSettings.googleDrive).to.deep.equal({
      clientId: 'test-client-id',
      tokenEncryptionSecret: 'test-token-secret',
      clientSecret: 'test-client-secret',
      redirectUri: 'https://custom.site.com/oauth/google-drive/callback',
      webhookUrl: 'https://custom.site.com/google-drive/webhook',
      maxRps: 8,
      pollIntervalSeconds: 300,
      outboundFlushSeconds: 600,
      folderName: 'Overleaf',
      outboundDebounceSeconds: 15,
      channelRenewIntervalSeconds: 3600,
      watchedUserPollRatio: 10,
      manualSyncCooldownSeconds: 60,
    })
    expect(googleDrive).to.equal(mockSettings.googleDrive)
  })

  it('uses default fallbacks when environment variables are not set', async function () {
    delete process.env.GOOGLE_DRIVE_ENABLED
    delete process.env.GOOGLE_DRIVE_CLIENT_ID
    delete process.env.GOOGLE_DRIVE_CLIENT_SECRET
    delete process.env.GOOGLE_DRIVE_TOKEN_ENCRYPTION_SECRET

    await import('../../../app/src/ModuleSettings.mjs')

    expect(mockSettings.enableGoogleDriveSync).to.equal(false)
    expect(mockSettings.googleDrive).to.deep.equal({
      clientId: '',
      tokenEncryptionSecret: '',
      clientSecret: '',
      redirectUri: 'http://localhost/oauth/google-drive/callback',
      webhookUrl: '',
      maxRps: 8,
      pollIntervalSeconds: 300,
      outboundFlushSeconds: 600,
      folderName: 'Overleaf',
      outboundDebounceSeconds: 15,
      channelRenewIntervalSeconds: 3600,
      watchedUserPollRatio: 10,
      manualSyncCooldownSeconds: 60,
    })
  })

  it('ignores the removed URL and legacy secret environment variables', async function () {
    process.env.GOOGLE_DRIVE_REDIRECT_URI = 'https://elsewhere.example.com/cb'
    process.env.GOOGLE_DRIVE_WEBHOOK_URL = 'https://elsewhere.example.com/hook'
    process.env.GOOGLE_DRIVE_TOKEN_SECRET = 'legacy-alias'
    mockSettings.siteUrl = 'http://overleaf.local'

    await import('../../../app/src/ModuleSettings.mjs')

    expect(mockSettings.googleDrive.redirectUri).to.equal(
      'http://overleaf.local/oauth/google-drive/callback'
    )
    expect(mockSettings.googleDrive.webhookUrl).to.equal('')
    expect(mockSettings.googleDrive.tokenEncryptionSecret).to.equal('')
  })

  it('reads the quota and sync timing settings, ignoring invalid values', async function () {
    process.env.GOOGLE_DRIVE_MAX_RPS = '10'
    process.env.GOOGLE_DRIVE_POLL_INTERVAL_SECONDS = '120'
    process.env.GOOGLE_DRIVE_OUTBOUND_FLUSH_SECONDS = 'soon'

    await import('../../../app/src/ModuleSettings.mjs')

    expect(mockSettings.googleDrive.maxRps).to.equal(10)
    expect(mockSettings.googleDrive.pollIntervalSeconds).to.equal(120)
    expect(mockSettings.googleDrive.outboundFlushSeconds).to.equal(600)
  })

  it('keeps other settings already defined and re-derives URLs from siteUrl', async function () {
    mockSettings.enableGoogleDriveSync = true
    mockSettings.siteUrl = 'https://overleaf.example.com'
    mockSettings.googleDrive = {
      manualSyncCooldownSeconds: 60,
      redirectUri: 'https://stale.example.com/oauth/google-drive/callback',
    }

    await import('../../../app/src/ModuleSettings.mjs')

    expect(mockSettings.enableGoogleDriveSync).to.equal(true)
    expect(mockSettings.googleDrive.manualSyncCooldownSeconds).to.equal(60)
    expect(mockSettings.googleDrive.redirectUri).to.equal(
      'https://overleaf.example.com/oauth/google-drive/callback'
    )
  })
})
