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
    process.env.GITHUB_SYNC_ENABLED = 'true'
    process.env.GITHUB_CLIENT_ID = 'test-client-id'
    process.env.GITHUB_CLIENT_SECRET = 'test-client-secret'
    process.env.GITHUB_REDIRECT_URI = 'https://custom.site.com/auth/github/callback'
    process.env.GITHUB_TOKEN_SECRET = 'test-token-secret'
    process.env.GITHUB_SYNC_REPOS_DIR = '/custom/repos/dir'
    process.env.GITHUB_API_BASE = 'https://custom.api.github.com'
    process.env.GITHUB_GIT_BASE = 'https://custom.github.com'

    const { default: githubSync } = await import(
      '../../../app/src/ModuleSettings.mjs'
    )

    expect(mockSettings.enableGithubSync).to.equal(true)
    expect(mockSettings.githubSync).to.deep.equal({
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      redirectUri: 'https://custom.site.com/auth/github/callback',
      tokenSecret: 'test-token-secret',
      reposDir: '/custom/repos/dir',
      apiBase: 'https://custom.api.github.com',
      gitBase: 'https://custom.github.com',
    })
    expect(mockSettings.githubSyncEncryptorOptions).to.deep.equal({
      cipherLabel: '2026.1-v3',
      cipherPasswords: {
        '2026.1-v3': 'test-token-secret',
      },
    })
    expect(githubSync).to.equal(mockSettings.githubSync)
  })

  it('uses default fallbacks when environment variables are not set', async function () {
    delete process.env.GITHUB_SYNC_ENABLED
    delete process.env.GITHUB_CLIENT_ID
    delete process.env.GITHUB_CLIENT_SECRET
    delete process.env.GITHUB_REDIRECT_URI
    delete process.env.GITHUB_TOKEN_SECRET
    delete process.env.GITHUB_SYNC_REPOS_DIR
    delete process.env.GITHUB_API_BASE
    delete process.env.GITHUB_GIT_BASE

    await import('../../../app/src/ModuleSettings.mjs')

    expect(mockSettings.enableGithubSync).to.equal(false)
    expect(mockSettings.githubSync).to.deep.equal({
      clientId: '',
      clientSecret: '',
      redirectUri: 'http://localhost/auth/github/callback',
      tokenSecret: '',
      reposDir: '/var/lib/overleaf/data/github-sync/repos',
      apiBase: 'https://api.github.com',
      gitBase: 'https://github.com',
    })
    expect(mockSettings.githubSyncEncryptorOptions).to.be.undefined
  })

  it('preserves existing settings if already defined', async function () {
    mockSettings.enableGithubSync = true
    mockSettings.githubSync = {
      clientId: 'existing-id',
      clientSecret: 'existing-secret',
      tokenSecret: '',
      reposDir: '/existing/repos',
      apiBase: 'https://api.github.com',
      gitBase: 'https://github.com',
    }
    mockSettings.githubSyncEncryptorOptions = { custom: true }

    await import('../../../app/src/ModuleSettings.mjs')

    expect(mockSettings.enableGithubSync).to.equal(true)
    expect(mockSettings.githubSync.clientId).to.equal('existing-id')
    expect(mockSettings.githubSyncEncryptorOptions).to.deep.equal({
      custom: true,
    })
  })
})
