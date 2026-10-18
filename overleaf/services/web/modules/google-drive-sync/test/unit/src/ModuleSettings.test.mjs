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
    process.env.GOOGLE_DRIVE_REDIRECT_URI =
      'https://custom.site.com/oauth/google-drive/callback'
    process.env.GOOGLE_DRIVE_TOKEN_ENCRYPTION_SECRET = 'test-token-secret'
    process.env.GOOGLE_DRIVE_WEBHOOK_URL = 'https://custom.site.com/webhook'
    process.env.GOOGLE_DRIVE_MAX_RPS = '10'
    process.env.GOOGLE_DRIVE_POLL_INTERVAL_SECONDS = '120'
    process.env.GOOGLE_DRIVE_OUTBOUND_FLUSH_SECONDS = '300'

    const { default: googleDrive } = await import(
      '../../../app/src/ModuleSettings.mjs'
    )

    expect(mockSettings.enableGoogleDriveSync).to.equal(true)
    expect(mockSettings.googleDrive).to.deep.equal({
      clientId: 'test-client-id',
      tokenEncryptionSecret: 'test-token-secret',
      clientSecret: 'test-client-secret',
      redirectUri: 'https://custom.site.com/oauth/google-drive/callback',
      webhookUrl: 'https://custom.site.com/webhook',
      maxRps: 10,
      pollIntervalSeconds: 120,
      outboundFlushSeconds: 300,
      folderName: 'Overleaf',
      outboundDebounceSeconds: 15,
      channelRenewIntervalSeconds: 3600,
      watchedUserPollRatio: 10,
    })
    expect(googleDrive).to.equal(mockSettings.googleDrive)
  })

  it('uses default fallbacks when environment variables are not set', async function () {
    delete process.env.GOOGLE_DRIVE_ENABLED
    delete process.env.GOOGLE_DRIVE_CLIENT_ID
    delete process.env.GOOGLE_DRIVE_CLIENT_SECRET
    delete process.env.GOOGLE_DRIVE_REDIRECT_URI
    delete process.env.GOOGLE_DRIVE_TOKEN_ENCRYPTION_SECRET
    delete process.env.GOOGLE_DRIVE_TOKEN_SECRET
    delete process.env.GOOGLE_DRIVE_WEBHOOK_URL
    delete process.env.GOOGLE_DRIVE_MAX_RPS
    delete process.env.GOOGLE_DRIVE_POLL_INTERVAL_SECONDS
    delete process.env.GOOGLE_DRIVE_OUTBOUND_FLUSH_SECONDS

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
    })
  })

  it('preserves existing settings if already defined', async function () {
    mockSettings.enableGoogleDriveSync = true
    mockSettings.googleDrive = {
      clientId: 'existing-id',
      clientSecret: 'existing-secret',
    }

    await import('../../../app/src/ModuleSettings.mjs')

    expect(mockSettings.enableGoogleDriveSync).to.equal(true)
    expect(mockSettings.googleDrive.clientId).to.equal('existing-id')
  })
})
